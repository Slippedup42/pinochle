// Per-decision cost of the distilled evaluator (#115).
//
// The half of #115 that is not about win rate. The PWA targets an iPhone, and a
// bid decision that takes visible time is a regression however well it plays —
// so this measures the thing a player would feel: how long one call to
// `chooseBid` takes, under each policy, on positions taken from real auctions
// rather than invented ones (the cost depends on the hand and on how far the
// auction has run, so synthetic positions would be measuring the wrong thing).
//
// p95 rather than the mean, because the mean is the number that hides a stall.
//
// -- Why each situation is timed over repeats rather than once ---------------
//
// A bid decision costs single-digit microseconds. `performance.now()` in a
// browser is deliberately coarse — Chrome clamps it to 100us outside a
// cross-origin-isolated context — so a single call cannot be timed there at
// all: every sample would read 0 or 100us and the percentiles would be an
// artefact of the clamp. Timing a fixed number of repeats of the *same*
// situation and dividing keeps the measurement meaningful on both runtimes, and
// the resulting distribution is over situations, which is what "per-decision
// latency" is asking about. Node's timer is fine-grained enough to also report
// single-shot samples, which is where jitter would show up; the CLI prints both.

import { type AuctionContext, chooseBid } from '../engine/bidding'
import { MIN_BID_INCREMENT, type Card } from '../engine/card'
import type { PlayerIndex } from '../engine/trick'
import type { SkillLevel } from '../engine/skills'
import { type BidSituationSample, makeRng, playHeadlessGame } from './headlessGame'
import { DISTILLED_LEVEL, STATIC_LEVEL, installPolicies } from './abRun'
import { percentile } from './stats'

/** Collects auction positions by playing real games. Both seats run `level` so
 *  the positions are the ones that policy actually produces. */
export function collectSituations(count: number, level: SkillLevel, seed = 7): BidSituationSample[] {
  const collected: BidSituationSample[] = []
  const seedSource = makeRng(seed)
  const seatSkills = { 0: level, 1: level, 2: level, 3: level } as Record<PlayerIndex, SkillLevel>
  const realRandom = Math.random
  try {
    while (collected.length < count) {
      Math.random = makeRng(Math.floor(seedSource() * 2 ** 31))
      playHeadlessGame({
        seatSkills,
        dealSeed: Math.floor(seedSource() * 2 ** 31),
        collectBidSituations: collected,
      })
    }
  } finally {
    Math.random = realRandom
  }
  return collected.slice(0, count)
}

export interface LatencySummary {
  readonly label: string
  /** Positions measured. Zero means nothing was measured, and every field
   *  below is then `NaN` rather than a number — see `summarise`. */
  readonly samples: number
  /** Microseconds per decision. `NaN` when `samples` is 0. */
  readonly mean: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
}

/**
 * Statistics over one arm's per-decision costs.
 *
 * An empty sample reports `NaN`, not 0 (#293). Zero is a legitimate reading
 * here — a clock clamped coarser than the decision genuinely returns 0.00us —
 * so an unmeasured arm reporting 0 is not merely uninformative, it is
 * indistinguishable from a real measurement of a free decision. `NaN` is the
 * value that cannot be mistaken for one, and it fails every comparison a caller
 * might use to claim the model is affordable. That is the same service
 * `stats.ts` does by returning 1.0 from `binomialTwoSidedP` on zero trials: the
 * number handed back must not support a claim the data cannot.
 *
 * It returns rather than throws because an empty sample is reachable —
 * `benchPage.ts` takes its position count from a text input — and an instrument
 * asked to measure nothing has an honest answer available.
 */
function summarise(label: string, micros: number[]): LatencySummary {
  if (micros.length === 0) {
    return { label, samples: 0, mean: NaN, p50: NaN, p95: NaN, p99: NaN, max: NaN }
  }
  return {
    label,
    samples: micros.length,
    mean: micros.reduce((s, v) => s + v, 0) / micros.length,
    p50: percentile(micros, 0.5),
    p95: percentile(micros, 0.95),
    p99: percentile(micros, 0.99),
    max: micros.reduce((m, v) => Math.max(m, v), 0),
  }
}

function callOnce(s: BidSituationSample, level: SkillLevel): number {
  const decision = chooseBid(
    s.player,
    s.hand as readonly Card[],
    s.currentBid,
    MIN_BID_INCREMENT,
    s.context as AuctionContext,
    level,
  )
  return decision ?? 0
}

function timeRepeats(s: BidSituationSample, level: SkillLevel, repeats: number): number {
  const started = performance.now()
  let sink = 0
  for (let i = 0; i < repeats; i++) sink += callOnce(s, level)
  const micros = ((performance.now() - started) * 1000) / repeats
  return sink === Number.MIN_SAFE_INTEGER ? -1 : micros
}

/**
 * Per-situation cost in microseconds for both policies, amortised over
 * `repeats` calls each.
 *
 * The two are measured *interleaved*, alternating which of them goes first on
 * each situation. Measuring one policy to completion and then the other does
 * not work: an early attempt did exactly that and reported the static path as
 * slower than the distilled one, which is impossible — distilled is the static
 * path plus a second `bestBaseBid` and a dot product. Whatever produced that
 * (JIT warm-up carrying across the two loops, cache state, clock drift) is
 * removed by alternating, and the fact that the ordering could invert the sign
 * of the result is the reason this note exists.
 *
 * `sink` accumulates the returned bids so no engine can decide the work is dead
 * and remove it.
 */
export function measureAmortisedPair(
  situations: readonly BidSituationSample[],
  levels: readonly [SkillLevel, SkillLevel],
  repeats = 40,
): [number[], number[]] {
  const first: number[] = []
  const second: number[] = []
  situations.forEach((s, i) => {
    if (i % 2 === 0) {
      first.push(timeRepeats(s, levels[0], repeats))
      second.push(timeRepeats(s, levels[1], repeats))
    } else {
      second.push(timeRepeats(s, levels[1], repeats))
      first.push(timeRepeats(s, levels[0], repeats))
    }
  })
  return [first, second]
}

/** One timing per situation, both policies interleaved for the same reason
 *  `measureAmortisedPair` interleaves. Only meaningful where the clock is
 *  fine-grained (Node); in a browser the 100us clamp makes these useless, so
 *  the caller decides whether to ask for them. */
export function measureSingleShotPair(
  situations: readonly BidSituationSample[],
  levels: readonly [SkillLevel, SkillLevel],
): [number[], number[]] {
  return measureAmortisedPair(situations, levels, 1)
}

export interface LatencyReport {
  readonly amortised: readonly LatencySummary[]
  readonly singleShot: readonly LatencySummary[]
  /** Share of the collected positions where the two policies return a different
   *  bid. The upper bound on how much of any strength difference can be
   *  attributed to the evaluator: every other decision is made by the raise
   *  ladder and the 330/340 constants the model does not touch. */
  readonly disagreementRate: number
  readonly disagreements: number
  readonly decisions: number
}

/**
 * Warms both paths, then measures them interleaved so a drifting CPU clock
 * cannot favour whichever ran first.
 */
export function runLatencyBenchmark(situationCount = 3000, repeats = 40, includeSingleShot = true): LatencyReport {
  const restore = installPolicies()
  try {
    const situations = collectSituations(situationCount, STATIC_LEVEL)

    // Warm-up: let the JIT settle on both paths before anything is recorded.
    const warm = situations.slice(0, Math.min(500, situations.length))
    measureAmortisedPair(warm, [STATIC_LEVEL, DISTILLED_LEVEL], 20)
    measureAmortisedPair(warm, [DISTILLED_LEVEL, STATIC_LEVEL], 20)

    const [staticAmortised, distilledAmortised] = measureAmortisedPair(
      situations,
      [STATIC_LEVEL, DISTILLED_LEVEL],
      repeats,
    )

    let disagreements = 0
    for (const s of situations) {
      if (callOnce(s, STATIC_LEVEL) !== callOnce(s, DISTILLED_LEVEL)) disagreements++
    }

    return {
      amortised: [
        summarise('static', staticAmortised),
        summarise('distilled', distilledAmortised),
      ],
      singleShot: includeSingleShot
        ? (([s, d]) => [summarise('static', s), summarise('distilled', d)])(
            measureSingleShotPair(situations, [STATIC_LEVEL, DISTILLED_LEVEL]),
          )
        : [],
      disagreementRate: disagreements / Math.max(1, situations.length),
      disagreements,
      decisions: situations.length,
    }
  } finally {
    restore()
  }
}

/** An arm with nothing in it says so in words rather than printing a row of
 *  figures. The measured row is left exactly as it was: `samples` is either 0
 *  or the position count already in the header, so printing it on every row
 *  would add a column repeating the header for the sake of a case this line
 *  covers outright. */
export function formatLatency(report: LatencyReport): string {
  const row = (s: LatencySummary) =>
    s.samples === 0
      ? `    ${s.label.padEnd(11)}no positions measured`
      : `    ${s.label.padEnd(11)}mean ${s.mean.toFixed(2).padStart(7)}us   ` +
        `p50 ${s.p50.toFixed(2).padStart(7)}us   p95 ${s.p95.toFixed(2).padStart(7)}us   ` +
        `p99 ${s.p99.toFixed(2).padStart(7)}us   max ${s.max.toFixed(2).padStart(8)}us`
  const lines = [
    `Per-decision latency over ${report.decisions} real auction positions`,
    '',
    '  Amortised (each position timed over repeats — comparable across runtimes):',
    ...report.amortised.map(row),
  ]
  if (report.singleShot.length > 0) {
    lines.push('', '  Single-shot (one call per position — includes jitter; needs a fine-grained clock):', ...report.singleShot.map(row))
  }
  lines.push(
    '',
    `  Policies returned a different bid on ${report.disagreements}/${report.decisions} ` +
      `positions (${(report.disagreementRate * 100).toFixed(1)}%) — the ceiling on what the`,
    '  evaluator can be credited or blamed for; the rest is the untouched raise ladder.',
  )
  return lines.join('\n')
}

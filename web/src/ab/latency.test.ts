// The cost instrument's own correctness check (#235).
//
// `latency.ts` produced the per-decision figures in `web/README.md` — the p95
// that #115 weighed against the 600 ms the auction already waits before each AI
// bid — and nothing was checking it. An instrument nobody tests reports a
// plausible number whatever it does: a percentile taken off the wrong end, a
// loop that times something other than a bid decision, or a factor of 1000 in
// the wrong direction all print as a tidy `72.00us` and are believed. So what
// is under test here is whether the instrument reports *honestly*, not how fast
// the engine is.
//
// -- Why there is not one assertion about elapsed time -----------------------
//
// A test that asserts a decision took under N microseconds fails on a loaded
// runner and gets muted, and a muted test is worse than none — the cry-wolf
// failure #225's design notes describe, and the reason #170's file-count guard
// exists at all. Everything timed below runs against an *injected* clock:
// `performance.now` is replaced with a counter that only moves when the mocked
// `chooseBid` moves it, by an amount the test chose. That makes every reported
// microsecond figure a value this file computed, so the arithmetic — the
// millisecond-to-microsecond conversion, the division by the repeat count, the
// nearest-rank percentiles — is checkable exactly, and no assertion here can
// depend on how busy the machine is.
//
// -- Why `chooseBid` is mocked rather than spied -----------------------------
//
// `latency.ts` imports `chooseBid` as an ESM binding, which cannot be replaced
// in place by `vi.spyOn` the way `Math.random` and `Deck.prototype.deal` are
// elsewhere in this suite. The mock below is a *delegating* spy: it records the
// call, advances the fake clock, and returns what the real `chooseBid` returns.
// No AI decision changes, so the games `collectSituations` plays are the games
// it would have played, and "did the timing loop actually call the decision
// path" becomes a question with an answer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuctionContext } from '../engine/bidding'
import type { SkillLevel } from '../engine/skills'
import { DISTILLED_LEVEL, STATIC_LEVEL, installPolicies } from './abRun'
import {
  type LatencyReport,
  type LatencySummary,
  collectSituations,
  formatLatency,
  measureAmortisedPair,
  measureSingleShotPair,
  runLatencyBenchmark,
} from './latency'
import { percentile } from './stats'

interface RecordedCall {
  readonly context: AuctionContext | undefined
  readonly level: SkillLevel | undefined
}

/** Shared with the module mock below, which vitest hoists above the imports —
 *  hence `vi.hoisted`, so this object exists by the time the factory runs. */
const timing = vi.hoisted(() => ({
  clock: 0,
  calls: [] as RecordedCall[],
  /** Milliseconds the fake clock advances per bid decision. Tests replace it. */
  advanceMs: (_call: RecordedCall): number => 0,
}))

vi.mock('../engine/bidding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine/bidding')>()
  return {
    ...actual,
    chooseBid: (...args: Parameters<typeof actual.chooseBid>) => {
      const call: RecordedCall = { context: args[4], level: args[5] }
      timing.calls.push(call)
      timing.clock += timing.advanceMs(call)
      return actual.chooseBid(...args)
    },
  }
})

/** Positions to time. Collected once because it costs a headless game, and
 *  reset bookkeeping in `beforeEach` keeps the tests independent of it. */
const SITUATIONS = collectSituations(6, STATIC_LEVEL, 3)

let positionNumbers = new Map<AuctionContext, number>()

/** Assigns each position a number on first sight, so a per-call clock advance
 *  can vary by position. `collectSituations` calls `chooseBid` exactly once per
 *  position as it appends it and keeps the first `count` of them, so the
 *  positions a benchmark ends up measuring are numbered 1..count. */
function numberPositionsOnFirstSight(): void {
  positionNumbers = new Map()
  timing.advanceMs = (call) => {
    const context = call.context as AuctionContext
    if (!positionNumbers.has(context)) positionNumbers.set(context, positionNumbers.size + 1)
    return positionNumbers.get(context) as number
  }
}

beforeEach(() => {
  timing.calls = []
  timing.clock = 0
  timing.advanceMs = () => 0
  // Every microsecond figure asserted below is one this file put on the clock.
  vi.spyOn(performance, 'now').mockImplementation(() => timing.clock)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// -- The positions it measures ----------------------------------------------

describe('the collected auction positions', () => {
  it('returns as many positions as were asked for, playing as many games as that takes', () => {
    // 40 is more bid turns than one game holds, so this also covers the outer
    // loop: a benchmark asking for 3000 positions gets 3000, not one game's
    // worth padded out with whatever the last game happened to end on.
    expect(collectSituations(5, STATIC_LEVEL).length).toBe(5)
    expect(collectSituations(40, STATIC_LEVEL).length).toBe(40)
  })

  it('keeps the twelve-card hand the seat bid from, not the hand the game left behind', () => {
    // A collected position keeps a reference into the auction state, and the
    // game it came from runs to completion afterwards — through the 3-card
    // pass and twelve tricks. It survives that only because `auctionReducer`
    // and `playTrickTakingPhase` build new hands rather than emptying these
    // ones. If either ever mutated in place, the benchmark would go on timing
    // `chooseBid` against hands with cards missing (a cheaper call than the one
    // it claims to measure) and the report would still look entirely normal.
    for (const situation of collectSituations(12, STATIC_LEVEL)) {
      expect(situation.hand.length).toBe(12)
      expect(situation.player).toBeGreaterThanOrEqual(0)
      expect(situation.player).toBeLessThanOrEqual(3)
      expect(situation.currentBid).toBeGreaterThanOrEqual(0)
      expect(situation.context.bidHistory.length).toBeGreaterThanOrEqual(0)
    }
  })

  it('reproduces the same positions from the same seed and different ones from another', () => {
    // The seed is the whole reproducibility story for a published latency
    // figure: without this, a number in the README cannot be re-measured.
    const signature = (level: SkillLevel, seed: number) =>
      collectSituations(8, level, seed)
        .map((s) => `${s.player}/${s.currentBid}/${s.context.bidHistory.length}/${s.hand.join(',')}`)
        .join('|')
    expect(signature(STATIC_LEVEL, 7)).toBe(signature(STATIC_LEVEL, 7))
    expect(signature(STATIC_LEVEL, 7)).not.toBe(signature(STATIC_LEVEL, 8))
  })

  it('seats the level it was asked for, so the positions are the ones that policy produces', () => {
    const restore = installPolicies()
    try {
      timing.calls = []
      collectSituations(6, DISTILLED_LEVEL)
      expect(timing.calls.length).toBeGreaterThanOrEqual(6)
      expect(timing.calls.every((call) => call.level === DISTILLED_LEVEL)).toBe(true)
    } finally {
      restore()
    }
  })

  it('gives back the global Math.random it borrows to seed a game', () => {
    // It swaps `Math.random` out so anything in the game that reaches for it is
    // seeded too. A leak would leave every later test in the process — and
    // every later game in the same benchmark — running on a fixed sequence.
    const before = Math.random
    collectSituations(3, STATIC_LEVEL)
    expect(Math.random).toBe(before)
  })

  it('plays no game at all when asked for no positions', () => {
    expect(collectSituations(0, STATIC_LEVEL)).toEqual([])
    expect(timing.calls.length).toBe(0)
  })
})

// -- The timing loop ---------------------------------------------------------

describe('the timing loop', () => {
  it('runs the bid decision once per repeat for each policy, rather than timing an empty loop', () => {
    // The claim the whole instrument rests on. If the loop timed anything but
    // `chooseBid` — or optimised the body away — the report would still print.
    const situations = SITUATIONS.slice(0, 4)
    measureAmortisedPair(situations, [STATIC_LEVEL, DISTILLED_LEVEL], 5)
    expect(timing.calls.filter((call) => call.level === STATIC_LEVEL).length).toBe(4 * 5)
    expect(timing.calls.filter((call) => call.level === DISTILLED_LEVEL).length).toBe(4 * 5)
  })

  it('reports microseconds per decision, so a millisecond on the clock reads as 1000', () => {
    // The off-by-1000 an untested instrument invites: `performance.now` is in
    // milliseconds and every number the report prints is in microseconds.
    timing.advanceMs = (call) => (call.level === STATIC_LEVEL ? 1 : 2)
    const [staticArm, distilledArm] = measureAmortisedPair(
      SITUATIONS.slice(0, 3),
      [STATIC_LEVEL, DISTILLED_LEVEL],
      4,
    )
    expect(staticArm).toEqual([1000, 1000, 1000])
    expect(distilledArm).toEqual([2000, 2000, 2000])
  })

  it('divides by the repeat count, so amortising does not change the per-decision cost', () => {
    // Why the amortised and single-shot columns of the published report are
    // comparable at all: 40 repeats of a 1 ms decision is 1000us per decision,
    // not 40000us.
    timing.advanceMs = () => 1
    const situations = SITUATIONS.slice(0, 3)
    const once = measureSingleShotPair(situations, [STATIC_LEVEL, DISTILLED_LEVEL])
    const many = measureAmortisedPair(situations, [STATIC_LEVEL, DISTILLED_LEVEL], 40)
    expect(once).toEqual([[1000, 1000, 1000], [1000, 1000, 1000]])
    expect(many).toEqual(once)
  })

  it('keeps each policy in its own arm while alternating which one is timed first', () => {
    // The alternation is not decoration: `measureAmortisedPair`'s note records
    // that measuring one policy to completion and then the other reported the
    // static path as slower than the distilled one, which is impossible. If the
    // arms were ever written in measurement order instead of policy order, the
    // published comparison would have its sign decided by the order the loop
    // happened to run in.
    timing.advanceMs = (call) => (call.level === STATIC_LEVEL ? 1 : 2)
    const [staticArm, distilledArm] = measureAmortisedPair(
      SITUATIONS.slice(0, 4),
      [STATIC_LEVEL, DISTILLED_LEVEL],
      1,
    )
    expect(timing.calls.map((call) => call.level)).toEqual([
      STATIC_LEVEL,
      DISTILLED_LEVEL,
      DISTILLED_LEVEL,
      STATIC_LEVEL,
      STATIC_LEVEL,
      DISTILLED_LEVEL,
      DISTILLED_LEVEL,
      STATIC_LEVEL,
    ])
    expect(staticArm).toEqual([1000, 1000, 1000, 1000])
    expect(distilledArm).toEqual([2000, 2000, 2000, 2000])
  })

  it('measures nothing when there are no positions, rather than timing an empty pass', () => {
    expect(measureAmortisedPair([], [STATIC_LEVEL, DISTILLED_LEVEL], 10)).toEqual([[], []])
    expect(timing.calls.length).toBe(0)
  })
})

// -- The summary arithmetic --------------------------------------------------

describe('the benchmark report', () => {
  it('takes each percentile by nearest rank over the positions it measured', () => {
    // Position k costs exactly k microseconds per decision, so the sample is
    // 1..20 us and every statistic is arithmetic rather than empirical:
    // mean 10.5, p50 the 10th of 20, p95 the 19th, p99 and max the 20th.
    numberPositionsOnFirstSight()
    const report = runLatencyBenchmark(20, 3, true)
    const expected = Array.from({ length: 20 }, (_, i) => (i + 1) * 1000)

    expect(report.decisions).toBe(20)
    for (const summary of [...report.amortised, ...report.singleShot]) {
      expect(summary.samples).toBe(20)
      expect(summary.mean).toBe(10500)
      expect(summary.p50).toBe(10000)
      expect(summary.p95).toBe(19000)
      expect(summary.p99).toBe(20000)
      expect(summary.max).toBe(20000)
      // The report and `stats.percentile` must not drift apart: the published
      // p95 is only comparable to the A/B report's percentiles if both take
      // nearest rank, and only `percentile` is otherwise covered.
      expect(summary.p50).toBe(percentile(expected, 0.5))
      expect(summary.p95).toBe(percentile(expected, 0.95))
      expect(summary.p99).toBe(percentile(expected, 0.99))
    }
    // Sanity on the numbering itself: the sample above is 1..20 only because
    // the run collected at least that many distinct positions to number.
    expect(positionNumbers.size).toBeGreaterThanOrEqual(20)
  })

  it('labels the arms in policy order, static first', () => {
    const report = runLatencyBenchmark(6, 2, true)
    expect(report.amortised.map((s) => s.label)).toEqual(['static', 'distilled'])
    expect(report.singleShot.map((s) => s.label)).toEqual(['static', 'distilled'])
  })

  it('omits the single-shot arm when the caller does not ask for it', () => {
    // What the browser page does: a clock clamped to 100us would be measuring
    // the clamp, so `benchPage.ts` passes false and the section must vanish
    // rather than report zeros.
    const report = runLatencyBenchmark(6, 2, false)
    expect(report.singleShot).toEqual([])
    expect(report.amortised.length).toBe(2)
  })

  it('reports the disagreement rate as the share of positions the policies bid differently on', () => {
    // The ceiling on what the evaluator can be credited with, quoted in
    // `web/README.md` as 6.5%. The count is over real decisions, so the test
    // pins the arithmetic and the range rather than a particular value — and
    // deliberately not the sampling, which #294 has open: the positions come
    // from a table of four static bidders, so the rate is one-sided.
    const report = runLatencyBenchmark(12, 2, false)
    expect(report.decisions).toBe(12)
    expect(Number.isInteger(report.disagreements)).toBe(true)
    expect(report.disagreements).toBeGreaterThanOrEqual(0)
    expect(report.disagreements).toBeLessThanOrEqual(report.decisions)
    expect(report.disagreementRate).toBe(report.disagreements / report.decisions)
  })

  it('reports NaN rather than a measured zero when nothing was measured', () => {
    // The degenerate case an instrument must not paper over (#293). Zero is a
    // reading this module can legitimately produce — a clock clamped coarser
    // than the decision returns 0.00us — so an unmeasured arm reporting 0 is
    // not vague, it is wrong in the direction that flatters the model. NaN is
    // the value no caller can compare against a budget and pass.
    const report = runLatencyBenchmark(0, 2, true)
    expect(report.amortised.length + report.singleShot.length).toBe(4)
    for (const summary of [...report.amortised, ...report.singleShot]) {
      expect(summary.samples).toBe(0)
      for (const field of [summary.mean, summary.p50, summary.p95, summary.p99, summary.max]) {
        expect(Number.isNaN(field)).toBe(true)
      }
      // The comparison an affordability claim would be made with: 0 passes it
      // on no data, NaN cannot.
      expect(summary.p95 < 1000).toBe(false)
    }
    expect(report.decisions).toBe(0)
    // The rate stays a number, and unlike the microsecond fields it is printed
    // beside the 0/0 it came from, so the output discloses its own emptiness.
    expect(report.disagreementRate).toBe(0)
    expect(Number.isNaN(report.disagreementRate)).toBe(false)
  })

  it('keeps every field a number as soon as there is one position to measure', () => {
    // The other side of the guard: the empty branch must not leak into a run
    // that measured something, however little.
    numberPositionsOnFirstSight()
    const report = runLatencyBenchmark(1, 2, true)
    for (const summary of [...report.amortised, ...report.singleShot]) {
      expect(summary.samples).toBe(1)
      for (const field of [summary.mean, summary.p50, summary.p95, summary.p99, summary.max]) {
        expect(field).toBe(1000)
      }
    }
  })
})

// -- The rendered report -----------------------------------------------------

describe('the rendered report', () => {
  const summary = (label: string, mean: number, p95: number): LatencySummary => ({
    label,
    samples: 200,
    mean,
    p50: mean,
    p95,
    p99: p95,
    max: p95,
  })
  const report: LatencyReport = {
    amortised: [summary('static', 41.5, 62.25), summary('distilled', 55, 72)],
    singleShot: [summary('static', 44, 70), summary('distilled', 58, 88)],
    disagreementRate: 13 / 200,
    disagreements: 13,
    decisions: 200,
  }

  it('prints a row for each policy in both sections', () => {
    const lines = formatLatency(report).split('\n')
    expect(lines.filter((line) => line.includes('static')).length).toBe(2)
    expect(lines.filter((line) => line.includes('distilled')).length).toBe(2)
    expect(formatLatency(report)).toContain('Amortised')
    expect(formatLatency(report)).toContain('Single-shot')
  })

  it('prints the microsecond figures it was handed, to two decimals', () => {
    const text = formatLatency(report)
    expect(text).toContain('mean   41.50us')
    expect(text).toContain('p95   62.25us')
    expect(text).toContain('max    72.00us')
  })

  it('prints the disagreement count and its percentage', () => {
    // 13/200 is 6.5%, the figure `web/README.md` quotes; a rate printed as
    // 0.1% or 650% is the arithmetic this catches.
    expect(formatLatency(report)).toContain('different bid on 13/200 positions (6.5%)')
  })

  it('drops the single-shot section rather than printing an empty one', () => {
    const text = formatLatency({ ...report, singleShot: [] })
    expect(text).toContain('Amortised')
    expect(text).not.toContain('Single-shot')
  })

  it('says an empty arm measured nothing instead of printing a row of zeros', () => {
    // #293: the row a reader scans is the whole output for most of this
    // module's users, and `mean 0.00us   p50 0.00us   ...` is what a decision
    // costing nothing looks like. An arm that never ran must not be able to
    // wear that. It renders without throwing, because `benchPage.ts` takes its
    // position count from a text input and can ask for none.
    const text = formatLatency({
      amortised: [{ label: 'static', samples: 0, mean: NaN, p50: NaN, p95: NaN, p99: NaN, max: NaN }],
      singleShot: [],
      disagreementRate: 0,
      disagreements: 0,
      decisions: 0,
    })
    expect(text).toContain('over 0 real auction positions')
    const line = text.split('\n').find((l) => l.trimStart().startsWith('static')) as string
    expect(line).toBe('    static     no positions measured')
    expect(text).not.toContain('NaN')
  })

  it('still prints a measured zero as a figure, so the two cannot be confused', () => {
    // The reading the empty row is not allowed to imitate. A coarse clock can
    // genuinely report 0.00us per decision, and that is a measurement: it keeps
    // its numeric row, and the two renderings share no line.
    const measuredZero = formatLatency({
      amortised: [{ label: 'static', samples: 200, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 }],
      singleShot: [],
      disagreementRate: 0,
      disagreements: 0,
      decisions: 200,
    })
    expect(measuredZero).toContain('static     mean    0.00us')
    expect(measuredZero).not.toContain('no positions measured')
  })

  it('leaves a measured row byte-for-byte as it was', () => {
    // The empty case is worth nothing if it costs the populated rows their
    // legibility, so the format is pinned exactly rather than by substring.
    const line = formatLatency(report)
      .split('\n')
      .find((l) => l.trimStart().startsWith('static')) as string
    expect(line).toBe(
      '    static     mean   41.50us   p50   41.50us   p95   62.25us   p99   62.25us   max    62.25us',
    )
  })
})

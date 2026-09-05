// Paired A/B of the two bidding policies (#115), on the discipline
// `ab_harness.py` sets.
//
// Four properties, all of them load-bearing, all of them lifted from the Python
// harness rather than reinvented:
//
//   Identical deals. Both orientations of a pair derive every round's shuffle
//   from (deal seed, round index) alone, so the deal does not drift when one
//   policy consumes more random values while thinking. The deal is by far the
//   largest source of variance in Pinochle; holding it fixed removes most of it
//   for free, and is worth many times more than simply running more games.
//
//   Mirrored seats. Each deal is played twice, swapping which side sits in
//   seats 0&2. Seat 0 is dealt first and the dealer rotation starts from a
//   fixed seat, so any positional edge would otherwise read as a skill gap.
//
//   Significance over pairs, not games. The two games in a pair are the same
//   deal mirrored and so are strongly anti-correlated; treating them as
//   independent trials would roughly halve the standard error and manufacture
//   confidence. Split pairs carry no direction and are discarded, as in a sign
//   test, so `decisivePairs` is the real sample size.
//
//   An interval on score margin. Games-won is coarse — it discards *how* a game
//   was won — and with tightly paired configs most pairs split, leaving very few
//   decisive ones. This project has been burned by that specific null more than
//   once. Margin keeps the magnitude and usually resolves a real difference
//   long before games-won does.
//
// -- On how the two policies are selected -----------------------------------
//
// `chooseBid` takes a `SkillLevel` and reads `SKILL_PARAMS[skill]`, so the only
// way to have both policies live in one process — which a mirrored A/B needs,
// since both sit at the same table — is to run two skill levels that differ in
// `bidPolicy` and in nothing else. `installPolicies` therefore overwrites two
// entries of `SKILL_PARAMS` for the duration of a run and restores them after.
//
// This is not a shortcut around the gate in `skills.ts`; it is what makes the
// measurement independent of it. Both entries are written explicitly, so the
// harness reports the same numbers whether the shipped dial is gated off or
// switched on.
//
// Which is also why each map below writes out every field of `SkillParams`
// rather than spreading a shipped row: the discipline is that exactly one field
// differs across a map and the reader can check that by eye. `passing.ts` and
// `chooseTrump` branch on `handValuation` and `tracker.ts` on `playPolicy`, so
// in `BID_AB_POLICIES` — same `base_bid`, same `cascade` — the two sides play
// identical cards, pass identical cards and pick trump identically, and the
// only thing differing between them is which rule answers "is this hand worth a
// contract here".

import { SKILL_PARAMS, type SkillLevel, type SkillParams } from '../engine/skills'
import type { TeamId } from '../engine/round'
import type { PlayerIndex } from '../engine/trick'
import { type SideStats, makeRng, newSideStats, playHeadlessGame } from './headlessGame'
import { binomialTwoSidedP, bootstrapMeanCi, wilsonInterval } from './stats'

/** The two dial entries the harness commandeers. Both are `base_bid` levels, so
 *  overwriting them changes the one field under test and nothing else. */
export const STATIC_LEVEL: SkillLevel = 'hard'
export const DISTILLED_LEVEL: SkillLevel = 'expert'

/** Bidding A/B (#115): distilled vs static, both folding as the product does
 *  and both playing cards the same way. */
export const BID_AB_POLICIES: Record<string, SkillParams> = {
  [STATIC_LEVEL]: {
    handValuation: 'base_bid',
    bidPolicy: 'static',
    foldPolicy: 'model',
    playPolicy: 'cascade',
    autoSetPolicy: 'forced',
    safeCounterPolicy: 'counted',
  },
  [DISTILLED_LEVEL]: {
    handValuation: 'base_bid',
    bidPolicy: 'distilled',
    foldPolicy: 'model',
    playPolicy: 'cascade',
    autoSetPolicy: 'forced',
    safeCounterPolicy: 'counted',
  },
}

/**
 * Fold A/B (#123): identical bidders, one allowed to concede and one not.
 *
 * `foldPolicy` is uniform across the shipped dial by design, so there is no
 * pair of real skill levels that differ in it — which is exactly why the
 * override mechanism has to carry this comparison. Both sides bid `distilled`
 * here rather than `static`, so the measurement describes folding as it will
 * actually ship on `hard` and above.
 */
export const FOLD_AB_POLICIES: Record<string, SkillParams> = {
  [STATIC_LEVEL]: {
    handValuation: 'base_bid',
    bidPolicy: 'distilled',
    foldPolicy: 'never',
    playPolicy: 'cascade',
    autoSetPolicy: 'forced',
    safeCounterPolicy: 'counted',
  },
  [DISTILLED_LEVEL]: {
    handValuation: 'base_bid',
    bidPolicy: 'distilled',
    foldPolicy: 'model',
    playPolicy: 'cascade',
    autoSetPolicy: 'forced',
    safeCounterPolicy: 'counted',
  },
}

/**
 * Auto-SET A/B (#178): identical bidders, identical card play, both consulting
 * the same fold model — differing only in whether a contract the arithmetic
 * has already killed ends the round.
 *
 * `foldPolicy: 'model'` on **both** sides on purpose. The alternative, turning
 * folding off entirely, would measure auto-SET against a straw man that never
 * concedes anything, and this is a change landing on top of #123's shipped
 * behaviour, not instead of it. What this map asks is the question that
 * matters: with the fold model already running, what does forcing the
 * arithmetic add? Any hand `shouldConcede` was folding anyway contributes
 * nothing, so a small effect here is the honest reading and not a
 * disappointment — the `auto-set %` row in the summary is what says whether
 * the rule has anything to act on at all.
 *
 * As with `FOLD_AB_POLICIES`, side A (`DISTILLED_LEVEL`) is the arm under test.
 */
export const AUTO_SET_AB_POLICIES: Record<string, SkillParams> = {
  [STATIC_LEVEL]: {
    handValuation: 'base_bid',
    bidPolicy: 'distilled',
    foldPolicy: 'model',
    playPolicy: 'cascade',
    autoSetPolicy: 'off',
    safeCounterPolicy: 'counted',
  },
  [DISTILLED_LEVEL]: {
    handValuation: 'base_bid',
    bidPolicy: 'distilled',
    foldPolicy: 'model',
    playPolicy: 'cascade',
    autoSetPolicy: 'forced',
    safeCounterPolicy: 'counted',
  },
}

/**
 * Trick-play A/B (#153): identical bidders and identical folders, differing
 * only in which rule picks a card.
 *
 * This is the dial epic #152 was blocked on. Card play was the one phase of
 * this AI never measured — #105, #115, #123 and #126 are all bidding or
 * folding — so every heuristic in `tracker.ts` was there on reasoning alone,
 * and #154-#159 each proposed replacing one of them. None of that could be
 * judged without a way to sit two card-play rules at one table. All of those
 * children landed and the epic closed on 2026-08-02; the map outlived it.
 *
 * When this map was written both arms shipped: `'simple'` was what `easy`
 * played and `'cascade'` what every other level played. #156 acted on the
 * number — every level now plays `'cascade'` — so outside `tracker.test.ts`
 * this map is the **only** thing that selects `'simple'`, and deleting it
 * would take the arm with it: a one-member `PlayPolicy` union, and no baseline
 * left for a re-measurement that still asks for one. That re-measurement is
 * #270, whose scope names `playPolicy` and which has not run — it is what
 * keeps the arm now that the epic above is closed (#296). Load-bearing, not
 * leftover; `PlayPolicy` in `skills.ts` carries the full case, and
 * `CODING_STANDARDS.md`'s condition 4 is the one it turns on.
 *
 * Both sides bid `'distilled'` rather than `'static'` for the same reason
 * `FOLD_AB_POLICIES` does: it describes card play as it will actually ship on
 * `hard` and above. Note that side A is `DISTILLED_LEVEL` and therefore
 * `'cascade'`, matching the other two maps, where A is the arm under test.
 */
export const PLAY_AB_POLICIES: Record<string, SkillParams> = {
  [STATIC_LEVEL]: {
    handValuation: 'base_bid',
    bidPolicy: 'distilled',
    foldPolicy: 'model',
    playPolicy: 'simple',
    autoSetPolicy: 'forced',
    safeCounterPolicy: 'counted',
  },
  [DISTILLED_LEVEL]: {
    handValuation: 'base_bid',
    bidPolicy: 'distilled',
    foldPolicy: 'model',
    playPolicy: 'cascade',
    autoSetPolicy: 'forced',
    safeCounterPolicy: 'counted',
  },
}

/**
 * Safe-counter A/B (#158): identical bidders, identical folders, both running
 * the cascade, differing only in whether a seat forced to take a trick works out
 * which counter will actually hold.
 *
 * **This is the one A/B in the file where the *levels* matter and not just the
 * rows.** Everywhere else `installPolicies` writes both arms explicitly and the
 * level names are inert carriers. Here `TRUMP_MEMORY_CAPACITY` is keyed on the
 * level itself (`2 x skill`, #157) and is not part of `SkillParams`, so the
 * level chosen for the `'counted'` arm *is* the capacity being measured. That is
 * the mechanism, not a leak: the same `'counted'` rule at `easy` and at `expert`
 * is exactly the comparison #158 asks for.
 *
 * The `'off'` arm never touches a `TrumpMemory` — `chooseFollowCard` passes
 * `undefined` down when the policy is off — so its level is inert and its
 * behaviour is identical whichever level carries it. Which is what makes two
 * runs at different capacities comparable: both are measured against the *same*
 * baseline, on the same deals from the same seed, so the difference between the
 * two margins is attributable to the capacity and to nothing else.
 *
 * Both arms run `autoSetPolicy: 'forced'` (#178), because that is what ships and
 * because auto-SET decides *which deals reach trick play at all* — it ends
 * roughly one contract in fourteen before the first lead. Measuring a card-play
 * rule with it off would describe a population of hands the game no longer
 * deals. #158's original table was taken before #178 merged and was re-run
 * against it for exactly this reason; see `web/README.md`.
 *
 * @param countedLevel - Carries the arm under test; its capacity is what is
 *   being measured. `easy` = 2 trump remembered, `expert` = 10.
 * @param offLevel - Carries the baseline. Must differ from `countedLevel`.
 */
export function safeCounterAbPolicies(
  countedLevel: SkillLevel,
  offLevel: SkillLevel,
): Record<string, SkillParams> {
  if (countedLevel === offLevel) throw new Error('safe-counter A/B needs two distinct levels')
  return {
    [countedLevel]: {
      handValuation: 'base_bid',
      bidPolicy: 'distilled',
      foldPolicy: 'model',
      playPolicy: 'cascade',
      autoSetPolicy: 'forced',
      safeCounterPolicy: 'counted',
    },
    [offLevel]: {
      handValuation: 'base_bid',
      bidPolicy: 'distilled',
      foldPolicy: 'model',
      playPolicy: 'cascade',
      autoSetPolicy: 'forced',
      safeCounterPolicy: 'off',
    },
  }
}

/** The level the `'off'` baseline sits on for a given `'counted'` level. Any
 *  level would do — the baseline ignores capacity — so these are picked only to
 *  be distinct from the arm under test. */
export const SAFE_COUNTER_CONTROL: Record<SkillLevel, SkillLevel> = {
  easy: 'medium',
  medium: 'easy',
  hard: 'medium',
  proficient: 'medium',
  expert: 'proficient',
}

/**
 * Two `'counted'` seats at one table, differing in **nothing but the level they
 * sit on** — and therefore in nothing but how much trump each can remember
 * (#157's `2 x skill`, #158's consumer).
 *
 * The only map in this file where zero fields differ between the arms, and that
 * is the point rather than an oversight. Every other comparison here holds the
 * level inert and varies a rule; this one holds the rule fixed and varies the
 * level, which is the only way to ask the question epic #152 raised directly:
 * does remembering more trump actually win games, or does the skill dial just
 * describe itself? Running each capacity against the shared `'off'` baseline
 * answers it by subtraction; this answers it head-to-head, at one table, with
 * the mirroring cancelling the seat effect exactly as usual.
 *
 * Do not add this to the "exactly one field differs" invariant in `ab.test.ts`.
 * It would fail it, correctly.
 */
export function safeCounterCapacityPolicies(
  highLevel: SkillLevel,
  lowLevel: SkillLevel,
): Record<string, SkillParams> {
  if (highLevel === lowLevel) throw new Error('capacity A/B needs two distinct levels')
  const counted: SkillParams = {
    handValuation: 'base_bid',
    bidPolicy: 'distilled',
    foldPolicy: 'model',
    playPolicy: 'cascade',
    autoSetPolicy: 'forced',
    safeCounterPolicy: 'counted',
  }
  return { [highLevel]: counted, [lowLevel]: counted }
}

/** Overwrites the two entries in `policies`, returning a function that restores
 *  them. Callers must restore in a `finally` — a leaked override would silently
 *  change any later test in the same module registry. */
export function installPolicies(policies: Record<string, SkillParams> = BID_AB_POLICIES): () => void {
  const saved: Partial<Record<SkillLevel, SkillParams>> = {}
  for (const [level, params] of Object.entries(policies) as [SkillLevel, SkillParams][]) {
    saved[level] = SKILL_PARAMS[level]
    SKILL_PARAMS[level] = params
  }
  return () => {
    for (const level of Object.keys(policies) as SkillLevel[]) {
      SKILL_PARAMS[level] = saved[level] as SkillParams
    }
  }
}

export interface AbReport {
  readonly labelA: string
  readonly labelB: string
  readonly nPairs: number
  readonly winsA: number
  readonly winsB: number
  /** A's score margin in each game, in play order (two entries per pair). */
  readonly marginsA: readonly number[]
  /** +1 where A swept both orientations of a deal, -1 where B did, 0 on a split. */
  readonly pairResults: readonly number[]
  readonly statsA: SideStats
  readonly statsB: SideStats
  readonly elapsedMs: number
}

export interface AbAnalysis {
  readonly pairsA: number
  readonly pairsB: number
  readonly pairsSplit: number
  readonly decisivePairs: number
  readonly pValue: number
  readonly shareCi: readonly [number, number]
  /** A's average margin per deal, averaged across the deal's two orientations
   *  so any seat advantage cancels before it reaches the statistics. */
  readonly pairMargins: readonly number[]
  readonly marginMean: number
  readonly marginCi: readonly [number, number]
  readonly marginExcludesZero: boolean
}

export function analyse(report: AbReport, ciSeed = 0): AbAnalysis {
  const pairsA = report.pairResults.filter((r) => r > 0).length
  const pairsB = report.pairResults.filter((r) => r < 0).length
  const decisivePairs = pairsA + pairsB

  const pairMargins: number[] = []
  for (let i = 0; i + 1 < report.marginsA.length; i += 2) {
    pairMargins.push((report.marginsA[i] + report.marginsA[i + 1]) / 2)
  }
  const marginMean = pairMargins.length
    ? pairMargins.reduce((s, v) => s + v, 0) / pairMargins.length
    : 0
  const marginCi = bootstrapMeanCi(pairMargins, makeRng(ciSeed))

  return {
    pairsA,
    pairsB,
    pairsSplit: report.pairResults.filter((r) => r === 0).length,
    decisivePairs,
    pValue: binomialTwoSidedP(pairsA, decisivePairs),
    shareCi: wilsonInterval(pairsA, decisivePairs),
    pairMargins,
    marginMean,
    marginCi,
    marginExcludesZero: marginCi[0] > 0 || marginCi[1] < 0,
  }
}

export interface RunAbOptions {
  readonly nPairs: number
  readonly seed?: number
  readonly labelA?: string
  readonly labelB?: string
  /** Skill level for side A's two seats, and for side B's. Defaults to the
   *  distilled/static pair this issue exists to compare; passing the same level
   *  twice is the harness's own self-test. */
  readonly levelA?: SkillLevel
  readonly levelB?: SkillLevel
  /** Which pair of overrides to install for the run. Defaults to the bidding
   *  comparison; pass `FOLD_AB_POLICIES` for the fold one. */
  readonly policies?: Record<string, SkillParams>
}

/**
 * Plays `nPairs` deals, each twice with the seats mirrored. Total games is
 * `2 * nPairs`.
 *
 * `Math.random` is reseeded per pair and shared by both orientations. The AI
 * reaches for it in a few places (`meldOnlyBid`'s noise, `choosePassCards`'
 * fallback), and leaving those unseeded is exactly the irreproducibility
 * `ab_harness.py`'s docstring records having produced both "not significant"
 * and "significant" from one invocation.
 */
export function runAb(options: RunAbOptions): AbReport {
  const {
    nPairs,
    seed = 1,
    labelA = 'distilled',
    labelB = 'static',
    levelA = DISTILLED_LEVEL,
    levelB = STATIC_LEVEL,
    policies = BID_AB_POLICIES,
  } = options

  const restore = installPolicies(policies)
  const realRandom = Math.random
  const seedSource = makeRng(seed)
  const marginsA: number[] = []
  const pairResults: number[] = []
  const statsA = newSideStats()
  const statsB = newSideStats()
  let winsA = 0
  let winsB = 0
  const started = performance.now()

  try {
    for (let pair = 0; pair < nPairs; pair++) {
      const dealSeed = Math.floor(seedSource() * 2 ** 31)
      const playSeed = Math.floor(seedSource() * 2 ** 31)
      let pairWinsA = 0

      for (const aFirst of [true, false]) {
        // Both orientations share one player seed, so they differ only by
        // seating — the thing the mirroring exists to cancel.
        Math.random = makeRng(playSeed)

        const seatSkills = {
          0: aFirst ? levelA : levelB,
          1: aFirst ? levelB : levelA,
          2: aFirst ? levelA : levelB,
          3: aFirst ? levelB : levelA,
        } as Record<PlayerIndex, SkillLevel>

        // Seats 0&2 are team 0, so which team object is "A" flips with the
        // orientation — same bookkeeping as `run_ab`'s `team_a_obj`.
        const teamA: TeamId = aFirst ? 0 : 1
        const teamB: TeamId = aFirst ? 1 : 0
        const stats = { [teamA]: statsA, [teamB]: statsB } as Record<TeamId, SideStats>

        const result = playHeadlessGame({ seatSkills, dealSeed, stats })
        marginsA.push(result.scoresByTeam[teamA] - result.scoresByTeam[teamB])
        if (result.winner === teamA) {
          winsA++
          pairWinsA++
        } else {
          winsB++
        }
      }

      pairResults.push(pairWinsA === 2 ? 1 : pairWinsA === 0 ? -1 : 0)
    }
  } finally {
    Math.random = realRandom
    restore()
  }

  return {
    labelA,
    labelB,
    nPairs,
    winsA,
    winsB,
    marginsA,
    pairResults,
    statsA,
    statsB,
    elapsedMs: performance.now() - started,
  }
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const signed = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(0)}`
const rate = (n: number, d: number) => (d ? pct(n / d) : '—')
const avg = (xs: readonly number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0)

/** The Python harness's `summary()`, near enough line for line — including the
 *  refusal to print a bare win count without saying whether it means anything. */
export function summarise(report: AbReport, analysis = analyse(report)): string {
  const games = report.winsA + report.winsB
  const verdict =
    analysis.decisivePairs === 0
      ? 'NO EVIDENCE — every deal split, the two policies are indistinguishable here'
      : analysis.pValue < 0.05
        ? `SIGNIFICANT at p<0.05 — ${analysis.pairsA > analysis.pairsB ? report.labelA : report.labelB} is ahead`
        : 'NOT significant — this difference is consistent with chance'
  const marginVerdict =
    analysis.marginCi[0] > 0
      ? `CI excludes zero — ${report.labelA} really is ahead on margin`
      : analysis.marginCi[1] < 0
        ? `CI excludes zero — ${report.labelB} really is ahead on margin`
        : 'CI includes zero — no established difference in margin'

  return [
    `A/B: ${report.labelA} vs ${report.labelB}`,
    `  ${report.nPairs} deals x 2 seat orientations = ${games} games ` +
      `(${(report.elapsedMs / 1000).toFixed(1)}s, ${(report.elapsedMs / Math.max(1, games)).toFixed(0)} ms/game)`,
    '',
    '  Games (descriptive):',
    `    ${report.labelA}: ${report.winsA} (${rate(report.winsA, games)})   avg margin ${signed(avg(report.marginsA))}`,
    `    ${report.labelB}: ${report.winsB} (${rate(report.winsB, games)})   avg margin ${signed(-avg(report.marginsA))}`,
    '',
    '  Paired deals (inferential — split pairs carry no information):',
    `    ${report.labelA} swept ${analysis.pairsA},  ${report.labelB} swept ${analysis.pairsB},  split ${analysis.pairsSplit}`,
    `    95% CI on ${report.labelA}'s share of ${analysis.decisivePairs} decisive deals: ` +
      `${pct(analysis.shareCi[0])} – ${pct(analysis.shareCi[1])}`,
    `    two-sided exact binomial p = ${analysis.pValue.toFixed(4)}`,
    `    ${verdict}`,
    '',
    '  Paired score margin (more sensitive than games won):',
    `    ${report.labelA} avg margin per deal ${signed(analysis.marginMean)}   ` +
      `95% CI ${signed(analysis.marginCi[0])} to ${signed(analysis.marginCi[1])}`,
    `    ${marginVerdict}`,
    '',
    `  ${''.padEnd(18)}${report.labelA.padStart(12)}${report.labelB.padStart(12)}`,
    `  ${'contracts won'.padEnd(18)}${String(report.statsA.contracts).padStart(12)}${String(report.statsB.contracts).padStart(12)}`,
    `  ${'made'.padEnd(18)}${rate(report.statsA.made, report.statsA.contracts).padStart(12)}${rate(report.statsB.made, report.statsB.contracts).padStart(12)}`,
    `  ${'set'.padEnd(18)}${rate(report.statsA.set, report.statsA.contracts).padStart(12)}${rate(report.statsB.set, report.statsB.contracts).padStart(12)}`,
    // Conceded is a subset of set, not a third outcome — see `SideStats`. A
    // side that never folds reads 0% here, which is what makes the fold A/B
    // legible at a glance rather than only through the margin.
    `  ${'  of which folded'.padEnd(18)}${rate(report.statsA.conceded, report.statsA.contracts).padStart(12)}${rate(report.statsB.conceded, report.statsB.contracts).padStart(12)}`,
    // How often the auto-SET condition arose (#178) — counted on both arms
    // whatever their policy, so the two columns should read alike. This is the
    // number that says whether the rule has anything to act on; the margin
    // above cannot mean much if this is near zero.
    `  ${'  auto-set hands'.padEnd(18)}${rate(report.statsA.autoSet, report.statsA.contracts).padStart(12)}${rate(report.statsB.autoSet, report.statsB.contracts).padStart(12)}`,
    `  ${'avg bid'.padEnd(18)}${avg(report.statsA.bids).toFixed(0).padStart(12)}${avg(report.statsB.bids).toFixed(0).padStart(12)}`,
  ].join('\n')
}

// The measurement harness's own correctness check (#115).
//
// `ab_harness.py` ships a self-test for the same reason: a harness that reports
// a difference between two identical configurations is not making a discovery
// about the AI, it is describing a bug in itself — in seating, in deal
// assignment, or in bookkeeping. A conclusion drawn from an unchecked harness
// is worth nothing, and #115's conclusion flips a flag that changes every AI
// seat of the default game.
//
// Kept small deliberately. The full runs (hundreds of pairs) live behind
// `src/ab/cli.ts`; what belongs in the suite is the property that makes those
// runs meaningful, at the smallest size that demonstrates it.

import { describe, expect, it } from 'vitest'
import type { TeamId } from '../engine/round'
import { SKILL_PARAMS } from '../engine/skills'
import type { PlayerIndex } from '../engine/trick'
import type { SkillLevel } from '../persistence/options'
import {
  AUTO_SET_AB_POLICIES,
  BID_AB_POLICIES,
  DISTILLED_LEVEL,
  FOLD_AB_POLICIES,
  PLAY_AB_POLICIES,
  SAFE_COUNTER_CONTROL,
  STATIC_LEVEL,
  analyse,
  installPolicies,
  runAb,
  safeCounterAbPolicies,
} from './abRun'
import { type SideStats, makeRng, newSideStats, playHeadlessGame } from './headlessGame'
import { binomialTwoSidedP, bootstrapMeanCi, percentile, wilsonInterval } from './stats'

describe('the statistics', () => {
  it('reports no evidence rather than certainty when there are no trials', () => {
    // The value that stops a caller reading "no data" as "no difference".
    expect(binomialTwoSidedP(0, 0)).toBe(1)
    expect(wilsonInterval(0, 0)).toEqual([0, 1])
  })

  it('matches the exact binomial on cases small enough to check by hand', () => {
    // 1 head in 10 tosses: 2 * (C(10,0) + C(10,1)) / 2^10 = 22/1024.
    expect(binomialTwoSidedP(1, 10)).toBeCloseTo(22 / 1024, 12)
    // An even split is the most likely outcome, so every outcome counts in.
    expect(binomialTwoSidedP(5, 10)).toBeCloseTo(1, 12)
    // The size a real run reaches — well past where naive factorials overflow.
    expect(binomialTwoSidedP(211, 261)).toBeLessThan(1e-20)
  })

  it('keeps a Wilson interval inside [0, 1] at the extremes', () => {
    const [low, high] = wilsonInterval(20, 20)
    expect(low).toBeGreaterThan(0.8)
    expect(high).toBe(1)
  })

  it('brackets the mean with a bootstrap interval that excludes zero when the effect is real', () => {
    const noisyPositive = Array.from({ length: 200 }, (_, i) => 100 + ((i * 37) % 41) - 20)
    const [low, high] = bootstrapMeanCi(noisyPositive, makeRng(3))
    expect(low).toBeGreaterThan(0)
    expect(high).toBeLessThan(200)

    const centred = Array.from({ length: 200 }, (_, i) => ((i * 37) % 41) - 20)
    const [zeroLow, zeroHigh] = bootstrapMeanCi(centred, makeRng(3))
    expect(zeroLow).toBeLessThan(0)
    expect(zeroHigh).toBeGreaterThan(0)
  })

  it('takes p95 by nearest rank, so the reported number is one that occurred', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(values, 0.5)).toBe(50)
    expect(percentile(values, 0.95)).toBe(95)
    expect(percentile(values, 1)).toBe(100)
  })
})

describe('the policy override', () => {
  it('puts the two policies side by side and hands the dial back untouched', () => {
    // The A/B needs both policies live in one process, since both sit at the
    // same table. Restoring matters: a leaked override would quietly change
    // every later assertion about the shipped dial.
    const before = { ...SKILL_PARAMS }
    const restore = installPolicies()
    expect(SKILL_PARAMS[STATIC_LEVEL].bidPolicy).toBe('static')
    expect(SKILL_PARAMS[DISTILLED_LEVEL].bidPolicy).toBe('distilled')
    // Same hand valuation on both sides, so passing, trump choice and card play
    // are identical and bidding policy is the only thing under test.
    expect(SKILL_PARAMS[STATIC_LEVEL].handValuation).toBe('base_bid')
    expect(SKILL_PARAMS[DISTILLED_LEVEL].handValuation).toBe('base_bid')
    restore()
    expect(SKILL_PARAMS).toEqual(before)
  })

  it('varies exactly one field per policy map, so a result has one cause', () => {
    // The property every one of these maps is built on and none of them states
    // in code: two sides differing in two fields produce a number nothing can be
    // attributed to. Cheap to assert, and it is the assertion that keeps the
    // next map (#154 onward) honest as the union of policies grows.
    const safeCounter = safeCounterAbPolicies('expert', SAFE_COUNTER_CONTROL.expert)
    const maps = [BID_AB_POLICIES, FOLD_AB_POLICIES, AUTO_SET_AB_POLICIES, PLAY_AB_POLICIES, safeCounter]
    for (const policies of maps) {
      const [a, b] = Object.values(policies)
      const differing = (Object.keys(a) as (keyof typeof a)[]).filter((field) => a[field] !== b[field])
      expect(differing).toHaveLength(1)
    }
  })

  it('measures the safe-counter rule against a baseline that is the same at every level (#158)', () => {
    // #158's map is the one where the *levels* are not inert: capacity is
    // `2 x skill` and is keyed on the level, not on `SkillParams`, so the level
    // carrying the `'counted'` arm is the capacity under test. That only works
    // as a comparison if the other arm is unaffected by its own level — and it
    // is, because `'off'` never constructs or consults a `TrumpMemory`.
    //
    // Asserted structurally rather than by running games: whichever level the
    // baseline sits on, its row is identical. So two runs at different
    // capacities are measured against the same opponent and can be compared to
    // each other, which is the whole design of #158's measurement.
    const easyRun = safeCounterAbPolicies('easy', SAFE_COUNTER_CONTROL.easy)
    const expertRun = safeCounterAbPolicies('expert', SAFE_COUNTER_CONTROL.expert)
    expect(easyRun.easy.safeCounterPolicy).toBe('counted')
    expect(expertRun.expert.safeCounterPolicy).toBe('counted')
    expect(easyRun[SAFE_COUNTER_CONTROL.easy]).toEqual(expertRun[SAFE_COUNTER_CONTROL.expert])
    expect(easyRun[SAFE_COUNTER_CONTROL.easy].safeCounterPolicy).toBe('off')
  })

  it('refuses to run the safe-counter arms on one level, where they would overwrite each other', () => {
    expect(() => safeCounterAbPolicies('expert', 'expert')).toThrow()
  })

  it('ships #158 on at every level, and keeps the baseline reachable (#158)', () => {
    // `'counted'` measured positive at all five capacities (+3.3 at `easy`
    // through +8.7 at `expert` per deal; `web/README.md`), so it ships enabled
    // everywhere rather than as a difficulty notch — the rule is identical at
    // every level and only the recall behind it differs, which is #156's
    // settlement and #157's model, not an exception to either.
    //
    // The `'off'` arm survives for the reason `'simple'` and `'never'` do: it is
    // the baseline the number above is measured against, and nothing else
    // selects it.
    for (const params of Object.values(SKILL_PARAMS)) {
      expect(params.safeCounterPolicy).toBe('counted')
    }
    const map = safeCounterAbPolicies('expert', SAFE_COUNTER_CONTROL.expert)
    expect(map[SAFE_COUNTER_CONTROL.expert].safeCounterPolicy).toBe('off')
  })

  it('puts the two card-play rules at one table (#153)', () => {
    // What epic #152 is blocked on. Both arms already ship — `simple` is what
    // `easy` plays — so this map enables nothing; it only makes the comparison
    // reachable, which is a thing `SKILL_PARAMS` alone cannot do because
    // `chooseFollowCard` reads the level it is handed.
    const before = { ...SKILL_PARAMS }
    const restore = installPolicies(PLAY_AB_POLICIES)
    expect(SKILL_PARAMS[STATIC_LEVEL].playPolicy).toBe('simple')
    expect(SKILL_PARAMS[DISTILLED_LEVEL].playPolicy).toBe('cascade')
    restore()
    expect(SKILL_PARAMS).toEqual(before)
  })

  it('ships one card-play rule at every skill level (#156)', () => {
    // Replaces #153's invariant, which asserted `playPolicy` still tracked
    // `handValuation === 'meld_only'` exactly. That held while `playPolicy` was
    // a rename of the old card-play gate and existed to catch a level's card
    // play changing as an unmeasured side effect of the refactor. #156 is that
    // change, made deliberately and measured: `easy` moved to `'cascade'` while
    // keeping `meld_only` *bidding*, so the two fields are now decoupled by
    // intent and the old assertion would forbid the thing it was guarding.
    //
    // What replaces it is stronger. Trick play is not a difficulty setting —
    // a bad bid is invisible, a bad card is face up — so every row is
    // `'cascade'`, and a future row that is not has to come back through here.
    for (const params of Object.values(SKILL_PARAMS)) {
      expect(params.playPolicy).toBe('cascade')
    }
  })

  it("keeps 'simple' reachable as an A/B arm now that no level ships it", () => {
    // The other half of #156. `'simple'` is unreferenced by `SKILL_PARAMS` and
    // both `tracker.ts` branches are unreachable in a real game, which reads
    // exactly like dead code — but deleting it would leave `PlayPolicy` a
    // one-member union and strip epic #152 of the baseline every one of its
    // children is measured against. `PLAY_AB_POLICIES` is what keeps it alive,
    // and this asserts that it does.
    expect(PLAY_AB_POLICIES[STATIC_LEVEL].playPolicy).toBe('simple')
    expect(Object.values(SKILL_PARAMS).map((p) => p.playPolicy)).not.toContain('simple')
  })
})

describe('the headless game', () => {
  it('plays a full game to a result, with every seat an AI', () => {
    const seatSkills = { 0: 'hard', 1: 'hard', 2: 'hard', 3: 'hard' } as Record<PlayerIndex, SkillLevel>
    const result = playHeadlessGame({ seatSkills, dealSeed: 42 })
    expect([0, 1]).toContain(result.winner)
    expect(result.rounds).toBeGreaterThan(0)
    // One side has to have crossed a threshold for the game to have ended.
    const crossed = Math.max(result.scoresByTeam[0], result.scoresByTeam[1]) >= 1000
    const busted = Math.min(result.scoresByTeam[0], result.scoresByTeam[1]) <= -1000
    expect(crossed || busted).toBe(true)
  })

  it('reproduces a game exactly from its seed', () => {
    const seatSkills = { 0: 'hard', 1: 'hard', 2: 'hard', 3: 'hard' } as Record<PlayerIndex, SkillLevel>
    const a = playHeadlessGame({ seatSkills, dealSeed: 99 })
    const b = playHeadlessGame({ seatSkills, dealSeed: 99 })
    expect(b).toEqual(a)
  })

  // -- Conceding (#123) -----------------------------------------------------

  it('concedes contracts, and counts them as set rather than as a third outcome', () => {
    // Aggregated over seeds rather than pinned to one: roughly a fifth of
    // contracts are conceded, so a single ~6-round game has no fold at all
    // often enough (17 of 40 seeds) that a one-seed version of this test would
    // fail for reasons having nothing to do with the code.
    const seatSkills = { 0: 'hard', 1: 'hard', 2: 'hard', 3: 'hard' } as Record<PlayerIndex, SkillLevel>
    const stats = { 0: newSideStats(), 1: newSideStats() } as Record<TeamId, SideStats>
    for (let dealSeed = 1; dealSeed <= 12; dealSeed++) {
      playHeadlessGame({ seatSkills, dealSeed, stats })
    }

    const conceded = stats[0].conceded + stats[1].conceded
    expect(conceded).toBeGreaterThan(0)
    for (const team of [0, 1] as TeamId[]) {
      // A concede is a contract taken and not made. Both invariants would break
      // if the concede branch forgot its bookkeeping or double-counted.
      expect(stats[team].conceded).toBeLessThanOrEqual(stats[team].set)
      expect(stats[team].made + stats[team].set).toBe(stats[team].contracts)
      expect(stats[team].bids).toHaveLength(stats[team].contracts)
    }
  })

  it('never concedes when the dial says never, and folds strictly more often when it does', () => {
    // The comparison `foldPolicy` exists to make measurable. Same deal, same
    // seats, one field different — so any difference in concedes is the policy.
    const never = { 0: newSideStats(), 1: newSideStats() } as Record<TeamId, SideStats>
    const model = { 0: newSideStats(), 1: newSideStats() } as Record<TeamId, SideStats>

    const restore = installPolicies(FOLD_AB_POLICIES)
    try {
      const seats = (level: SkillLevel) =>
        ({ 0: level, 1: level, 2: level, 3: level }) as Record<PlayerIndex, SkillLevel>
      for (let dealSeed = 1; dealSeed <= 12; dealSeed++) {
        playHeadlessGame({ seatSkills: seats(STATIC_LEVEL), dealSeed, stats: never })
        playHeadlessGame({ seatSkills: seats(DISTILLED_LEVEL), dealSeed, stats: model })
      }
    } finally {
      restore()
    }

    // #178: auto-SET forces a concession whatever `foldPolicy` says, and both
    // arms of FOLD_AB_POLICIES run it, so the `never` arm no longer reads zero.
    // What it must read is *only* auto-sets — every concession it makes has to
    // be one the arithmetic forced, never one it chose.
    expect(never[0].conceded + never[1].conceded).toBe(never[0].autoSet + never[1].autoSet)
    expect(model[0].conceded + model[1].conceded).toBeGreaterThan(
      never[0].conceded + never[1].conceded,
    )
  })

  it('ends a dead contract without playing it, and plays it out when the rule is off', () => {
    // #178's dial. Same deals, same seats, same fold model on both sides — the
    // only difference is whether a contract the arithmetic has already killed
    // ends the round.
    const forced = { 0: newSideStats(), 1: newSideStats() } as Record<TeamId, SideStats>
    const off = { 0: newSideStats(), 1: newSideStats() } as Record<TeamId, SideStats>

    const restore = installPolicies(AUTO_SET_AB_POLICIES)
    try {
      const seats = (level: SkillLevel) =>
        ({ 0: level, 1: level, 2: level, 3: level }) as Record<PlayerIndex, SkillLevel>
      for (let dealSeed = 1; dealSeed <= 12; dealSeed++) {
        playHeadlessGame({ seatSkills: seats(DISTILLED_LEVEL), dealSeed, stats: forced })
        playHeadlessGame({ seatSkills: seats(STATIC_LEVEL), dealSeed, stats: off })
      }
    } finally {
      restore()
    }

    // The rule has something to act on at all — the premise of the measurement.
    expect(forced[0].autoSet + forced[1].autoSet).toBeGreaterThan(0)
    // The control counts the *condition* too, so it is not blind to it; it just
    // plays those hands out. Without this the enabled arm's firing rate would
    // have nothing to be checked against.
    expect(off[0].autoSet + off[1].autoSet).toBeGreaterThan(0)
    // An auto-set is always a concession, so on the enabled arm it can never
    // outnumber them.
    expect(forced[0].autoSet + forced[1].autoSet).toBeLessThanOrEqual(
      forced[0].conceded + forced[1].conceded,
    )
  })
})

describe('the A/B self-test', () => {
  // A configuration against itself. Any difference here is a harness bug, and
  // because the deal and the player seed are both pinned the expectation is
  // stronger than "not significant": with the same policy in all four seats the
  // two orientations of a deal are the same game with the sides relabelled, so
  // every pair must split and every *paired* margin must be exactly zero.
  //
  // Note it is the paired margin that must vanish, not the per-game one. Seat 3
  // deals the first round in both orientations, so one side holds the dealer in
  // one orientation and the other side holds it in the other — a real per-game
  // swing (the numbers below run to four figures) that averaging the pair
  // cancels. That is precisely the positional edge the mirroring exists to
  // remove, and seeing it cancel to zero here is the evidence that it does.
  //
  // Every arm of every dial is listed, not one representative: the check is
  // that *this policy* is deterministic and seat-symmetric, and a policy the
  // self-test never runs is a policy it cannot vouch for. Card play (#153) is
  // the one with the most room to fail it — a bid policy is asked once per
  // auction, `chooseFollowCard` tens of times per round, and it reads a
  // `PlayTracker` that accumulates state across the whole round.
  for (const [name, level, policies] of [
    ['static', STATIC_LEVEL, BID_AB_POLICIES],
    ['distilled', DISTILLED_LEVEL, BID_AB_POLICIES],
    ['simple', STATIC_LEVEL, PLAY_AB_POLICIES],
    ['cascade', DISTILLED_LEVEL, PLAY_AB_POLICIES],
    // #178's arm. The one that ends rounds early, and therefore the one with
    // the most scope to desynchronise dealer rotation or scoring between the
    // two orientations of a pair — exactly what a zero paired margin rules out.
    ['auto-set', DISTILLED_LEVEL, AUTO_SET_AB_POLICIES],
    // #158's two arms, both of which now play behind auto-SET.
    ['counted', 'expert', safeCounterAbPolicies('expert', SAFE_COUNTER_CONTROL.expert)],
    ['uncounted', SAFE_COUNTER_CONTROL.expert, safeCounterAbPolicies('expert', SAFE_COUNTER_CONTROL.expert)],
  ] as const) {
    it(`finds nothing when ${name} plays itself`, () => {
      const report = runAb({ nPairs: 6, seed: 5, levelA: level, levelB: level, policies })
      const analysis = analyse(report)
      expect(analysis.decisivePairs).toBe(0)
      expect(analysis.pairsSplit).toBe(6)
      expect(analysis.pairMargins.every((m) => m === 0)).toBe(true)
      expect(analysis.marginExcludesZero).toBe(false)
      // Per-game margins are non-trivial and exactly opposite — the seat effect
      // is present in each game and cancels across the pair.
      expect(report.marginsA.some((m) => m !== 0)).toBe(true)
      for (let i = 0; i + 1 < report.marginsA.length; i += 2) {
        expect(report.marginsA[i]).toBe(-report.marginsA[i + 1])
      }
      expect(report.statsA.contracts).toBe(report.statsB.contracts)
      expect(report.statsA.set).toBe(report.statsB.set)
    })
  }

  it('leaves Math.random as it found it', () => {
    // The run reseeds `Math.random` per pair, since the AI reaches for it in a
    // few places and an unseeded run is not reproducible. Not restoring it
    // would make every later test in the file deterministic by accident.
    const before = Math.random
    runAb({ nPairs: 1, seed: 1 })
    expect(Math.random).toBe(before)
  })
})

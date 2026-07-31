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
import { SKILL_PARAMS } from '../engine/skills'
import type { PlayerIndex } from '../engine/trick'
import type { SkillLevel } from '../persistence/options'
import { DISTILLED_LEVEL, STATIC_LEVEL, analyse, installPolicies, runAb } from './abRun'
import { makeRng, playHeadlessGame } from './headlessGame'
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
  for (const [name, level] of [
    ['static', STATIC_LEVEL],
    ['distilled', DISTILLED_LEVEL],
  ] as const) {
    it(`finds nothing when ${name} plays itself`, () => {
      const report = runAb({ nPairs: 6, seed: 5, levelA: level, levelB: level })
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

// Pins every A/B policy map in `abRun.ts` to the exact `SkillParams` it held
// when its run was recorded (#324).
//
// These maps are historical controls, not configuration. A recorded A/B result
// is only reproducible if both arms still resolve to what they were when it ran,
// so a field that quietly changes in one of them moves that run's baseline with
// nothing to show for it. `abRun.ts` builds the maps by spreading one frozen
// base; this file states the values independently, so a change to that base, or
// to any arm's override, fails here rather than in a re-run nobody compares.
//
// A new field on `SkillParams` lands here too, on purpose: adding it to the
// frozen base has to be a decision about what every historical control played,
// and this is where that decision becomes visible.

import { describe, expect, it } from 'vitest'
import type { SkillLevel, SkillParams } from '../engine/skills'
import {
  AUTO_SET_AB_POLICIES,
  BID_AB_POLICIES,
  FOLD_AB_POLICIES,
  OPENING_ANCHOR_AB_POLICIES,
  PLAY_AB_POLICIES,
  SAFE_COUNTER_CONTROL,
  safeCounterAbPolicies,
  safeCounterCapacityPolicies,
} from './abRun'

/** Every field written out, deliberately not imported from `abRun.ts`. */
const PRE_SHIP: SkillParams = {
  handValuation: 'base_bid',
  bidPolicy: 'distilled',
  foldPolicy: 'model',
  playPolicy: 'cascade',
  autoSetPolicy: 'forced',
  safeCounterPolicy: 'counted',
  openingAnchor: 'floor',
  partnerRead: 'current',
  sluffPolicy: 'shortest',
}

const LEVELS: SkillLevel[] = ['easy', 'medium', 'hard', 'proficient', 'expert']

describe('the frozen A/B controls (#324)', () => {
  it.each([
    ['BID_AB_POLICIES', BID_AB_POLICIES, { hard: { ...PRE_SHIP, bidPolicy: 'static' }, expert: PRE_SHIP }],
    ['FOLD_AB_POLICIES', FOLD_AB_POLICIES, { hard: { ...PRE_SHIP, foldPolicy: 'never' }, expert: PRE_SHIP }],
    ['AUTO_SET_AB_POLICIES', AUTO_SET_AB_POLICIES, { hard: { ...PRE_SHIP, autoSetPolicy: 'off' }, expert: PRE_SHIP }],
    ['PLAY_AB_POLICIES', PLAY_AB_POLICIES, { hard: { ...PRE_SHIP, playPolicy: 'simple' }, expert: PRE_SHIP }],
    [
      'OPENING_ANCHOR_AB_POLICIES',
      OPENING_ANCHOR_AB_POLICIES,
      { hard: PRE_SHIP, expert: { ...PRE_SHIP, openingAnchor: 'valuation' } },
    ],
  ] as const)('%s resolves to the values it was recorded with', (_name, policies, expected) => {
    expect(policies).toStrictEqual(expected)
  })

  it('safeCounterAbPolicies resolves to the recorded values for every level pair', () => {
    for (const counted of LEVELS) {
      for (const off of LEVELS) {
        if (counted === off) continue
        expect(safeCounterAbPolicies(counted, off)).toStrictEqual({
          [counted]: PRE_SHIP,
          [off]: { ...PRE_SHIP, safeCounterPolicy: 'off' },
        })
      }
    }
    // The control table the CLI actually seats, spelled out for the record.
    for (const level of LEVELS) {
      expect(safeCounterAbPolicies(level, SAFE_COUNTER_CONTROL[level])[level]).toStrictEqual(PRE_SHIP)
    }
  })

  it('safeCounterCapacityPolicies seats the recorded counted row at both levels', () => {
    for (const high of LEVELS) {
      for (const low of LEVELS) {
        if (high === low) continue
        expect(safeCounterCapacityPolicies(high, low)).toStrictEqual({ [high]: PRE_SHIP, [low]: PRE_SHIP })
      }
    }
  })
})

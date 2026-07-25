import type { SkillLevel } from '../persistence/options'

/** Ported from Python's GENERAL_STRATEGY_SKILL_PARAMS (pinochle_engine.py:1917).
 *  Controls which hand-valuation formula the AI uses in bidding. */
export type HandValuation = 'meld_only' | 'base_bid'

export interface SkillParams {
  readonly handValuation: HandValuation
}

export const SKILL_PARAMS: Record<SkillLevel, SkillParams> = {
  easy: { handValuation: 'meld_only' },
  medium: { handValuation: 'base_bid' },
  hard: { handValuation: 'base_bid' },
  proficient: { handValuation: 'base_bid' },
  expert: { handValuation: 'base_bid' },
}

/** Flat trick-point estimate for meld-only bidding (skill 1), matching
 *  Python's `MELD_ONLY_TRICK_ESTIMATE` / `EASY_FLAT_TRICK_ESTIMATE`. */
export const MELD_ONLY_TRICK_ESTIMATE = 60

/** Uniform noise range +/- for meld-only bidding ceiling. */
export const MELD_ONLY_BID_NOISE = 30

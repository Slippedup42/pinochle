import type { SkillLevel } from '../persistence/options'

/** Ported from Python's GENERAL_STRATEGY_SKILL_PARAMS (pinochle_engine.py:1917).
 *  Controls which hand-valuation formula the AI uses in bidding. */
export type HandValuation = 'meld_only' | 'base_bid'

/**
 * Which rule decides "is this hand worth a contract at this level" (#114).
 *
 *   `'static'`    the hand-tuned constants — `OPENER_THRESHOLD`,
 *                 `DEFENSIVE_PUSH_FLOOR` — that shipped before epic #104.
 *   `'distilled'` the evaluator fitted to 2000 measured rollout decisions
 *                 (`evaluator.ts`), which reads the bid level, the auction
 *                 state and the hand's shape rather than one number against
 *                 one threshold.
 *
 * This is the same dial `GeneralStrategy` uses in Python, where the parameter
 * being spent is rollout budget: `choose_forward_pass_cards` already takes a
 * `rollout_evaluator` callback that is `None` for the static levels.
 */
export type BidPolicy = 'static' | 'distilled'

export interface SkillParams {
  readonly handValuation: HandValuation
  readonly bidPolicy: BidPolicy
}

/**
 * The dial.
 *
 * Every level is currently `'static'`. The distilled evaluator is fully wired,
 * exported and parity-tested against Python (180/180 fixture hands exact) — it
 * is simply not switched on for anyone yet, because #115 has not measured
 * whether it plays better. Same discipline as the rest of epic #106: #101 and
 * #102 both shipped with their wiring live and their flag off after measuring
 * no benefit, and #103 was only enabled once an A/B justified it.
 *
 * This matters more here than in the Python engine, because pushing to `main`
 * deploys to GitHub Pages and `DEFAULT_OPTIONS` sets both `opponentSkill` and
 * `teammateSkill` to `hard`. Enabling the model on `hard` would therefore
 * change every seat of the default game the moment it merged. Measured over
 * 2000 simulated auctions that is not a subtle change: the settled contract
 * averages 323.6 rather than 335.4, and the share of hands settling at exactly
 * 300 goes from 3% to 36%, because the model usually declines the defensive
 * push `DEFENSIVE_PUSH_FLOOR` mandates. That may well be an improvement — but
 * "may well be" is exactly what #115 exists to settle.
 *
 * Two notes for whoever flips these:
 *
 *   easy should stay 'static' regardless. Its bidding never reaches the Base
 *   Bid path (`handValuation: 'meld_only'` short-circuits into `meldOnlyBid`),
 *   and the evaluator distils *skill 5* — wiring it in would not make easy
 *   better-calibrated, it would make easy the strongest bidder in the game and
 *   delete the tier.
 *
 *   proficient and expert are reserved for real rollouts "where affordable"
 *   per epic #104 (Web Worker, or desktop), which is separate work. Until that
 *   exists they run the pre-#104 constants.
 */
export const SKILL_PARAMS: Record<SkillLevel, SkillParams> = {
  easy: { handValuation: 'meld_only', bidPolicy: 'static' },
  medium: { handValuation: 'base_bid', bidPolicy: 'static' },
  hard: { handValuation: 'base_bid', bidPolicy: 'static' },
  proficient: { handValuation: 'base_bid', bidPolicy: 'static' },
  expert: { handValuation: 'base_bid', bidPolicy: 'static' },
}

/** Flat trick-point estimate for meld-only bidding (skill 1), matching
 *  Python's `MELD_ONLY_TRICK_ESTIMATE` / `EASY_FLAT_TRICK_ESTIMATE`. Survives
 *  #114: it belongs to `meldOnlyBid`, the deliberately-weak skill-1 path the
 *  evaluator does not replace (see `SKILL_PARAMS` above). */
export const MELD_ONLY_TRICK_ESTIMATE = 60

/** Uniform noise range +/- for meld-only bidding ceiling. */
export const MELD_ONLY_BID_NOISE = 30

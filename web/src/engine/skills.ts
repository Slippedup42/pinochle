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
 * The dial. `bidPolicy` follows epic #104's mapping — skills 1-3 get the
 * fitted evaluator, skills 4-5 are reserved for real rollouts "where
 * affordable" — with one deliberate exception and one consequence worth
 * stating outright:
 *
 *   easy is 'static' even though it is skill 1. Its bidding never reaches the
 *   Base Bid path at all (`handValuation: 'meld_only'` short-circuits into
 *   `meldOnlyBid`), and the evaluator is a distillation of *skill 5*. Wiring it
 *   in here would not make easy better-calibrated, it would make easy the
 *   strongest bidder in the game and delete the tier.
 *
 *   proficient and expert stay 'static' because the web port has no rollouts to
 *   fall back on yet — epic #104 reserves 4-5 for real ones, in a Web Worker or
 *   on desktop, and that is a separate piece of work. Until then they run the
 *   pre-#104 constants. That is an inversion (hard bids with the fitted model,
 *   expert with the guessed constants) and it is temporary on purpose: #115's
 *   A/B needs both policies reachable from the dial to measure one against the
 *   other, and it is #115's result that decides where the line finally sits.
 */
export const SKILL_PARAMS: Record<SkillLevel, SkillParams> = {
  easy: { handValuation: 'meld_only', bidPolicy: 'static' },
  medium: { handValuation: 'base_bid', bidPolicy: 'distilled' },
  hard: { handValuation: 'base_bid', bidPolicy: 'distilled' },
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

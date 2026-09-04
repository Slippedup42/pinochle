// The distilled rollout evaluator (#114, epic #104) — the cheap stand-in for
// the Monte Carlo AI that cannot run in a browser.
//
// Epic #104's problem statement: 150 samples x a full 12-trick playout x each
// candidate bid x 4 trump suits, on an iPhone, inside a React render loop, is
// not viable. So the expensive thinking was done offline — #112 recorded what
// the skill-5 rollout AI decided in 2000 real decision points, #113 fitted two
// small logistic models to those decisions, and `export_evaluator.py` wrote the
// weights into `evaluatorModel.ts`. This module is the consumer: it turns a
// hand and a table state into the feature vector those models were fitted on,
// and reports the decision. Cost is a dozen arithmetic ops on top of the
// `bestBaseBid` call `bidding.ts` was already making.
//
// The whole risk lives in feature extraction, not in the arithmetic. Every
// number below has to mean exactly what the identically-named column meant in
// `generate_rollout_dataset.py`/`fit_evaluator.py`, or the weights are being
// applied to quantities they were never fitted against — and nothing about that
// failure looks like a failure, it just plays slightly wrong forever.
// `evaluatorParity.test.ts` exists for that reason, and `base_bid_ceiling` is
// the feature it watches hardest: it is not a stored dataset column but a
// re-derivation of Python's `compute_max_bid`/`capped_bid`, worth eight points
// of decision agreement on its own (78.4% -> 86.3%), and its port has already
// slipped once (#118).
//
// On the import cycle with `bidding.ts`. This module needs `bestBaseBid`, and
// `bidding.ts` needs the decisions here, so the two import each other. That is
// safe rather than merely tolerated: neither module calls across the cycle at
// module-evaluation time, only from inside function bodies, so whichever is
// loaded first finishes initialising before any cross-call happens. The
// alternative — hoisting the Base Bid valuation into a third module — would
// move 250 lines that nothing else in this change touches.

import { bestBaseBid, computeMaxBid } from './bidding'
import { type Card, type Suit, SUITS } from './card'
import { BID_MODEL, FOLD_MODEL, type LogisticModelData } from './evaluatorModel'
import { scoreMelds } from './melds'

/** Features by name, matching `LogisticModelData.features`. Keyed by name
 *  rather than positional so a reordered export cannot pair a weight with the
 *  wrong number — a mismatch throws instead of scoring nonsense. */
export type FeatureVector = Readonly<Record<string, number>>

// -- Scoring a fitted model -------------------------------------------------

/**
 * `sum(weight * feature) + intercept`, in raw feature units.
 *
 * Throws on a missing or non-finite feature rather than treating it as zero.
 * Zero is a real value for most of these columns (`score_diff`, `has_run`,
 * `bidding_meld`), so a silent default would be indistinguishable from a
 * genuine measurement and would produce a plausible-looking wrong decision —
 * exactly the failure mode this whole module is trying not to have.
 */
export function modelLogit(model: LogisticModelData, features: FeatureVector): number {
  let total = model.intercept
  for (let i = 0; i < model.features.length; i++) {
    const name = model.features[i]
    const value = features[name]
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(`evaluator: feature '${name}' missing from the vector for this model`)
    }
    total += model.weights[i] * value
  }
  return total
}

// Mirrors `fit_evaluator._sigmoid`, clamp included. The clamp cannot change a
// decision (it never crosses zero), but matching it keeps the *probabilities*
// identical too, so a parity failure can be read off the probability rather
// than only off the flipped verdict.
const LOGIT_CLAMP = 30

export function modelProbability(model: LogisticModelData, features: FeatureVector): number {
  const z = Math.max(-LOGIT_CLAMP, Math.min(LOGIT_CLAMP, modelLogit(model, features)))
  return 1 / (1 + Math.exp(-z))
}

/** The model's 0/1 answer. See `LogisticModelData.decision` for which is which. */
export function modelDecision(model: LogisticModelData, features: FeatureVector): boolean {
  return modelProbability(model, features) >= model.threshold
}

// -- Hand shape — the seven columns both models share -----------------------
//
// Ported from `generate_rollout_dataset.extract_features`. The presence flags
// read `scoreMelds`' breakdown keys rather than re-counting cards, for the
// reason that function's docstring gives: "has a run" then means exactly what
// the scoring rules mean by it (doubles included, since a double replaces the
// single rather than stacking) instead of a second, subtly different definition
// drifting alongside the first.

function handShapeFeatures(hand: readonly Card[], trump: Suit): Record<string, number> {
  const { total: meldTotal, breakdown } = scoreMelds(hand, trump)
  const names = Object.keys(breakdown)
  const suitLength = (suit: Suit) => hand.reduce((n, c) => n + (c.suit === suit ? 1 : 0), 0)

  return {
    meld_total: meldTotal,
    ace_count: hand.reduce((n, c) => n + (c.rank === 'A' ? 1 : 0), 0),
    trump_length: suitLength(trump),
    longest_side_suit: Math.max(...SUITS.filter((s) => s !== trump).map(suitLength)),
    has_run: names.includes('Run') || names.includes('Double Run') ? 1 : 0,
    has_pinochle: names.includes('Pinochle') || names.includes('Double Pinochle') ? 1 : 0,
    has_around: names.some((name) => name.includes('Around')) ? 1 : 0,
  }
}

// -- The bid decision -------------------------------------------------------

/** One "should I take this contract" question, as the auction poses it. */
export interface BidSituation {
  readonly hand: readonly Card[]
  /** The level under consideration — the bid this seat would actually place,
   *  not the standing bid. `ceiling_minus_bid` is measured against it. */
  readonly bid: number
  readonly ourScore: number
  readonly theirScore: number
  readonly partnerHasBid: boolean
  readonly partnerHasPassed: boolean
}

export interface Evaluation {
  /** True means the decision the model's `decision` string describes. */
  readonly decision: boolean
  readonly probability: number
  readonly logit: number
  readonly features: FeatureVector
  /** `base_bid_ceiling` — surfaced because it is the feature parity turns on. */
  readonly ceiling: number
  readonly trump: Suit
}

/**
 * The full bid feature vector, plus the trump and ceiling it was built from.
 *
 * Trump and ceiling come from one `bestBaseBid` call at the *live* score,
 * matching how the labels were made: `label_bid_situation` picks trump with
 * `best_base_bid(hand, our_score, their_score)` and `fit_evaluator.bid_features`
 * then values that named suit at the same scores. So the score reaches the bid
 * model twice — once as `score_diff` and once through the competitive
 * adjustment inside the ceiling — and both were present at fit time.
 *
 * `bestBaseBid` returns the ceiling of its winning suit, which is by
 * construction `compute_max_bid(hand, argmax_trump, ...)` — nothing clamps it
 * since #283 — i.e. exactly Python's `base_bid_ceiling` at that trump.
 */
export function evaluateBid(situation: BidSituation): Evaluation {
  const { trump, total: ceiling } = bestBaseBid(situation.hand, situation.ourScore, situation.theirScore)
  const features: Record<string, number> = {
    ...handShapeFeatures(situation.hand, trump),
    bid: situation.bid,
    score_diff: situation.ourScore - situation.theirScore,
    partner_has_bid: situation.partnerHasBid ? 1 : 0,
    partner_has_passed: situation.partnerHasPassed ? 1 : 0,
    base_bid_ceiling: ceiling,
    ceiling_minus_bid: ceiling - situation.bid,
  }
  return {
    decision: modelDecision(BID_MODEL, features),
    probability: modelProbability(BID_MODEL, features),
    logit: modelLogit(BID_MODEL, features),
    features,
    ceiling,
    trump,
  }
}

/** True when the evaluator says taking the contract at `bid` beats defending it. */
export function shouldBid(situation: BidSituation): boolean {
  return evaluateBid(situation).decision
}

// -- The concede decision ---------------------------------------------------
//
// No caller yet: in the web port only the human can concede (#83, the fold
// button in TrickPlayFlow), so no AI seat reaches this question. It is exported
// anyway because the artefact carries both models and half an export is a trap
// — whoever wires an AI concede should find a parity-tested function here
// rather than a weight vector and a guess about which score to use.

/** One "should we concede this contract" question, post-pass with melds shown. */
export interface FoldSituation {
  readonly hand: readonly Card[]
  /** The declared trump — named, not searched. By the fold point the contract
   *  exists, and re-searching would value a suit nobody is playing. */
  readonly trump: Suit
  readonly bid: number
  readonly biddingMeld: number
  readonly defendingMeld: number
}

/**
 * The full fold feature vector.
 *
 * The ceiling here is computed at 0/0, NOT at the live score, and the game
 * score is not a feature at all. `should_fold` was measured with the scores
 * withheld while `use_win_probability` is off, so the label is mathematically
 * independent of the score; feeding one in through the competitive adjustment
 * would be scoring against a coefficient that was never fitted. Passing the
 * live score here would be the single easiest way to silently break this model.
 */
export function evaluateFold(situation: FoldSituation): Evaluation {
  const { hand, trump } = situation
  const ceiling = computeMaxBid(hand, trump, 0, 0).total
  const features: Record<string, number> = {
    ...handShapeFeatures(hand, trump),
    bid: situation.bid,
    bidding_meld: situation.biddingMeld,
    defending_meld: situation.defendingMeld,
    base_bid_ceiling: ceiling,
    ceiling_minus_bid: ceiling - situation.bid,
    tricks_needed: situation.bid - situation.biddingMeld,
    fold_cost: situation.bid + situation.defendingMeld,
  }
  return {
    decision: modelDecision(FOLD_MODEL, features),
    probability: modelProbability(FOLD_MODEL, features),
    logit: modelLogit(FOLD_MODEL, features),
    features,
    ceiling,
    trump,
  }
}

/** True when the evaluator says conceding beats playing the contract out. */
export function shouldConcede(situation: FoldSituation): boolean {
  return evaluateFold(situation).decision
}

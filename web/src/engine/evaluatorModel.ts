// GENERATED FILE — do not edit by hand.
//
// Produced by `export_evaluator.py` (issue #114) from `rollout_evaluator.json`, which
// `fit_evaluator.py` and `generate_rollout_dataset.py` write (issues #113, #112).
// Re-run the exporter after any refit; `test_export_evaluator.py` fails the Python
// suite if this file has drifted from the model it claims to carry.

// The distilled bidding AI, as data.
//
// Epic #104's shipped AI was three guessed constants (`OPENER_THRESHOLD = 320`,
// `DEFENSIVE_PUSH_FLOOR = 200`, `MELD_ONLY_TRICK_ESTIMATE = 60`). These weights
// replace the first two with numbers fitted to what a 150-sample Monte Carlo
// rollout actually decided in 2000 real decision points.
//
// Two models, and they are NOT interchangeable. `BID_MODEL` answers "does taking
// this contract beat defending it", from a 12-card hand with both melds unknown
// and an auction still running. `FOLD_MODEL` answers "does playing this contract
// out beat conceding it", from a different 12-card hand — post-pass, both melds
// face up, auction over. They are fitted on disjoint row sets with different
// feature lists; feeding one the other's features is meaningless, not merely
// inaccurate.
//
// Weights are in RAW feature units. The decision is
// `sum(weight[i] * feature[i]) + intercept >= 0` (equivalently
// `sigmoid(...) >= threshold`) with no scaling step to reproduce — the
// standardisation `fit_evaluator.py` fits under is unwound before export
// precisely so this file needs no companion mean/stddev vector.

// Provenance, copied from the artefact so a reader of this file can tell what
// configuration the weights describe without opening the Python side. A model
// fitted against a strategy flag that has since flipped is worse than no model.
//
// GeneralStrategy skill 5, as configured in pinochle_engine.py:
//   hand_valuation       rollout_ev
//   bid_samples          50
//   defence_samples      20
//   fold_samples         50
//   use_auction_evidence False
//   use_win_probability  False
//   live bid path        choose_bid_vs_defence (bid_ev_differential vs defend_ev, 20 samples)
//   live fold path       should_fold (score differential)
export const MODEL_PROVENANCE = {
  formatVersion: 1,
  issue: '113',
  dataset: 'rollout_dataset.csv',
  datasetRows: 2000,
  generatedBy: 'fit_evaluator.py',
} as const

// A fitted linear-in-log-odds classifier. `features` is the order `weights` is
// in; the evaluator looks features up by name rather than by index so a
// reordered export can never silently pair a weight with the wrong number.
export interface LogisticModelData {
  /** What a 1 means. Spelled out because 'bid' and 'concede' are opposite polarities. */
  readonly decision: string
  /** Probability at or above which the answer is 1. Carried explicitly rather than
   *  assumed to be 0.5, so false bids can be traded against false passes without a refit. */
  readonly threshold: number
  readonly intercept: number
  readonly features: readonly string[]
  readonly weights: readonly number[]
}

// Held-out decision agreement with the rollout: 82.6% over 419 rows,
// against a majority-verdict baseline of 52.3%; mean regret 11.2 points per decision.
// Disagreements with the rollout sit on near-boundary rows — 0% of them where
// the rollout's own EV margin exceeds 200 — so they cost points rather than
// describing a hand class the model gets wrong every time.
export const BID_MODEL: LogisticModelData = {
  decision: '1 = bid (taking the contract beats defending it)',
  threshold: 0.5,
  intercept: -1.7880291285585528,
  features: [
    'meld_total',
    'ace_count',
    'trump_length',
    'longest_side_suit',
    'has_run',
    'has_pinochle',
    'has_around',
    'bid',
    'score_diff',
    'partner_has_bid',
    'partner_has_passed',
    'base_bid_ceiling',
    'ceiling_minus_bid',
  ],
  weights: [
    0.008209684626992458, // meld_total
    0.3831471911349723, // ace_count
    1.3076567326278066, // trump_length
    0.48327692318863225, // longest_side_suit
    0.9001127736725427, // has_run
    -0.44408360709588285, // has_pinochle
    -2.1474845156320628, // has_around
    -0.030547412800173472, // bid
    0.00014665272100630728, // score_diff
    -0.16219837129064088, // partner_has_bid
    0.07102233954572583, // partner_has_passed
    0.0063672404328047535, // base_bid_ceiling
    0.00789943505538682, // ceiling_minus_bid
  ],
}

// Held-out decision agreement with the rollout: 97.5% over 81 rows,
// against a majority-verdict baseline of 88.9%; mean regret 0.8 points per decision.
// Note what is NOT a feature here: the game score and the partner-auction flags.
// The fold label was measured with the scores withheld, so it is score-independent
// by construction, and including score measurably hurt (93.6% -> 92.8%). Its
// ceiling is therefore computed at 0/0 rather than at the live score — see the
// exporter and the parity fixture.
export const FOLD_MODEL: LogisticModelData = {
  decision: '1 = concede (playing the contract out is worse than folding)',
  threshold: 0.5,
  intercept: 8.523722235984886,
  features: [
    'meld_total',
    'ace_count',
    'trump_length',
    'longest_side_suit',
    'has_run',
    'has_pinochle',
    'has_around',
    'bid',
    'bidding_meld',
    'defending_meld',
    'base_bid_ceiling',
    'ceiling_minus_bid',
    'tricks_needed',
    'fold_cost',
  ],
  weights: [
    -0.008251924512268537, // meld_total
    -1.3994621869248505, // ace_count
    -1.1211275591215628, // trump_length
    -0.7418084999375847, // longest_side_suit
    -0.5335094432908574, // has_run
    -0.08489695890781623, // has_pinochle
    -0.6798584076406218, // has_around
    0.010921290099819009, // bid
    -0.017048823275325413, // bidding_meld
    -0.0020566489087021664, // defending_meld
    -0.006368075057638706, // base_bid_ceiling
    -0.007448490015127003, // ceiling_minus_bid
    0.019200141427966957, // tricks_needed
    0.0016156908787789497, // fold_cost
  ],
}

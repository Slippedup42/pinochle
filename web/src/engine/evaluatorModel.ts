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

// Held-out decision agreement with the rollout: 85.9% over 410 rows,
// against a majority-verdict baseline of 60.5%; mean regret 9.6 points per decision.
// Disagreements with the rollout sit on near-boundary rows — 0% of them where
// the rollout's own EV margin exceeds 200 — so they cost points rather than
// describing a hand class the model gets wrong every time.
export const BID_MODEL: LogisticModelData = {
  decision: '1 = bid (taking the contract beats defending it)',
  threshold: 0.5,
  intercept: 0.8129169793635105,
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
    0.008537964746437044, // meld_total
    0.36898819502905106, // ace_count
    1.3403790076471331, // trump_length
    0.47209999521304874, // longest_side_suit
    0.8748918661721983, // has_run
    -0.4604836960208626, // has_pinochle
    -1.5249661805023889, // has_around
    -0.037035834103644444, // bid
    0.00018044859280577172, // score_diff
    -0.107599079108824, // partner_has_bid
    0.10033109264020625, // partner_has_passed
    0.005859088854883692, // base_bid_ceiling
    0.008084851118855272, // ceiling_minus_bid
  ],
}

// Held-out decision agreement with the rollout: 97.8% over 91 rows,
// against a majority-verdict baseline of 87.9%; mean regret 0.7 points per decision.
// Note what is NOT a feature here: the game score and the partner-auction flags.
// The fold label was measured with the scores withheld, so it is score-independent
// by construction, and including score measurably hurt (93.6% -> 92.8%). Its
// ceiling is therefore computed at 0/0 rather than at the live score — see the
// exporter and the parity fixture.
export const FOLD_MODEL: LogisticModelData = {
  decision: '1 = concede (playing the contract out is worse than folding)',
  threshold: 0.5,
  intercept: 7.320375205480179,
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
    -0.0046537165129570774, // meld_total
    -1.1294969058269673, // ace_count
    -1.744136807647529, // trump_length
    -0.5382289493050917, // longest_side_suit
    -0.5471211230316908, // has_run
    -0.644244403669061, // has_pinochle
    0.006365836746488704, // has_around
    0.014941616273893215, // bid
    -0.01625180427468925, // bidding_meld
    -0.005826687745839766, // defending_meld
    -0.004408599443440444, // base_bid_ceiling
    -0.006498679560123476, // ceiling_minus_bid
    0.02095183066199038, // tricks_needed
    0.0023775701162790826, // fold_cost
  ],
}

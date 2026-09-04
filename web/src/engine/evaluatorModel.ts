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

// Held-out decision agreement with the rollout: 82.9% over 414 rows,
// against a majority-verdict baseline of 57.2%; mean regret 13.2 points per decision.
// Disagreements with the rollout sit on near-boundary rows — 0% of them where
// the rollout's own EV margin exceeds 200 — so they cost points rather than
// describing a hand class the model gets wrong every time.
export const BID_MODEL: LogisticModelData = {
  decision: '1 = bid (taking the contract beats defending it)',
  threshold: 0.5,
  intercept: -6.803979799902088,
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
    0.001979112336703743, // meld_total
    0.1646845285387867, // ace_count
    1.2117663339950528, // trump_length
    0.3253515478666479, // longest_side_suit
    1.6441881677733934, // has_run
    -0.33818051357767637, // has_pinochle
    -1.4334545080110905, // has_around
    -0.009830478252295554, // bid
    0.0002885546880904971, // score_diff
    -0.34736010027290265, // partner_has_bid
    -0.0716807025181629, // partner_has_passed
    0.007300544407793197, // base_bid_ceiling
    0.008252827653031229, // ceiling_minus_bid
  ],
}

// Held-out decision agreement with the rollout: 92.0% over 87 rows,
// against a majority-verdict baseline of 81.6%; mean regret 3.0 points per decision.
// Note what is NOT a feature here: the game score and the partner-auction flags.
// The fold label was measured with the scores withheld, so it is score-independent
// by construction, and including score measurably hurt (93.6% -> 92.8%). Its
// ceiling is therefore computed at 0/0 rather than at the live score — see the
// exporter and the parity fixture.
export const FOLD_MODEL: LogisticModelData = {
  decision: '1 = concede (playing the contract out is worse than folding)',
  threshold: 0.5,
  intercept: -2.1455477427600202,
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
    -0.006608557448355503, // meld_total
    -0.4038546862663516, // ace_count
    -1.262043444899405, // trump_length
    -0.3590452180531683, // longest_side_suit
    -0.6815043477462482, // has_run
    -0.6707590005877615, // has_pinochle
    0.005986292613749415, // has_around
    0.028782865756897237, // bid
    -0.019027142681201363, // bidding_meld
    -0.007031205008859219, // defending_meld
    -0.001161852981190404, // base_bid_ceiling
    -0.003417837861705246, // ceiling_minus_bid
    0.02271700900411537, // tricks_needed
    0.0042061298084644354, // fold_cost
  ],
}

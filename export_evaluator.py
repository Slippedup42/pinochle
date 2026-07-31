"""
Export the fitted evaluator into `web/src/engine/` (issue #114, epic #104).

#113 fitted two logistic models to the rollout labels and wrote them to
`rollout_evaluator.json`. That file is Python's artefact: a JSON blob keyed by
decision point, with metrics and provenance mixed in alongside the weights.
This module turns it into the two things the PWA needs and nothing else:

  `web/src/engine/evaluatorModel.ts`     the weights, as a typed TS module
  `web/src/engine/evaluatorParity.fixture.ts`  fixed hands, scored by *Python*

Why generate a TS module and not import the JSON. `web/` builds with
`verbatimModuleSyntax` and a `noEmit` type-check step; a JSON import would be
untyped at the point of use and would need `resolveJsonModule` plus a cast that
is exactly the place a feature-order mismatch would hide. A generated module
carries the feature names as a literal type, so renaming a feature in Python
and forgetting to re-export is a TypeScript error rather than a silent NaN.

Why the fixture is generated here rather than written by hand. The whole risk
in #114 is that the TS side computes a *slightly different* feature vector than
the Python side fitted on - most of all `base_bid_ceiling`, which is not a
stored column but a re-derivation of `compute_max_bid`/`capped_bid` (the same
number `bidding.ts` calls `bestBaseBid`). A hand-written fixture would be
someone's belief about what Python returns; this one is what Python actually
returned, recorded per hand alongside the trump it picked, every feature, the
raw logit and the decision. `evaluatorParity.test.ts` then has something to
fail against.

Both outputs are regenerated, never edited. `--check` re-derives them in memory
and diffs against what is committed, which is what `test_export_evaluator.py`
runs: a refit that forgets to re-export fails the Python suite instead of
shipping a browser that disagrees with the model it claims to implement.

    python export_evaluator.py            # regenerate both files
    python export_evaluator.py --check    # fail if the committed files are stale
"""

import argparse
import json
import os
import sys

from generate_rollout_dataset import BID_DECISION, FOLD_DECISION
from fit_evaluator import (
    DEFAULT_DATASET_PATH,
    DEFAULT_MODEL_PATH,
    PROBLEMS,
    LogisticModel,
    read_dataset,
)


# ---------------------------------------------------------------------------
# Where the generated files land.
#
# Paths are relative to this file, not to the shell's working directory: the
# script is run from the repo root, from `web/`, and from pytest, and a
# generator that writes somewhere different depending on where it was invoked
# from is a generator that silently leaves a stale copy behind.
# ---------------------------------------------------------------------------

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
ENGINE_DIR = os.path.join(REPO_ROOT, "web", "src", "engine")
MODEL_TS_PATH = os.path.join(ENGINE_DIR, "evaluatorModel.ts")
FIXTURE_TS_PATH = os.path.join(ENGINE_DIR, "evaluatorParity.fixture.ts")

# How many rows of `rollout_dataset.csv` become parity cases. Big enough that a
# feature that is wrong only for an uncommon hand shape (a double run, a hand
# whose meld clears 300 and so uncaps the 400 ceiling) is very likely to appear,
# small enough that the generated file stays reviewable. Rows are taken at a
# fixed stride through the dataset rather than at random, so the fixture is a
# spread over real auctions and re-running the export reproduces it exactly.
BID_PARITY_CASES = 120
FOLD_PARITY_CASES = 60


# ---------------------------------------------------------------------------
# Emitting TypeScript — small helpers, because the alternative is f-strings
# with quotes in them scattered through four different writers.
# ---------------------------------------------------------------------------

def _exact(value):
    """A float at full round-trip precision.

    `repr` of a Python float is the shortest string that reads back as the same
    double, and JavaScript parses doubles the same way, so this is lossless in
    both directions. Weights go through here and never through `_number`:
    rounding a weight to make the file prettier would make the exported model a
    different model from the fitted one.
    """
    return repr(float(value))


def _number(value):
    """A float, printed as an integer when it is one.

    Only for quantities that are conceptually integral - meld totals, card
    counts, bid levels, ceilings. `510` reads better than `510.0` in a fixture
    a human has to review, and reads back into the identical double.
    """
    number = float(value)
    if number.is_integer() and abs(number) < 2 ** 53:
        return str(int(number))
    return repr(number)


def _string(value):
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def _comment_block(text):
    return "\n".join(f"// {line}".rstrip() for line in text.split("\n"))


def _banner(source):
    return _comment_block(
        "GENERATED FILE — do not edit by hand.\n"
        "\n"
        f"Produced by `export_evaluator.py` (issue #114) from `{source}`, which\n"
        "`fit_evaluator.py` and `generate_rollout_dataset.py` write (issues #113, #112).\n"
        "Re-run the exporter after any refit; `test_export_evaluator.py` fails the Python\n"
        "suite if this file has drifted from the model it claims to carry."
    )


# ---------------------------------------------------------------------------
# The model module.
# ---------------------------------------------------------------------------

MODEL_MODULE_DOC = """\

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
// precisely so this file needs no companion mean/stddev vector.\
"""


def build_model_module(artefact, model_path):
    """The generated `evaluatorModel.ts`, as a string."""
    lines = [_banner(os.path.basename(model_path)), MODEL_MODULE_DOC, ""]

    lines.append(_comment_block(
        "Provenance, copied from the artefact so a reader of this file can tell what\n"
        "configuration the weights describe without opening the Python side. A model\n"
        "fitted against a strategy flag that has since flipped is worse than no model.\n"
        "\n" + artefact["labelled_configuration"]
    ))
    lines.append("export const MODEL_PROVENANCE = {")
    lines.append(f"  formatVersion: {_number(artefact['format_version'])},")
    lines.append(f"  issue: {_string(artefact['issue'])},")
    lines.append(f"  dataset: {_string(artefact['dataset'])},")
    lines.append(f"  datasetRows: {_number(artefact['dataset_rows'])},")
    lines.append(f"  generatedBy: {_string(artefact['generated_by'])},")
    lines.append("} as const")
    lines.append("")

    lines.append(_comment_block(
        "A fitted linear-in-log-odds classifier. `features` is the order `weights` is\n"
        "in; the evaluator looks features up by name rather than by index so a\n"
        "reordered export can never silently pair a weight with the wrong number."
    ))
    lines.append("export interface LogisticModelData {")
    lines.append("  /** What a 1 means. Spelled out because 'bid' and 'concede' are opposite polarities. */")
    lines.append("  readonly decision: string")
    lines.append("  /** Probability at or above which the answer is 1. Carried explicitly rather than")
    lines.append("   *  assumed to be 0.5, so false bids can be traded against false passes without a refit. */")
    lines.append("  readonly threshold: number")
    lines.append("  readonly intercept: number")
    lines.append("  readonly features: readonly string[]")
    lines.append("  readonly weights: readonly number[]")
    lines.append("}")
    lines.append("")

    for name, const_name, note in (
        (BID_DECISION, "BID_MODEL",
         "Disagreements with the rollout sit on near-boundary rows — 0% of them where\n"
         "the rollout's own EV margin exceeds 200 — so they cost points rather than\n"
         "describing a hand class the model gets wrong every time."),
        (FOLD_DECISION, "FOLD_MODEL",
         "Note what is NOT a feature here: the game score and the partner-auction flags.\n"
         "The fold label was measured with the scores withheld, so it is score-independent\n"
         "by construction, and including score measurably hurt (93.6% -> 92.8%). Its\n"
         "ceiling is therefore computed at 0/0 rather than at the live score — see the\n"
         "exporter and the parity fixture."),
    ):
        metrics = artefact["metrics"][name]
        model = artefact["models"][name]
        lines.append(_comment_block(
            f"Held-out decision agreement with the rollout: "
            f"{metrics['holdout_agreement']:.1%} over {metrics['test_rows']} rows,\n"
            f"against a majority-verdict baseline of "
            f"{metrics['holdout_majority_baseline']:.1%}; mean regret "
            f"{metrics['holdout_mean_regret']:.1f} points per decision.\n"
            + note
        ))
        lines.append(f"export const {const_name}: LogisticModelData = {{")
        lines.append(f"  decision: {_string(model['decision'])},")
        lines.append(f"  threshold: {_exact(model['threshold'])},")
        lines.append(f"  intercept: {_exact(model['intercept'])},")
        lines.append("  features: [")
        for feature in model["features"]:
            lines.append(f"    {_string(feature)},")
        lines.append("  ],")
        lines.append("  weights: [")
        for feature, weight in zip(model["features"], model["weights"]):
            lines.append(f"    {_exact(weight)}, // {feature}")
        lines.append("  ],")
        lines.append("}")
        lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# The parity fixture.
#
# One row of the dataset becomes one case: the raw situation (so TS can
# re-derive everything from the 12 cards), plus what Python derived from it.
# The TS test recomputes and compares. Recording the whole feature vector, not
# just the verdict, is deliberate — a fixture that only stored the decision
# would say "these disagree" when what a reader needs to know is *which
# feature* disagrees, and a decision can match while the features underneath it
# are both wrong in cancelling directions.
# ---------------------------------------------------------------------------

def _stride_sample(rows, count):
    """`count` rows spread evenly through `rows`, in order, deterministically."""
    if len(rows) <= count:
        return list(rows)
    stride = len(rows) / count
    return [rows[int(index * stride)] for index in range(count)]


def _case_fields(row, problem, model, extra):
    """Shared tail of a parity case: features, logit and decision, from Python."""
    features = {name: float(value) for name, value in problem["extract"](row).items()}
    ordered = [features[name] for name in problem["features"]]
    parts = list(extra)
    parts.append("ceiling: " + _number(features["base_bid_ceiling"]))
    parts.append("features: [" + ", ".join(_number(v) for v in ordered) + "]")
    parts.append("logit: " + _exact(model.logit(features)))
    parts.append("decision: " + _number(model.decide(features)))
    return "  { " + ", ".join(parts) + " },"


FIXTURE_MODULE_DOC = """\

// Fixed hands, scored by the Python evaluator, for `evaluatorParity.test.ts`.
//
// The failure this exists to catch: `web/src/engine/` recomputing a *slightly*
// different feature vector than `fit_evaluator.py` fitted on, and nobody
// noticing until the AI plays oddly months later. The feature most likely to
// diverge is `base_bid_ceiling` — it is not a stored dataset column but a
// re-derivation of `compute_max_bid` + `capped_bid`, i.e. the number
// `bidding.ts` computes as `bestBaseBid`, whose port slipped once already
// (#118, NEAR_RUN_VALUE / NEAR_DOUBLE_PINOCHLE_VALUE). Every case therefore
// records the trump Python's `best_base_bid` chose as well as the ceiling, so a
// trump disagreement is caught by name instead of showing up as a wrong number.
//
// Hands are real auction situations sampled at a fixed stride from
// `rollout_dataset.csv`, not synthesised — the point is coverage of the hand
// distribution the AI actually meets.\
"""


def build_fixture_module(rows, models, dataset_path):
    """The generated `evaluatorParity.fixture.ts`, as a string."""
    lines = [_banner(os.path.basename(dataset_path)), FIXTURE_MODULE_DOC, ""]

    lines.append(_comment_block(
        "`hand` is `Card.toString()` tokens, space-separated and sorted — the same\n"
        "`rank + suit + '_' + copyId` form Python's `Card.__repr__` produces, so the two\n"
        "sides agree on which 12 cards a case means without a second encoding to keep in\n"
        "sync. `features` is in `BID_MODEL.features` order; `logit` and `decision` are\n"
        "what Python computed from exactly those numbers."
    ))
    lines.append("export interface BidParityCase {")
    lines.append("  readonly hand: string")
    lines.append("  readonly ourScore: number")
    lines.append("  readonly theirScore: number")
    lines.append("  readonly bid: number")
    lines.append("  readonly partnerHasBid: number")
    lines.append("  readonly partnerHasPassed: number")
    lines.append("  /** The suit Python's `best_base_bid` named at this hand and score. */")
    lines.append("  readonly trump: string")
    lines.append("  readonly ceiling: number")
    lines.append("  readonly features: readonly number[]")
    lines.append("  readonly logit: number")
    lines.append("  readonly decision: number")
    lines.append("}")
    lines.append("")
    lines.append(_comment_block(
        "The fold model's ceiling is computed at 0/0 rather than at the live score, and\n"
        "the score is deliberately absent from the case: `should_fold` was measured with\n"
        "the scores withheld, so a ceiling carrying the competitive adjustment would be\n"
        "the one place a score could leak back into a score-independent model."
    ))
    lines.append("export interface FoldParityCase {")
    lines.append("  readonly hand: string")
    lines.append("  readonly trump: string")
    lines.append("  readonly bid: number")
    lines.append("  readonly biddingMeld: number")
    lines.append("  readonly defendingMeld: number")
    lines.append("  readonly ceiling: number")
    lines.append("  readonly features: readonly number[]")
    lines.append("  readonly logit: number")
    lines.append("  readonly decision: number")
    lines.append("}")
    lines.append("")

    bid_problem = PROBLEMS[BID_DECISION]
    lines.append("export const BID_PARITY_CASES: readonly BidParityCase[] = [")
    for row in _stride_sample(bid_problem["rows"](rows), BID_PARITY_CASES):
        lines.append(_case_fields(row, bid_problem, models[BID_DECISION], [
            "hand: " + _string(row["hand"]),
            "ourScore: " + _number(row["our_score"]),
            "theirScore: " + _number(row["their_score"]),
            "bid: " + _number(row["bid"]),
            "partnerHasBid: " + _number(row["partner_has_bid"]),
            "partnerHasPassed: " + _number(row["partner_has_passed"]),
            "trump: " + _string(row["trump"]),
        ]))
    lines.append("]")
    lines.append("")

    fold_problem = PROBLEMS[FOLD_DECISION]
    lines.append("export const FOLD_PARITY_CASES: readonly FoldParityCase[] = [")
    for row in _stride_sample(fold_problem["rows"](rows), FOLD_PARITY_CASES):
        lines.append(_case_fields(row, fold_problem, models[FOLD_DECISION], [
            "hand: " + _string(row["hand"]),
            "trump: " + _string(row["trump"]),
            "bid: " + _number(row["bid"]),
            "biddingMeld: " + _number(row["bidding_meld"]),
            "defendingMeld: " + _number(row["defending_meld"]),
        ]))
    lines.append("]")
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Generate / check
# ---------------------------------------------------------------------------

def generated_files(model_path=DEFAULT_MODEL_PATH, dataset_path=DEFAULT_DATASET_PATH):
    """{path: contents} for every file this exporter owns."""
    with open(model_path, encoding="utf-8") as handle:
        artefact = json.load(handle)
    models = {name: LogisticModel.from_dict(payload)
              for name, payload in artefact["models"].items()}
    rows = read_dataset(dataset_path)
    return {
        MODEL_TS_PATH: build_model_module(artefact, model_path),
        FIXTURE_TS_PATH: build_fixture_module(rows, models, dataset_path),
    }


def stale_files(files):
    """Paths whose committed contents differ from what the exporter produces."""
    stale = []
    for path, contents in files.items():
        try:
            with open(path, encoding="utf-8") as handle:
                current = handle.read()
        except FileNotFoundError:
            stale.append(path)
            continue
        if current != contents:
            stale.append(path)
    return stale


def write_files(files):
    for path, contents in files.items():
        with open(path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(contents)


def main():
    parser = argparse.ArgumentParser(
        description="Export the fitted evaluator into web/src/engine (#114, epic #104)",
    )
    parser.add_argument("--model", default=DEFAULT_MODEL_PATH)
    parser.add_argument("--dataset", default=DEFAULT_DATASET_PATH)
    parser.add_argument("--check", action="store_true",
                        help="exit non-zero if the committed files are stale, writing nothing")
    args = parser.parse_args()

    files = generated_files(args.model, args.dataset)

    if args.check:
        stale = stale_files(files)
        for path in stale:
            print(f"stale: {os.path.relpath(path, REPO_ROOT)}")
        if stale:
            print("\nRe-run `python export_evaluator.py` and commit the result.")
            return 1
        print("generated files are up to date")
        return 0

    write_files(files)
    for path in files:
        print(f"wrote {os.path.relpath(path, REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

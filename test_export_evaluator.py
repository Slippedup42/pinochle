"""
Tests for issue #114 (epic #104) - the export that carries #113's fitted
evaluator into `web/src/engine/`. Plain assert-based, pytest-discoverable.

The one test that earns the file is `test_the_committed_typescript_is_what_this
_exporter_produces`. Everything downstream of the export - the browser's
bidding, `evaluatorParity.test.ts`, #115's measurement - assumes the TypeScript
in `web/` describes the model in `rollout_evaluator.json`. Nothing on the
TypeScript side can check that assumption: a stale `evaluatorModel.ts` and a
stale `evaluatorParity.fixture.ts` agree with each other perfectly, so the
parity suite goes green while the browser runs last month's weights. The only
place the drift is visible is here, against the artefact itself.

The rest covers the properties the generated files have to have for the parity
test to mean anything: that the weights survive the round trip through text at
full precision, that the fixture carries hands rather than restating the
dataset's own feature columns, and that a case's recorded logit is the logit the
Python model computes from the features recorded beside it.
"""

import json
import math
import os

from generate_rollout_dataset import BID_DECISION, FOLD_DECISION, decode_hand
from fit_evaluator import (
    DEFAULT_DATASET_PATH,
    DEFAULT_MODEL_PATH,
    PROBLEMS,
    LogisticModel,
    read_dataset,
)
from export_evaluator import (
    BID_PARITY_CASES,
    FIXTURE_TS_PATH,
    FOLD_PARITY_CASES,
    MODEL_TS_PATH,
    REPO_ROOT,
    _exact,
    _number,
    _stride_sample,
    build_model_module,
    generated_files,
    stale_files,
)


# The real artefact, read once. Every test below is about the relationship
# between it and the generated text, so they all need the same one.
with open(DEFAULT_MODEL_PATH, encoding="utf-8") as _handle:
    ARTEFACT = json.load(_handle)

MODELS = {name: LogisticModel.from_dict(payload)
          for name, payload in ARTEFACT["models"].items()}


# ---------------------------------------------------------------------------
# The check that keeps the browser honest.
# ---------------------------------------------------------------------------

def test_the_committed_typescript_is_what_this_exporter_produces():
    """
    A refit that forgets to re-export fails here rather than in play.

    This is the whole reason `export_evaluator.py --check` exists. The failure
    it guards against is silent by construction: the model module and the parity
    fixture are generated together, so a stale pair still agrees with itself and
    `evaluatorParity.test.ts` still passes - it is just checking last month's
    weights against last month's hands while the browser ships them too.
    """
    stale = stale_files(generated_files())
    assert stale == [], (
        "generated TypeScript is out of date with rollout_evaluator.json: "
        + ", ".join(os.path.relpath(path, REPO_ROOT) for path in stale)
        + " — run `python export_evaluator.py` and commit the result"
    )


def test_the_exporter_owns_exactly_the_two_files_it_claims_to():
    files = generated_files()
    assert set(files) == {MODEL_TS_PATH, FIXTURE_TS_PATH}
    for path in files:
        assert path.startswith(os.path.join(REPO_ROOT, "web", "src", "engine"))


# ---------------------------------------------------------------------------
# Numbers surviving the trip through text.
# ---------------------------------------------------------------------------

def test_weights_round_trip_through_the_generated_text_exactly():
    """
    `repr` of a float is the shortest string that reads back as the same double,
    and JavaScript parses doubles the same way - so a weight written this way is
    bit-identical on the other side. Rounding for readability would make the
    exported model a different model from the fitted one, in a way no test on
    the TypeScript side could distinguish from a feature bug.
    """
    for model in MODELS.values():
        for weight in [*model.weights, model.intercept]:
            assert float(_exact(weight)) == weight


def test_integral_quantities_print_without_a_decimal_point():
    # Only cosmetic, but the fixture is meant to be read: `510` beside `-110`
    # beside `0` is reviewable, `510.0` beside `-110.0` beside `0.0` is not.
    assert _number(510.0) == "510"
    assert _number(-110) == "-110"
    assert _number(0.0) == "0"
    # ...and anything genuinely fractional keeps its value rather than its looks.
    assert float(_number(0.5)) == 0.5


def test_every_weight_reaches_the_generated_module_labelled_with_its_feature():
    """A weight and a feature name are only meaningful as a pair, and the pairing
    is the thing a hand-edit or a reordered export would break."""
    text = build_model_module(ARTEFACT, DEFAULT_MODEL_PATH)
    for name, model in MODELS.items():
        for feature, weight in zip(model.features, model.weights):
            assert f"{_exact(weight)}, // {feature}" in text, (name, feature)


def test_the_generated_module_says_it_is_generated():
    text = build_model_module(ARTEFACT, DEFAULT_MODEL_PATH)
    assert "GENERATED FILE" in text.split("\n")[0]
    assert "export_evaluator.py" in text


def test_the_generated_module_carries_the_configuration_the_weights_describe():
    """A model fitted against a strategy flag that has since flipped is worse
    than no model, so the configuration travels with the weights instead of
    living only on the Python side."""
    text = build_model_module(ARTEFACT, DEFAULT_MODEL_PATH)
    for line in ARTEFACT["labelled_configuration"].split("\n"):
        assert line.strip() in text


# ---------------------------------------------------------------------------
# The parity fixture.
# ---------------------------------------------------------------------------

ROWS = read_dataset(DEFAULT_DATASET_PATH)


def test_the_sample_is_deterministic_and_ordered():
    """Re-running the export must reproduce the same fixture, or every refit
    produces an unreadable diff and the cases stop being a fixed set of hands."""
    rows = list(range(1000))
    first = _stride_sample(rows, 40)
    assert first == _stride_sample(rows, 40)
    assert first == sorted(first)
    assert len(first) == 40
    assert len(set(first)) == 40


def test_the_sample_spans_the_dataset_rather_than_its_first_rows():
    """`rollout_dataset.csv` is in capture order, so a head-slice would sample a
    handful of games. The stride has to reach the tail."""
    rows = list(range(1000))
    sample = _stride_sample(rows, 40)
    assert sample[0] < 50
    assert sample[-1] > 950


def test_a_short_dataset_yields_every_row_rather_than_repeating_any():
    assert _stride_sample([1, 2, 3], 10) == [1, 2, 3]


def _fixture_cases(decision_point, count):
    problem = PROBLEMS[decision_point]
    return problem, _stride_sample(problem["rows"](ROWS), count)


def test_the_fixture_records_hands_the_typescript_side_can_rebuild():
    """
    The point of shipping the 12 cards rather than the dataset's feature columns:
    the TypeScript side has to *derive* the features to be tested at all. A
    fixture of pre-computed features would only ever test the dot product.
    """
    for decision_point, count in ((BID_DECISION, BID_PARITY_CASES),
                                  (FOLD_DECISION, FOLD_PARITY_CASES)):
        _problem, sampled = _fixture_cases(decision_point, count)
        for row in sampled:
            assert len(decode_hand(row["hand"])) == 12


def test_each_case_carries_the_logit_the_model_computes_from_its_own_features():
    """
    The fixture's `logit` and `features` have to be the same evaluation, not two
    separate ones - the TypeScript test compares against both, and if they were
    inconsistent here it would be chasing a discrepancy that exists only in the
    fixture.
    """
    for decision_point, count in ((BID_DECISION, BID_PARITY_CASES),
                                  (FOLD_DECISION, FOLD_PARITY_CASES)):
        problem, sampled = _fixture_cases(decision_point, count)
        model = MODELS[decision_point]
        for row in sampled:
            features = {n: float(v) for n, v in problem["extract"](row).items()}
            ordered = [features[n] for n in problem["features"]]
            recomputed = model.intercept + sum(
                w * x for w, x in zip(model.weights, ordered)
            )
            assert math.isclose(recomputed, model.logit(features), rel_tol=1e-12)
            assert model.decide(features) == int(recomputed >= 0.0)


def test_the_sampled_cases_cover_both_verdicts_on_both_models():
    """A fixture that only contained one verdict would pass the TypeScript parity
    suite while proving nothing about where the boundary sits."""
    for decision_point, count in ((BID_DECISION, BID_PARITY_CASES),
                                  (FOLD_DECISION, FOLD_PARITY_CASES)):
        problem, sampled = _fixture_cases(decision_point, count)
        model = MODELS[decision_point]
        decisions = {
            model.decide({n: float(v) for n, v in problem["extract"](row).items()})
            for row in sampled
        }
        assert decisions == {0, 1}, decision_point


def test_the_sampled_cases_include_hands_near_the_decision_boundary():
    """
    Where a small feature error actually changes an answer.

    Away from the boundary a wrong `base_bid_ceiling` moves a probability from
    0.99 to 0.97 and the decision is unchanged - so a fixture of landslides
    would report perfect agreement while the port was broken. #118's bug moved
    ceilings by 60-plus points, which is well inside these margins.
    """
    problem, sampled = _fixture_cases(BID_DECISION, BID_PARITY_CASES)
    model = MODELS[BID_DECISION]
    near = [
        row for row in sampled
        if abs(model.logit({n: float(v) for n, v in problem["extract"](row).items()})) < 1.0
    ]
    assert len(near) > 5


def test_the_bid_and_fold_cases_are_drawn_from_their_own_decision_points():
    """The two models are not interchangeable, and a fold row scored by the bid
    model (or the reverse) would be a fixture asserting nonsense."""
    for decision_point, count in ((BID_DECISION, BID_PARITY_CASES),
                                  (FOLD_DECISION, FOLD_PARITY_CASES)):
        _problem, sampled = _fixture_cases(decision_point, count)
        assert {row["decision_point"] for row in sampled} == {decision_point}


def test_the_fold_cases_carry_the_melds_the_bid_cases_cannot():
    """A fold row is a different question from a different position: post-pass,
    auction over, both melds face up. `bidding_meld`/`defending_meld` are blank
    on a bid row because no such measurement exists there."""
    _problem, sampled = _fixture_cases(FOLD_DECISION, FOLD_PARITY_CASES)
    for row in sampled:
        assert row["bidding_meld"] is not None
        assert row["defending_meld"] is not None

    _bid_problem, bid_sampled = _fixture_cases(BID_DECISION, BID_PARITY_CASES)
    for row in bid_sampled:
        assert row["bidding_meld"] is None


def test_the_fold_ceiling_in_the_fixture_is_computed_without_the_score():
    """
    The fold label is score-independent by construction, so its ceiling is taken
    at 0/0. This asserts the fixture inherits that rather than quietly recording
    a live-score ceiling the TypeScript side would then be asked to reproduce.
    """
    from fit_evaluator import base_bid_ceiling
    from pinochle_engine import Suit

    problem, sampled = _fixture_cases(FOLD_DECISION, FOLD_PARITY_CASES)
    scored = [row for row in sampled
              if row["our_score"] != 0 or row["their_score"] != 0]
    assert scored, "no fold rows with a non-zero score — this test proves nothing"
    for row in scored:
        hand, trump = decode_hand(row["hand"]), Suit(row["trump"])
        assert problem["extract"](row)["base_bid_ceiling"] == base_bid_ceiling(hand, trump)

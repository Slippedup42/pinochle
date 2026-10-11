"""The rung-value model's generated TypeScript matches the JSON it claims to
carry, and the fitted tables have the shape a sensible model has."""

import json
import os

import fit_rung_value


def _model():
    with open(fit_rung_value.MODEL_PATH) as f:
        return json.load(f)


def test_typescript_matches_the_json():
    assert fit_rung_value.check(), (
        "web/src/engine/rungValueModel.ts has drifted from rung_value_model.json; "
        "re-run `python fit_rung_value.py fit <data...>`"
    )


def test_every_level_has_every_table():
    model = _model()
    levels = [str(level) for level in model["levels"]]
    for table in ("take", "defend", "stop"):
        assert sorted(model[table]) == sorted(levels)
    for level in levels:
        assert len(model["take"][level]) == len(model["features"])
        assert len(model["defend"][level]) == len(model["features"])


def test_defending_gets_better_and_holding_worse_as_the_level_rises():
    # At a typical hand: some meld, some tricks, 4 trump, 3 Aces, 1 trump Ace,
    # 1 nine. The intercepts alone are not comparable across levels.
    model = _model()
    x = [1.0, 130.0, 90.0, 4.0, 3.0, 1.0, 1.0]
    levels = [str(level) for level in model["levels"]]

    def value(table, level):
        return sum(c * v for c, v in zip(model[table][level], x))

    take = [value("take", level) for level in levels]
    defend = [value("defend", level) for level in levels]
    assert all(b > a for a, b in zip(defend, defend[1:]))
    assert all(b < a for a, b in zip(take, take[1:]))


def test_stop_probabilities_are_probabilities():
    for value in _model()["stop"].values():
        assert 0.0 <= value <= 1.0


def test_the_generated_file_is_where_the_consumer_imports_it_from():
    assert os.path.exists(fit_rung_value.TS_PATH)

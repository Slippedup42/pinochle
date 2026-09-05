"""
Tests for issue #211 - the recorded statistics `web/src/ab/stats.ts` is held to.

The division of labour is the same one `test_export_parity_scenarios.py` makes,
and it is easy to mistake this file for a duplicate of the TypeScript suite when
it is the opposite half:

  `web/src/ab/statsParity.test.ts` asks: does `stats.ts` reproduce these numbers?
  This one asks: are these numbers what `ab_harness.py` says?

Neither can vouch for the fixture alone. A recording taken from a broken
exporter would be reproduced happily by a correct TypeScript port and reported
as parity - which is exactly how a correctness net comes to certify the bug it
was built to find.

What this file adds beyond staleness. The recording here is *pure* - the same
inputs give the same numbers forever unless `ab_harness.py` itself changes - and
that is a stronger position than the round recorder is in, where re-recording
replays an AI that is expected to move. So the committed JSON is compared
against a fresh run of the Python functions, exactly, and a change to a Python
statistic fails this suite naming the case that moved rather than surfacing days
later as an unexplained TypeScript failure. The relative tolerance in
`export_stats_parity.py` is for comparing two *languages*; it has no business in
a Python-versus-Python comparison and is not used here.

The rest is about whether the fixture is worth anything: that each documented
contract has a case, that the binomial cases reach the tail where the two
implementations stop being a line-by-line port, and - the one that is not
obvious - that the bootstrap's percentile indices are not sitting inside a block
of tied resample means, where an off-by-one would return the identical interval
and no fixture could ever see it.
"""

import json
import os

import pytest

from ab_harness import binomial_two_sided_p, bootstrap_mean_ci, wilson_interval

from export_stats_parity import (
    CASES_JSON_PATH,
    FIXTURE_TS_PATH,
    RELATIVE_TOLERANCE,
    REPO_ROOT,
    SENSITIVITY_PERTURBATION,
    RecordedDraws,
    bootstrap_means,
    build_fixture_module,
    compare_with_python,
    generated_files,
    read_cases,
    record_cases,
    record_defaults,
    stale_files,
)


ARTEFACT = read_cases()
BINOMIAL = ARTEFACT["binomial"]
WILSON = ARTEFACT["wilson"]
BOOTSTRAP = ARTEFACT["bootstrap"]
RESAMPLING = [case for case in BOOTSTRAP if len(case["values"]) > 1]


# ---------------------------------------------------------------------------
# The recording is a true transcript of ab_harness.py.
# ---------------------------------------------------------------------------

def test_every_recorded_binomial_p_is_what_ab_harness_returns():
    for case in BINOMIAL:
        assert binomial_two_sided_p(case["wins"], case["trials"], case["p"]) == case["expected"], (
            case["id"], case["note"]
        )


def test_every_recorded_wilson_interval_is_what_ab_harness_returns():
    for case in WILSON:
        low, high = wilson_interval(case["wins"], case["trials"], case["z"])
        assert [low, high] == case["expected"], (case["id"], case["note"])


def test_every_recorded_bootstrap_interval_is_what_ab_harness_returns():
    """Replayed through the recorded draws, which is the only way this is
    reproducible at all - `bootstrap_mean_ci` with a real `random.Random` would
    give a different answer per Python build, let alone per language."""
    for case in BOOTSTRAP:
        rng = RecordedDraws(case["draws"])
        low, high = bootstrap_mean_ci(
            case["values"], iters=case["iters"], alpha=case["alpha"], rng=rng
        )
        assert [low, high] == case["expected"], (case["id"], case["note"])


def test_the_committed_json_is_what_this_exporter_records_today():
    """
    The whole of `--check`'s first half, as a test.

    This is what makes the guard bidirectional: `stats.ts` cannot drift without
    the TypeScript suite going red, and `ab_harness.py` cannot drift without
    this going red. A fixture that only checked the TS side would let a Python
    change silently redefine what parity means.
    """
    differences = compare_with_python(ARTEFACT)
    assert differences == [], (
        "stats_parity_cases.json no longer matches what ab_harness.py computes. "
        "Python is authoritative for this pair, so the recording is stale rather "
        "than wrong - but web/src/ab/stats.ts has NOT moved with it, so the two "
        "harnesses now report different numbers from the same run. Port the "
        "change into stats.ts, re-record with `python export_stats_parity.py "
        "--record`, and run the web suite to confirm the port landed:\n"
        + "\n".join(differences)
    )


def test_the_recorded_defaults_are_the_ones_ab_harness_actually_has():
    """
    The gap this file was one draft away from shipping with.

    Every case above passes `p`, `z`, `iters` and `alpha` explicitly, and
    *neither harness does*: `ab_harness.py` reports
    `wilson_interval(self.pairs_a, self.decisive_pairs)` and `abRun.ts` reports
    `wilsonInterval(pairsA, decisivePairs)` and
    `bootstrapMeanCi(pairMargins, makeRng(ciSeed))`. So the defaults are what
    every published interval in this project was computed with, and a fixture of
    explicit-argument cases says nothing about them at all. Mistyping 1.9599 for
    1.96 in one signature would move every reported confidence interval and
    leave all eighty-five recorded numbers green - which was checked by doing
    it, and the check stayed silent until this was added.

    Read from the signature rather than compared against literals here, so this
    tracks whatever `ab_harness.py` says rather than what someone once believed
    it said.
    """
    assert ARTEFACT["defaults"] == record_defaults()
    # And that the recorded values are the ones every published figure used, so
    # a deliberate change to a default has to be an explicit edit here too.
    assert ARTEFACT["defaults"] == {
        "binomial_p": 0.5,
        "wilson_z": 1.96,
        "bootstrap_iters": 5000,
        "bootstrap_alpha": 0.05,
    }


def test_recording_is_reproducible():
    """`--record` has to be idempotent or the staleness check reports noise and
    gets switched off."""
    assert record_cases() == record_cases()


def test_no_recorded_number_is_non_finite():
    """An `inf` or a `nan` would render as a TypeScript identifier that does not
    exist, and the fixture would fail to compile rather than fail to agree."""
    for case in BINOMIAL:
        assert case["expected"] == case["expected"]
        assert abs(case["expected"]) != float("inf"), case["id"]
    for case in WILSON + BOOTSTRAP:
        for value in case["expected"]:
            assert value == value, case["id"]
            assert abs(value) != float("inf"), case["id"]


# ---------------------------------------------------------------------------
# Is the fixture worth anything?
#
# A numerical fixture proves exactly as much as the shapes of input it holds,
# and that is invisible on inspection. Each of these pins a shape the cases were
# chosen for, so an edit that drops the last one says so.
# ---------------------------------------------------------------------------

def test_every_documented_contract_has_a_case():
    """The contracts both modules state in prose. A hand-port that dropped one
    of these guards produces a caller claiming significance it does not have,
    and nothing else would notice."""
    assert any(case["trials"] <= 0 and case["expected"] == 1.0 for case in BINOMIAL)
    assert any(case["trials"] <= 0 and case["expected"] == [0.0, 1.0] for case in WILSON)
    assert any(not case["values"] and case["expected"] == [0.0, 0.0] for case in BOOTSTRAP)
    assert any(
        len(case["values"]) == 1 and case["expected"] == [case["values"][0]] * 2
        for case in BOOTSTRAP
    )
    # And the sign, separately: an n == 1 branch that returned `abs` or `0`
    # would satisfy the line above on a positive sample.
    assert any(
        len(case["values"]) == 1 and case["values"][0] < 0 and case["expected"][0] < 0
        for case in BOOTSTRAP
    )


def test_the_binomial_cases_reach_the_regime_the_two_ports_differ_in():
    """
    `stats.ts` computes the coefficient through a Lanczos `logGamma` where
    `ab_harness.py` uses exact `math.comb`, because the exact one overflows a
    double not far above a thousand trials. Cases that stop at p = 0.01 would
    never visit the regime that difference was introduced for.
    """
    assert any(case["trials"] >= 1000 for case in BINOMIAL)
    assert any(0 < case["expected"] < 1e-70 for case in BINOMIAL)
    # `p` away from 0.5. At 0.5 the exact side's pmf is *identically* equal for
    # symmetric outcomes, so the 1e-9 inclusion slack in both implementations
    # never has to decide anything; away from it the near-ties are real.
    assert any(case["p"] != 0.5 for case in BINOMIAL)
    assert any(case["p"] > 0.5 for case in BINOMIAL)
    assert any(case["p"] < 0.5 for case in BINOMIAL)
    # Both a p of exactly 1.0 and a deep tail, so the `min(1.0, ...)` and the
    # sum itself are both exercised.
    assert any(case["expected"] == 1.0 and case["trials"] > 0 for case in BINOMIAL)


def test_the_binomial_cases_include_a_mirrored_pair_that_must_agree():
    """
    At p = 0.5 a result and its mirror are the same evidence, and both
    implementations are supposed to say so. On the TS side that is not free: the
    log-space coefficient is not exactly symmetric, which is the entire reason
    the inclusion test carries a relative slack. A fixture without a mirrored
    pair would not notice a port that dropped it.
    """
    by_input = {(case["wins"], case["trials"], case["p"]): case for case in BINOMIAL}
    mirrored = [
        (case, by_input[(case["trials"] - case["wins"], case["trials"], case["p"])])
        for case in BINOMIAL
        if case["p"] == 0.5
        and case["trials"] > 0
        and case["wins"] * 2 != case["trials"]
        and (case["trials"] - case["wins"], case["trials"], case["p"]) in by_input
    ]
    assert mirrored, "no mirrored pair at p = 0.5 in the fixture"
    for case, mirror in mirrored:
        assert case["expected"] == mirror["expected"], (case["id"], mirror["id"])


def test_the_wilson_cases_reach_both_clamps_and_neither():
    """`max(0.0, ...)` and `min(1.0, ...)` are two characters each and exactly
    what a port drops, and staying inside [0, 1] at the extremes is the whole
    stated reason for preferring Wilson to the normal approximation."""
    assert any(case["expected"][0] == 0.0 and case["trials"] > 0 for case in WILSON)
    assert any(case["expected"][1] == 1.0 and case["trials"] > 0 for case in WILSON)
    assert any(0.0 < case["expected"][0] and case["expected"][1] < 1.0 for case in WILSON)
    # More than one z, or the default is the only thing ever proved.
    assert len({case["z"] for case in WILSON}) >= 3


def test_the_bootstrap_cases_reach_each_percentile_index_and_the_clamp():
    lows = [int((case["alpha"] / 2) * case["iters"]) for case in RESAMPLING]
    highs = [int((1 - case["alpha"] / 2) * case["iters"]) for case in RESAMPLING]
    assert 0 in lows, "no case puts the low index at the first element"
    assert any(low > 1 for low in lows), "no case puts the low index mid-array"
    # The only thing that exercises `min(iters - 1, ...)`. Without the clamp the
    # TS side indexes one past the end, which is `undefined` and becomes NaN
    # rather than an error - a silent wrong answer, not a crash.
    assert any(
        high >= case["iters"] for high, case in zip(highs, RESAMPLING)
    ), "no case drives the high index past the end"
    assert any(
        high < case["iters"] - 1 for high, case in zip(highs, RESAMPLING)
    ), "no case puts the high index mid-array"


def test_the_bootstrap_cases_cover_the_verdict_the_statistic_exists_for():
    """An interval that excludes zero is the claim `bootstrap_mean_ci` is called
    to support, and one that straddles zero is the claim it is called to refuse.
    Both have to be in here or the fixture only ever checks the arithmetic on
    inputs no one would run it on."""
    assert any(case["expected"][0] > 0 for case in RESAMPLING)
    assert any(case["expected"][0] < 0 < case["expected"][1] for case in RESAMPLING)
    assert any(any(value < 0 for value in case["values"]) for case in RESAMPLING)


def test_the_recomputed_means_agree_with_the_real_function():
    """`bootstrap_means` is a second copy of the resampling loop, kept only so
    the tie test below can see the order statistics either side of the chosen
    index. It is worth nothing if it has drifted from the function it mirrors,
    so it is pinned at both ends: at alpha=0 the real interval is exactly the
    smallest and largest resample mean."""
    for case in RESAMPLING:
        means = bootstrap_means(case["values"], case["draws"])
        assert len(means) == case["iters"], case["id"]
        rng = RecordedDraws(case["draws"])
        low, high = bootstrap_mean_ci(case["values"], iters=case["iters"], alpha=0.0, rng=rng)
        assert low == means[0], case["id"]
        assert high == means[-1], case["id"]


def test_at_least_one_bootstrap_case_would_notice_an_off_by_one_index():
    """
    The thing a fixture of easy cases misses, and the reason case c09 exists.

    A bootstrap over a small discrete sample produces heavily tied resample
    means: with five distinct values and forty iterations, the mean at index 10
    is very often the same number as the mean at index 11. A percentile index
    that was off by one on the TypeScript side would then return the *identical*
    interval, and every case in this fixture would agree, and the port would be
    wrong in the one piece of arithmetic that was hand-written.

    So one case is built out of powers of ten, where every distinct resample
    gives a distinct sum and ties are impossible unless the same multiset is
    drawn twice. This asserts it actually delivers: at both the low and the high
    index, the neighbouring order statistics differ, so moving the index by one
    in either direction changes the recorded number.
    """
    def discriminates(case):
        means = bootstrap_means(case["values"], case["draws"])
        low = int((case["alpha"] / 2) * case["iters"])
        high = min(case["iters"] - 1, int((1 - case["alpha"] / 2) * case["iters"]))
        for index in (low, high):
            if index > 0 and means[index - 1] == means[index]:
                return False
            if index + 1 < len(means) and means[index + 1] == means[index]:
                return False
        return True

    discriminating = [case["id"] for case in RESAMPLING if discriminates(case)]
    assert discriminating, (
        "every bootstrap case has its percentile index sitting inside a block of "
        "tied resample means, so an off-by-one in the TypeScript index would "
        "return the same interval and this fixture would report parity"
    )


# ---------------------------------------------------------------------------
# The tolerance the TypeScript side is allowed.
# ---------------------------------------------------------------------------

def test_the_tolerance_is_carried_to_the_fixture_rather_than_written_twice():
    """A tolerance defined on each side separately is a tolerance that gets
    loosened on one side by someone chasing a red test."""
    assert ARTEFACT["relative_tolerance"] == RELATIVE_TOLERANCE
    assert ARTEFACT["sensitivity_perturbation"] == SENSITIVITY_PERTURBATION
    text = build_fixture_module(ARTEFACT)
    assert "export const RELATIVE_TOLERANCE = 1e-09" in text
    assert "export const SENSITIVITY_PERTURBATION = 1e-06" in text


def test_the_tolerance_is_tighter_than_a_mistyped_constant():
    """
    The number the tolerance has to be able to see. Substituting 1.9599 for 1.96
    is about the smallest slip a human makes in a hand-port, and it must not fit
    inside the allowance. Computed from the real function rather than asserted
    as 5e-5, because the point is what the *statistic* does with the typo, not
    what the constants look like.
    """
    correct = wilson_interval(211, 261, 1.96)
    typo = wilson_interval(211, 261, 1.9599)
    worst = max(abs(a - b) / abs(a) for a, b in zip(correct, typo))
    assert worst > SENSITIVITY_PERTURBATION > RELATIVE_TOLERANCE


# ---------------------------------------------------------------------------
# The generated TypeScript.
# ---------------------------------------------------------------------------

def test_the_committed_typescript_is_what_this_exporter_renders():
    """A hand-edited fixture is invisible to both suites otherwise: the TS side
    would be checking `stats.ts` against whatever the edit said, and reporting
    agreement."""
    stale = stale_files(generated_files(ARTEFACT))
    assert stale == [], (
        "generated TypeScript is out of date with stats_parity_cases.json: "
        + ", ".join(os.path.relpath(path, REPO_ROOT) for path in stale)
        + " - run `python export_stats_parity.py` and commit the result"
    )


def test_the_exporter_owns_exactly_the_one_generated_file_it_claims_to():
    files = generated_files(ARTEFACT)
    assert set(files) == {FIXTURE_TS_PATH}
    assert FIXTURE_TS_PATH.startswith(os.path.join(REPO_ROOT, "web", "src", "ab"))
    assert os.path.exists(CASES_JSON_PATH)


def test_the_generated_module_says_it_is_generated():
    text = build_fixture_module(ARTEFACT)
    assert "GENERATED FILE" in text.split("\n")[0]
    assert "export_stats_parity.py" in text


def test_rendering_is_a_pure_function_of_the_json():
    """What makes the staleness check meaningful: the same JSON has to render
    the same TypeScript every time, or it would be reporting noise."""
    assert build_fixture_module(ARTEFACT) == build_fixture_module(
        json.loads(json.dumps(ARTEFACT))
    )


def test_the_rendered_numbers_round_trip_to_the_bits_python_recorded():
    """
    The fixture carries doubles as decimal literals, and the tolerance is meant
    to be spent on the two algorithms rather than on the transport. `repr` is the
    shortest decimal that round-trips, and TypeScript parses a decimal literal to
    the same IEEE double Python does - so this holds, and if a future change ever
    rounded the output for readability it would stop holding here rather than
    showing up as a mysteriously widened disagreement in the browser.
    """
    for case in BINOMIAL:
        assert float(repr(case["expected"])) == case["expected"], case["id"]
    for case in WILSON + BOOTSTRAP:
        for value in case["expected"]:
            assert float(repr(value)) == value, case["id"]
    for case in BOOTSTRAP:
        for draw in case["draws"]:
            assert float(repr(draw)) == draw, case["id"]


def test_the_committed_json_declares_its_provenance():
    assert ARTEFACT["source"] == "ab_harness.py"
    assert ARTEFACT["issue"] == "#211"
    for kind in ("binomial", "wilson", "bootstrap"):
        ids = [case["id"] for case in ARTEFACT[kind]]
        assert len(set(ids)) == len(ids), kind
        assert all(case["note"] for case in ARTEFACT[kind]), kind


# ---------------------------------------------------------------------------
# The recorder itself.
# ---------------------------------------------------------------------------

def test_the_recorded_draws_pick_the_index_typescript_would_pick():
    """
    `RecordedDraws.randrange` stands in for `Math.floor(rand() * n)`, and the
    fixture is only meaningful if the substitution is exact. Checked at the ends
    of the unit interval, where a `round` mistaken for a `floor` would show.
    """
    rng = RecordedDraws([0.0, 0.999999, 0.5, 0.25, 0.75])
    assert [rng.randrange(4) for _ in range(5)] == [0, 3, 2, 1, 3]


def test_the_recorder_refuses_a_draw_list_the_bootstrap_does_not_consume():
    """If `bootstrap_mean_ci` ever changed its resampling shape - a different
    number of picks per iteration, say - the two sides would be handed different
    amounts of randomness and the fixture would pin a coincidence. The recorder
    asserts on that rather than recording it."""
    rng = RecordedDraws([0.1, 0.2])
    with pytest.raises(IndexError):
        bootstrap_mean_ci([1.0, 2.0, 3.0], iters=5, alpha=0.05, rng=rng)

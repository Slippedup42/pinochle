"""
Tests for issue #225 (epic #185) - the behavioural stamp on
`rollout_dataset.csv` and the `--check` that reads it.

The test that earns the file is `test_this_engine_labels_the_fingerprint_run
_the_way_the_stamp_says_it_does`. Everything downstream of the dataset -
`rollout_evaluator.json` fitted to it, `evaluatorModel.ts` exported from that,
the bid the browser makes - assumes the labels describe the engine that is in
the tree. Nothing checked that. A change to trick play moves what a rollout
measures, every label becomes a description of an engine that no longer exists,
and the whole chain stays green, because each link agrees with the link above
it and none of them agrees with the engine.

That test was EXPECTED TO FAIL when this file landed, and #226 has since
cleared it. The dataset it guarded had been labelled at ff236ef, before #273
corrected meld scoring and before #277 restructured the bid valuation, so the
engine really did label differently and the stamp said so in a `known_mismatch`
block. The guard was carried as a strict `xfail` keyed on the presence of that
block rather than on a flag set here, precisely so that regenerating - the only
act that legitimately clears it - would drop the block and turn the marker off
without anyone having to remember to delete it. #226 regenerated, `build_meta`
wrote a stamp with no block, and the marker is gone. What is left is an
ordinary test, which is the state this file was always aiming at.

The shape is worth remembering rather than reinventing, because the same
situation will recur the next time a Python change lands ahead of the ~13
minutes it costs to re-label: hand-write a `known_mismatch` block into the
stamp saying what moved and why, restore the marker keyed on that block, and it
will clear itself again on the regeneration. `strict=True` is what makes it
safe in the other direction - if the engine agrees with a stamp asserting that
it should not, the stamp was edited rather than earned, and the suite reports
XPASS(strict) rather than a quiet pass.

The rest of the file is about making that one test trustworthy: that the digest
moves when a label moves, that it does not move when a float wobbles below the
CSV's own rounding, and - most of all - that the failure report explains what a
mismatch MEANS. A guard whose failure reads as "the guard is broken" is a guard
that gets deleted, which is the same cry-wolf failure that ruled out hashing the
source in the first place.
"""

import functools
import json
import os

from generate_rollout_dataset import (
    DEFAULT_DATASET_PATH,
    DEFAULT_META_PATH,
    FINGERPRINT_RUN,
    FINGERPRINT_VERSION,
    LABEL_COLUMNS,
    REPO_ROOT,
    build_meta,
    canonical_label_text,
    fingerprint_rows,
    format_check_report,
    measure_fingerprint,
    meta_path_for,
    read_meta,
)


META_PATH = os.path.join(REPO_ROOT, DEFAULT_META_PATH)
DATASET_PATH = os.path.join(REPO_ROOT, DEFAULT_DATASET_PATH)

META = read_meta(META_PATH)


@functools.lru_cache(maxsize=1)
def measured():
    """The fixed re-run, paid for once per suite. Roughly 40 s - the price of
    asking the engine what it would do rather than what it looks like."""
    return measure_fingerprint(META["fingerprint"]["run"])


# ---------------------------------------------------------------------------
# The guard.
# ---------------------------------------------------------------------------

def test_this_engine_labels_the_fingerprint_run_the_way_the_stamp_says_it_does():
    """
    Would this engine label the dataset differently than the engine that
    produced it? That is the only question the whole distillation chain rests
    on, and until now nothing asked it.

    Re-labelling four seeded games rather than hashing the label path's source:
    the path is roughly forty functions across two modules, a hand-kept list of
    them rots the same way the dataset does, and a coarser digest over all of
    trick play would have fired on #168's `_expert_follow_card_honest`, which no
    rollout calls. Settled on #185; the reason it is written down here is that
    the cost - 40 s in the suite - is only worth paying for the question that
    actually matters.
    """
    ok, report = format_check_report(META, measured())
    assert ok, "\n" + report


# ---------------------------------------------------------------------------
# What the stamp claims about the dataset beside it.
# ---------------------------------------------------------------------------

def test_the_stamp_describes_the_committed_dataset():
    """A stamp that names some other file, or the wrong number of rows, is a
    stamp for a dataset nobody has."""
    assert META["dataset"] == os.path.basename(DATASET_PATH)
    with open(DATASET_PATH, encoding="utf-8") as handle:
        data_rows = sum(1 for _ in handle) - 1  # minus the header
    assert META["dataset_rows"] == data_rows


def test_the_stamp_names_the_commit_the_labels_came_from():
    """Without the commit, a mismatch is a mystery; with it, `git log
    <commit>..HEAD` is the list of suspects."""
    commit = META["generated_by"]["commit"]
    assert len(commit) == 40 and all(c in "0123456789abcdef" for c in commit)


def test_the_stamp_records_the_arguments_that_reproduce_the_dataset():
    args = META["generated_by"]["args"]
    assert args["seed"] == 112
    assert args["samples"] == 150
    assert args["max_rows"] == META["dataset_rows"]


def test_the_fingerprint_covers_every_label_column():
    """The digest narrowing to a subset would be invisible - it would still be
    a digest, still stable, and still green while the columns it dropped moved
    freely."""
    assert META["fingerprint"]["columns"] == list(LABEL_COLUMNS)
    assert LABEL_COLUMNS == ["p_make", "ev_take", "ev_defend", "ev_play_on",
                             "ev_fold", "verdict_bid", "verdict_fold"]


def test_the_stamped_run_is_the_fixed_run_this_generator_would_re_run():
    """The digest only means anything against the same run. A stamp taken with
    other arguments is not comparable, and silently re-running the stamped ones
    would compare a different question to the one the suite thinks it asked."""
    assert META["fingerprint"]["run"] == FINGERPRINT_RUN
    assert META["fingerprint"]["version"] == FINGERPRINT_VERSION
    assert META["fingerprint"]["algorithm"] == "sha256"
    assert len(META["fingerprint"]["digest"]) == 64


def test_the_stamp_is_valid_json_with_a_trailing_newline():
    """It is a committed artefact that gets diffed; POSIX text rules apply."""
    with open(META_PATH, encoding="utf-8") as handle:
        text = handle.read()
    assert text.endswith("\n")
    json.loads(text)


# ---------------------------------------------------------------------------
# Is the digest actually sensitive to what it claims to be sensitive to?
#
# A digest nobody has watched change is not known to change. These build rows
# by hand rather than re-running the engine, so they cost nothing and cover the
# cases a real drift would produce.
# ---------------------------------------------------------------------------

def _label_row(**overrides):
    row = {"p_make": 0.5, "ev_take": 10.0, "ev_defend": -10.0,
           "ev_play_on": None, "ev_fold": None,
           "verdict_bid": 1, "verdict_fold": None}
    row.update(overrides)
    return row


def test_a_single_moved_label_changes_the_digest():
    base = [_label_row(), _label_row(p_make=0.75)]
    moved = [_label_row(), _label_row(p_make=0.76)]
    assert fingerprint_rows(base) != fingerprint_rows(moved)


def test_a_flipped_verdict_changes_the_digest():
    base = [_label_row(verdict_bid=1)]
    flipped = [_label_row(verdict_bid=0)]
    assert fingerprint_rows(base) != fingerprint_rows(flipped)


def test_a_changed_row_count_changes_the_digest():
    """Composition drift, not label drift: #277 moved which hands open at all,
    so the capture pass reaches a different set of decision points. That has to
    fire too, or a guard on the labels would miss the dataset being about a
    different population."""
    assert fingerprint_rows([_label_row()]) != fingerprint_rows(
        [_label_row(), _label_row()])


def test_reordered_rows_change_the_digest():
    """Row order is capture order, which is game order. Two runs that produce
    the same multiset of labels in a different order are not the same run."""
    first, second = _label_row(p_make=0.1), _label_row(p_make=0.9)
    assert fingerprint_rows([first, second]) != fingerprint_rows([second, first])


def test_noise_below_the_csv_s_own_rounding_does_not_change_the_digest():
    """
    The labels are means over 150 samples, written to 4 places. If the digest
    were taken over raw floats it would move on the last bits of a sum and fire
    for reasons that have nothing to do with the engine - which is the cry-wolf
    failure, arrived at from the other direction.
    """
    base = [_label_row(p_make=0.5, ev_take=10.0)]
    jittered = [_label_row(p_make=0.5 + 1e-9, ev_take=10.0 - 1e-9)]
    assert fingerprint_rows(base) == fingerprint_rows(jittered)


def test_the_digest_ignores_the_feature_columns():
    """
    Documented rather than incidental: the fingerprint is a stamp on the
    labelling path, so a change that moved only a cheap feature would not fire
    here. `fit_evaluator.py` reads those columns straight out of the CSV, which
    is where such a change surfaces instead.
    """
    plain = _label_row()
    with_features = _label_row()
    with_features.update({"meld_total": 240, "ace_count": 4, "hand": "..."})
    assert fingerprint_rows([plain]) == fingerprint_rows([with_features])


def test_the_canonical_text_carries_its_format_version_and_columns():
    """So that a format change is loud in a diff, and so a human chasing a
    mismatch can dump this side by side for two revisions."""
    text = canonical_label_text([_label_row()])
    lines = text.splitlines()
    assert lines[0] == f"generate_rollout_dataset fingerprint v{FINGERPRINT_VERSION}"
    assert lines[1] == ",".join(LABEL_COLUMNS)
    assert lines[2] == "0.5,10.0,-10.0,,,1,"
    assert text.endswith("\n")


# ---------------------------------------------------------------------------
# The failure report, which is most of this guard's value.
# ---------------------------------------------------------------------------

def _fake_measurement(digest="deadbeef", rows=115):
    return {"run": dict(FINGERPRINT_RUN), "rows": rows, "digest": digest,
            "seconds": 41.2}


def _stamp(digest="cafef00d", rows=93, **extra):
    meta = {
        "dataset": "rollout_dataset.csv",
        "dataset_rows": 2000,
        "generated_by": {"commit": "f" * 40, "args": {}},
        "fingerprint": {"algorithm": "sha256", "version": FINGERPRINT_VERSION,
                        "columns": list(LABEL_COLUMNS), "run": dict(FINGERPRINT_RUN),
                        "rows": rows, "digest": digest},
    }
    meta.update(extra)
    return meta


def test_a_matching_digest_reports_agreement():
    ok, report = format_check_report(_stamp(digest="abc", rows=115),
                                     _fake_measurement(digest="abc"))
    assert ok
    assert "still describes the AI that ships" in report


def test_a_mismatch_says_the_dataset_is_wrong_rather_than_the_check():
    """
    The sentence that decides whether this guard survives contact with the
    person who hits it. "fingerprint mismatch" reads as a broken test; the
    report has to say that the engine would label differently, that the
    dataset and everything fitted to it therefore describe an engine that is
    gone, and that a mismatch is the check working.
    """
    ok, report = format_check_report(_stamp(), _fake_measurement())
    assert not ok
    assert "label the rollout dataset differently" in report
    assert "rollout_evaluator.json" in report
    assert "evaluatorModel.ts" in report
    assert "this guard doing its job" in report


def test_a_mismatch_names_the_ticket_that_fixes_it_and_warns_against_re_stamping():
    """Regeneration is the fix; re-stamping is the tempting non-fix, and it
    records the disagreement as agreement."""
    _ok, report = format_check_report(_stamp(), _fake_measurement())
    assert "#226" in report
    assert "Do NOT re-stamp without regenerating" in report


def test_a_mismatch_names_the_commit_the_dataset_came_from():
    _ok, report = format_check_report(_stamp(), _fake_measurement())
    assert "f" * 40 in report


def test_a_moved_row_count_is_called_out_as_composition_rather_than_labels():
    """The two failures want different reading: the same situations labelled
    differently, versus a different set of situations captured at all."""
    _ok, report = format_check_report(_stamp(rows=93), _fake_measurement(rows=115))
    assert "row count moved" in report and "composition" in report

    _ok, same_count = format_check_report(_stamp(rows=115), _fake_measurement(rows=115))
    assert "row count moved" not in same_count


def test_a_known_mismatch_block_is_quoted_back_in_the_report():
    """The person who hits a red check should not have to open the ticket to
    learn that it is already known and why."""
    known = {"issue": 226, "reason": "the labels predate #273's meld correction"}
    _ok, report = format_check_report(_stamp(known_mismatch=known),
                                      _fake_measurement())
    assert "ALREADY KNOWN" in report
    assert "#273's meld correction" in report
    assert "issue #226" in report


def test_a_matching_digest_under_a_known_mismatch_block_says_to_delete_the_block():
    """The state #226 would have landed in had it re-stamped without clearing
    the exception: digests agree, and the stamp still claims they should not.
    Watched before the marker came off - with this stamp planted, the guard
    reported XPASS(strict) and the suite failed."""
    known = {"issue": 226, "reason": "stale"}
    ok, report = format_check_report(
        _stamp(digest="abc", rows=115, known_mismatch=known),
        _fake_measurement(digest="abc"))
    assert ok, "the digests agree, and that is what this function answers"
    assert "Delete it" in report


def test_an_incomparable_stamp_says_so_instead_of_reporting_a_mismatch():
    """A version bump or a column change makes the two digests unrelated
    numbers. Reporting that as "the engine changed" would send someone hunting
    a strategy regression that never happened."""
    stale_version = _stamp()
    stale_version["fingerprint"]["version"] = FINGERPRINT_VERSION + 1
    ok, report = format_check_report(stale_version, _fake_measurement())
    assert not ok and "not comparable" in report

    narrowed = _stamp()
    narrowed["fingerprint"]["columns"] = ["p_make"]
    ok, report = format_check_report(narrowed, _fake_measurement())
    assert not ok and "not comparable" in report


# ---------------------------------------------------------------------------
# The stamp is written by generating, not by hand.
# ---------------------------------------------------------------------------

def test_a_freshly_built_stamp_carries_no_exception_block():
    """`known_mismatch` is hand-written and clears itself on regeneration -
    which is what let #226 drop the marker above by regenerating rather than by
    editing this file. If `build_meta` ever carried the block forward, the
    exception would outlive its reason."""
    meta = build_meta("rollout_dataset.csv", {"games": 4}, 2000,
                      _fake_measurement(), commit="a" * 40)
    assert "known_mismatch" not in meta
    assert meta["generated_by"]["commit"] == "a" * 40
    assert meta["fingerprint"]["digest"] == "deadbeef"


def test_the_stamp_is_named_after_the_dataset_it_stamps():
    """An experimental `--out` must not overwrite the committed stamp, and a
    dataset copied somewhere must take its stamp with it."""
    assert meta_path_for("rollout_dataset.csv") == "rollout_dataset.meta.json"
    assert meta_path_for(os.path.join("tmp", "trial.csv")) == os.path.join(
        "tmp", "trial.meta.json")
    assert meta_path_for("rollout_dataset.csv", "elsewhere.json") == "elsewhere.json"

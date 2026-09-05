"""
Tests for issue #279 - the recorded 3-card pass the TypeScript passer is held to.

The division of labour is the same one `test_export_parity_scenarios.py` sets
out, and it is easy to assume this file duplicates
`web/src/engine/passParity.test.ts` when it does the opposite.

  The TypeScript suite asks: does `passing.ts` send these three cards?
  This one asks: is this still what `pinochle_engine.py` sends?

Neither can vouch for the fixture alone, and that is the whole point of the
issue. A stale record and a stale module agree with each other perfectly: if
Python's passer moved and nobody re-recorded, the TS side would keep passing
against the old answer and report parity. If someone re-recorded without
touching `passing.ts`, the TS side would be handed a fresh answer to agree with
and report parity again. Both halves have to be checked, from both directions,
or the net catches nothing.

Unlike `test_export_parity_scenarios.py`, this file DOES assert that
re-recording reproduces the committed record, and it can because a pass is a
pure function of twelve cards, a trump suit and a role - no rollouts, no
auction, no randomness. There is no cry-wolf risk in asserting it: a mismatch
means the passer really did change, which is exactly the moment `passing.ts`
needs looking at.

What is NOT covered, and cannot be: Python's expert-tier pass logic
(`choose_forward_pass_cards`, its tier-0/tier-1 rules, the knapsack
`choose_return_pass_cards` - issue #61). It has no TypeScript counterpart at
all, so there is no second implementation to compare it against. `test_expert_
pass.py` covers it as behaviour; nothing can cover it as parity.
"""

import json
import os

from pinochle_engine import (
    Suit,
    _bidder_pass_selection,
    _partner_pass_selection,
)

from export_pass_parity import (
    BUILT_SCENARIOS,
    FIXTURE_TS_PATH,
    PASS_COUNT,
    REPO_ROOT,
    SCENARIOS_JSON_PATH,
    build_artefact,
    build_fixture_module,
    build_scenarios,
    category_for,
    check,
    format_check_report,
    generated_files,
    moved_scenarios,
    parse_hand,
    read_scenarios,
    stale_files,
)


ARTEFACT = read_scenarios()
SCENARIOS = ARTEFACT["scenarios"]
BY_ID = {scenario["id"]: scenario for scenario in SCENARIOS}


def _set(tokens):
    return set(tokens.split(" ")) if tokens else set()


def _by_covers(scenario_id):
    return BY_ID[scenario_id]


# ---------------------------------------------------------------------------
# The guard.
# ---------------------------------------------------------------------------

def test_this_engine_still_sends_what_the_record_says_it_sends():
    """
    The test that earns the file. Every recorded hand is passed through the
    shipped Python passer again and has to land on the recorded three cards.

    A failure here is not a broken test: it means `Player.choose_pass_cards` or
    one of the two tier lists under it now chooses differently, and therefore
    that `passParity.test.ts` is currently holding the browser to an answer this
    engine no longer gives. The fix is to move `passing.ts` first and re-record
    second - see `format_check_report`, which says so at the point of failure.
    """
    ok, report = check(ARTEFACT)
    assert ok, "\n" + report


def test_the_committed_typescript_is_what_this_exporter_renders():
    """A hand-edited fixture is invisible to both suites otherwise: the TS side
    would be checking the browser against whatever the edit said, and reporting
    agreement. This is the only place that drift shows up."""
    stale = stale_files(generated_files(ARTEFACT))
    assert stale == [], (
        "generated TypeScript is out of date with pass_parity_scenarios.json: "
        + ", ".join(os.path.relpath(path, REPO_ROOT) for path in stale)
        + " - run `python export_pass_parity.py` and commit the result"
    )


def test_the_recorded_category_is_the_split_the_engine_applies():
    """
    Recorded because `passing.ts` derives its own category from its own copy of
    the D/S vs H/C rule, and a ported one-line rule that quietly disagrees is
    #118's bug class exactly. Checked twice over: the recorded label matches the
    rule, and calling the tier function DIRECTLY with that label reproduces the
    pass that `Player.choose_pass_cards` produced by deriving it itself. If the
    two ever part company, the second assertion is what notices.
    """
    for scenario in SCENARIOS:
        trump = Suit(scenario["trump"])
        assert scenario["category"] == category_for(trump), scenario["id"]
        selection = (
            _bidder_pass_selection if scenario["role"] == "bidder"
            else _partner_pass_selection
        )
        chosen = selection(
            parse_hand(scenario["hand"]), trump, scenario["category"], PASS_COUNT
        )
        assert {repr(c) for c in chosen} == _set(scenario["passed"]), scenario["id"]


# ---------------------------------------------------------------------------
# The record is well formed. A malformed scenario would be reproduced happily
# by a correct TS passer and reported as parity.
# ---------------------------------------------------------------------------

def test_every_hand_is_twelve_distinct_cards():
    for scenario in SCENARIOS:
        tokens = scenario["hand"].split(" ")
        assert len(tokens) == 12, scenario["id"]
        assert len(set(tokens)) == 12, scenario["id"]


def test_every_recorded_pass_is_three_distinct_cards_out_of_that_hand():
    for scenario in SCENARIOS:
        passed = scenario["passed"].split(" ")
        assert len(passed) == PASS_COUNT, scenario["id"]
        assert len(set(passed)) == PASS_COUNT, scenario["id"]
        assert set(passed) <= _set(scenario["hand"]), scenario["id"]


def test_the_committed_json_declares_the_scenarios_it_carries():
    assert ARTEFACT["scenario_count"] == len(SCENARIOS)
    assert ARTEFACT["pass_count"] == PASS_COUNT
    assert len({scenario["id"] for scenario in SCENARIOS}) == len(SCENARIOS)
    assert os.path.exists(SCENARIOS_JSON_PATH)


def test_recording_is_reproducible_from_the_seeds_alone():
    """What makes the guard above meaningful. If two runs of the recorder on one
    engine could differ, a mismatch would say nothing about whether the passer
    changed."""
    assert build_scenarios() == build_scenarios()


# ---------------------------------------------------------------------------
# Coverage.
#
# Random hands overwhelmingly stop in the first tier or two, so a fixture of
# nothing but dealt hands would leave most of both priority lists untested while
# looking like 40 scenarios of coverage. The `built` half is aimed at what the
# tiers actually branch on, and these tests keep those labels honest - a
# scenario whose label has stopped being true is worse than no label at all.
# ---------------------------------------------------------------------------

def test_the_fixture_covers_all_four_trump_suits_both_roles_and_both_categories():
    assert {s["trump"] for s in SCENARIOS} == {suit.value for suit in Suit}
    assert {s["role"] for s in SCENARIOS} == {"bidder", "partner"}
    assert {s["category"] for s in SCENARIOS} == {"DS", "HC"}
    for role in ("bidder", "partner"):
        for category in ("DS", "HC"):
            assert any(
                s["role"] == role and s["category"] == category for s in SCENARIOS
            ), (role, category)


def test_the_fixture_carries_both_dealt_and_deliberately_built_hands():
    sources = {s["source"] for s in SCENARIOS}
    assert sources == {"deal", "built"}
    assert sum(1 for s in SCENARIOS if s["source"] == "deal") >= 20
    assert sum(1 for s in SCENARIOS if s["source"] == "built") >= 10


def test_every_built_scenario_says_what_it_is_for_and_is_a_distinct_position():
    built = [s for s in SCENARIOS if s["source"] == "built"]
    assert len(built) == len(BUILT_SCENARIOS)
    for scenario in built:
        assert scenario["covers"].strip(), scenario["id"]
    positions = {(s["hand"], s["trump"], s["role"]) for s in built}
    assert len(positions) == len(built), "two built scenarios ask the same question"


def test_the_built_half_reaches_the_tiers_random_hands_would_not():
    """The named branches, present by id. Listed here rather than read off the
    fixture so that deleting a scenario fails this test instead of silently
    shrinking what the TS side is held to."""
    required = {
        "partner-ds-qs-jd",
        "partner-hc-trump-spread",
        "partner-nontrump-aces-singleton-first",
        "partner-leftover-trump-then-dix",
        "partner-void-opportunity",
        "partner-filler-order",
        "partner-protected-ten-has-no-exception",
        "bidder-hc-qs-jd-then-ten",
        "bidder-protected-ten-survives-the-void-tier",
        "bidder-unprotected-ten-goes-protected-ten-stays",
        "bidder-hc-low-trump-last-resort",
        "bidder-ds-has-no-low-trump-tier",
        "bidder-marriage-and-around-hold-a-king-back",
        "bidder-ds-void-opportunity",
    }
    assert required <= set(BY_ID), sorted(required - set(BY_ID))


def test_the_trump_spread_scenario_still_spreads():
    """#280's acceptance case, restated as a property of the record: three
    distinct trump ranks go and the duplicate King stays. If a tier reorder
    stopped this hand from reaching the spread, the label would still read
    'trump spread' and nothing else would notice."""
    scenario = _by_covers("partner-hc-trump-spread")
    passed = parse_hand(scenario["passed"])
    trump = Suit(scenario["trump"])
    assert all(c.suit == trump for c in passed)
    assert len({c.rank for c in passed}) == PASS_COUNT
    kept = _set(scenario["hand"]) - _set(scenario["passed"])
    assert any(token.startswith("K") and token[1] == trump.value for token in kept)


def test_the_protected_ten_scenarios_still_point_in_opposite_directions():
    """#276 from both sides. The bidder holds the 10 back because both Aces of
    its suit are behind it; the partner does not, because by the time its filler
    tier runs those Aces have already gone the other way. Two scenarios that
    both happened to keep the 10 would look like coverage and be half of it."""
    bidder = _by_covers("bidder-unprotected-ten-goes-protected-ten-stays")
    assert "10C_1" not in _set(bidder["passed"]), "the protected 10 must stay"
    assert "10S_1" in _set(bidder["passed"]), "the bare 10 must go"

    void = _by_covers("bidder-protected-ten-survives-the-void-tier")
    assert "10C_1" not in _set(void["passed"])
    assert not ({"AC_1", "AC_2"} & _set(void["passed"])), "the Aces go with it"

    partner = _by_covers("partner-protected-ten-has-no-exception")
    assert {"AC_1", "AC_2", "10C_1"} == _set(partner["passed"])


def test_the_void_scenarios_still_empty_a_whole_suit():
    for scenario_id in ("partner-void-opportunity", "bidder-ds-void-opportunity"):
        scenario = _by_covers(scenario_id)
        passed = parse_hand(scenario["passed"])
        suit = passed[0].suit
        assert all(c.suit == suit for c in passed), scenario_id
        assert suit != Suit(scenario["trump"]), scenario_id
        kept = _set(scenario["hand"]) - _set(scenario["passed"])
        assert not any(token[-3] == suit.value for token in kept), scenario_id


def test_the_low_trump_last_resort_is_covered_in_hearts_clubs_and_absent_in_diamonds_spades():
    """The one tier that exists in one category and not the other. A fixture
    that only held the H/C shape would pass whether or not the TS side had the
    category guard on it at all."""
    hc = _by_covers("bidder-hc-low-trump-last-resort")
    assert hc["category"] == "HC"
    assert "JH_1" in _set(hc["passed"]), "the trump Jack is the tier-8 card"

    ds = _by_covers("bidder-ds-has-no-low-trump-tier")
    assert ds["category"] == "DS"
    assert not ({"JD_2", "9D_1"} & _set(ds["passed"])), (
        "tier 8 must not run in the D/S category"
    )


# ---------------------------------------------------------------------------
# Is the guard sensitive to what it claims to be sensitive to?
#
# A check nobody has watched fail is not known to work (#261). These plant both
# failures by hand, over synthetic records rather than over the committed one,
# so that a real engine change fires the guard above and ONLY the guard above -
# a sensitivity test that also went red would be noise on top of the one
# message someone needs to read.
# ---------------------------------------------------------------------------

def _record(scenario_id="x01", passed="9S_1 9S_2 9H_1"):
    return {
        "id": scenario_id, "source": "built", "covers": "a synthetic record",
        "hand": "9S_1 9S_2 9H_1 9H_2 9D_1 9D_2 9C_1 9C_2 JS_1 JD_1 JC_1 JH_1",
        "trump": "H", "role": "partner", "category": "HC", "passed": passed,
    }


def test_a_single_changed_card_in_the_record_is_caught():
    moved = moved_scenarios([_record(passed="9S_1 9S_2 9H_1")],
                            [_record(passed="9S_1 9S_2 9D_1")])
    assert [entry[0] for entry in moved] == ["x01"]
    assert moved[0][1:] == ("9S_1 9S_2 9H_1", "9S_1 9S_2 9D_1")


def test_a_reordered_pass_is_not_reported_as_a_mismatch():
    """The order-versus-set decision, made assertable. The record keeps tier
    order because it makes a reordering visible in a `--record` diff; the
    comparison is set-wise on both sides, so three cards listed differently are
    not a failure. #280's K-before-Q rework is a real example - reversing that
    one rank order moves the tier without moving the cards."""
    moved = moved_scenarios([_record(passed="9S_1 9S_2 9H_1")],
                            [_record(passed="9H_1 9S_2 9S_1")])
    assert moved == []


def test_a_dropped_or_added_scenario_is_caught_from_both_directions():
    """Coverage can shrink as quietly as an answer can move: a scenario deleted
    from the record is a branch the TS side stops being held to."""
    dropped = moved_scenarios([_record("x01"), _record("x02")], [_record("x01")])
    assert [entry[0] for entry in dropped] == ["x02"]
    assert "no longer recorded" in dropped[0][2]

    added = moved_scenarios([_record("x01")], [_record("x01"), _record("x02")])
    assert [entry[0] for entry in added] == ["x02"]
    assert "not in the committed record" in added[0][1]


# ---------------------------------------------------------------------------
# The failure report, which is most of this guard's value.
#
# #225's lesson, applied: a bare "mismatch" reads as a broken test and gets
# switched off. The two halves fail for unrelated reasons and want unrelated
# fixes, so each has to say which one it is.
# ---------------------------------------------------------------------------

def _artefact(*scenarios):
    return dict(ARTEFACT, scenarios=list(scenarios))


def test_agreement_is_reported_as_agreement():
    ok, report = format_check_report(_artefact(_record()), [_record()], [])
    assert ok
    assert "still sends what pass_parity_scenarios.json says" in report


def test_a_moved_record_says_the_engine_moved_and_names_the_scenario():
    ok, report = format_check_report(
        _artefact(_record(passed="9S_1 9S_2 9H_1")),
        [_record(passed="JS_1 JD_1 JC_1")], [])
    assert not ok
    assert "THE RECORD MOVED" in report
    assert "x01: recorded [9S_1 9S_2 9H_1] -> now [JS_1 JD_1 JC_1]" in report
    assert "passing.ts" in report
    assert "--record" in report


def test_a_moved_record_warns_against_re_recording_first():
    """The tempting non-fix. Re-recording alone hands the TypeScript side a
    fresh answer to agree with, which is the blindness #279 exists to remove -
    so the report has to say so where someone will read it."""
    _ok, report = format_check_report(
        _artefact(_record()), [_record(passed="JS_1 JD_1 JC_1")], [])
    assert "DO NOT re-record without step 1" in report
    assert "#279" in report


def test_a_stale_fixture_says_it_is_about_the_fixture_and_not_the_engine():
    """A staleness failure that read like an engine regression would send
    someone hunting a strategy change that never happened."""
    ok, report = format_check_report(
        _artefact(_record()), [_record()], [FIXTURE_TS_PATH])
    assert not ok
    assert "THE GENERATED FIXTURE IS STALE" in report
    assert "says nothing about the engine" in report
    assert "THE RECORD MOVED" not in report
    assert "export_pass_parity.py" in report


def test_both_halves_are_reported_when_both_are_stale():
    _ok, report = format_check_report(
        _artefact(_record()), [_record(passed="JS_1 JD_1 JC_1")], [FIXTURE_TS_PATH])
    assert "THE RECORD MOVED" in report
    assert "THE GENERATED FIXTURE IS STALE" in report


# ---------------------------------------------------------------------------
# The generated TypeScript.
# ---------------------------------------------------------------------------

def test_the_exporter_owns_exactly_the_one_generated_file_it_claims_to():
    files = generated_files(ARTEFACT)
    assert set(files) == {FIXTURE_TS_PATH}
    assert FIXTURE_TS_PATH.startswith(os.path.join(REPO_ROOT, "web", "src", "engine"))


def test_the_generated_module_says_it_is_generated_and_names_what_it_cannot_cover():
    text = build_fixture_module(ARTEFACT)
    assert "GENERATED FILE" in text.split("\n")[0]
    assert "export_pass_parity.py" in text
    # The expert-tier logic has no TS counterpart, and a fixture named
    # "pass parity" that did not say so would leave it looking covered.
    assert "choose_forward_pass_cards" in text
    assert "choose_return_pass_cards" in text


def test_rendering_is_a_pure_function_of_the_json():
    """What makes the staleness half meaningful: the same JSON has to render the
    same TypeScript every time, or the check would be reporting noise."""
    assert build_fixture_module(ARTEFACT) == build_fixture_module(
        json.loads(json.dumps(ARTEFACT))
    )


def test_the_artefact_records_which_functions_it_speaks_for():
    """So that a reader of the JSON knows what the fixture does and does not
    stand behind without going to the exporter for it."""
    assert build_artefact()["functions"] == [
        "Player.choose_pass_cards",
        "_partner_pass_selection",
        "_bidder_pass_selection",
    ]

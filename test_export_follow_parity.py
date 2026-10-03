"""
Tests for issue #319 - the recorded follow cards `chooseFollowCard` is held to.

Same division of labour as `test_export_pass_parity.py`:

  `web/src/engine/followParity.test.ts` asks: does `tracker.ts` play this card?
  This file asks: is this still what `pinochle_engine.py` plays?

A stale record and a stale fixture agree with each other perfectly, so both
halves are checked here. The record CAN be re-derived in the suite: the random
play is seeded per deal and `choose_follow_card` is a pure function of the
position, so a mismatch means the follower (or `Trick.legal_moves`) really did
change - exactly when `tracker.ts` needs looking at.

This net does not replace the intent-level tests in
`test_trick_play_strategy.py` (#164's feed, #322's sluff, #173's detection):
those say what the rule IS; this says the two engines still agree on it.
"""

import copy

from pinochle_engine import (
    POINT_RANKS,
    RANK_VALUE,
    PlayTracker,
    Suit,
    _feed_partner,
    _sluff_card,
    choose_follow_card,
)

from export_follow_parity import (
    BRANCHES,
    BUILT_SCENARIOS,
    FIXTURE_TS_PATH,
    REPO_ROOT,
    Seat,
    build_artefact,
    build_fixture_module,
    build_scenarios,
    check,
    format_check_report,
    generated_files,
    moved_scenarios,
    parse_hand,
    parse_trick,
    read_scenarios,
)


def _committed():
    return read_scenarios()["scenarios"]


def _lowest(cards):
    return min(cards, key=lambda c: RANK_VALUE[c.rank])


# ---------------------------------------------------------------------------
# The guard itself.
# ---------------------------------------------------------------------------

def test_the_engine_still_plays_what_the_record_says_and_the_fixture_is_fresh():
    ok, report = check()
    assert ok, report


def test_the_committed_typescript_is_what_this_exporter_renders():
    files = generated_files()
    with open(FIXTURE_TS_PATH, encoding="utf-8") as handle:
        assert handle.read() == files[FIXTURE_TS_PATH]


def test_recording_is_reproducible():
    assert build_scenarios() == build_scenarios()


def test_the_committed_json_declares_what_it_carries():
    artefact = read_scenarios()
    assert artefact["scenario_count"] == len(artefact["scenarios"])
    assert artefact["issue"] == "#319"
    assert "choose_follow_card" in artefact["functions"]
    assert build_artefact()["scenarios"] == artefact["scenarios"]


# ---------------------------------------------------------------------------
# Coverage: every tier, after both sides' leads (#312 forked on exactly that).
# ---------------------------------------------------------------------------

def test_every_tier_is_reached_after_both_an_opponents_lead_and_partners():
    seen = {(s["branch"], s["led_by"]) for s in _committed()}
    for branch in BRANCHES:
        sides = ("opponent",) if branch == "feed_ahead" else ("opponent", "partner")
        for side in sides:
            assert (branch, side) in seen, (branch, side)


def test_feed_ahead_is_only_ever_recorded_after_an_opponents_lead_in_second_seat():
    for s in _committed():
        if s["branch"] == "feed_ahead":
            assert s["led_by"] == "opponent", s["id"]
            assert len(s["trick"].split(" ")) == 1, s["id"]


def test_the_fixture_has_both_sources_and_enough_positions():
    sources = [s["source"] for s in _committed()]
    assert set(sources) == {"deal", "built"}
    assert len(sources) >= 200
    assert sources.count("built") == len(BUILT_SCENARIOS)


def test_built_scenarios_have_distinct_ids_and_say_what_they_are_for():
    ids = [entry[0] for entry in BUILT_SCENARIOS]
    assert len(ids) == len(set(ids))
    assert all(entry[-1].strip() for entry in BUILT_SCENARIOS)


# ---------------------------------------------------------------------------
# The labels are true: each branch's recorded card is what that tier's rule
# gives. A label that drifted from `choose_follow_card` fails here, so the
# coverage claims above cannot quietly become false.
# ---------------------------------------------------------------------------

def test_each_recorded_card_is_what_its_tier_says():
    for s in _committed():
        hand = parse_hand(s["hand"])
        legal = parse_hand(s["legal"])
        chosen = repr({
            "feed_ahead": lambda: _feed_partner(legal),
            "forced_beat": lambda: _lowest(legal),
            "partner_winning": lambda: _feed_partner(legal),
            "dump_low": lambda: _lowest([c for c in legal if c.rank not in POINT_RANKS]),
            "dump_all_counters": lambda: _lowest(legal),
            "trump_secure": lambda: _lowest(legal),
            "trump_unsecure_point": lambda: _lowest([c for c in legal if c.rank in POINT_RANKS]),
            "trump_unsecure_low": lambda: _lowest(legal),
            "sluff_protect": lambda: _sluff_card(hand, legal),
            "sluff_no_counters": lambda: _sluff_card(hand, legal),
            "sluff_all_counters": lambda: _sluff_card(hand, legal),
        }[s["branch"]]())
        assert chosen == s["chosen"], (s["id"], s["branch"], chosen, s["chosen"])


def test_a_partner_in_seat_zero_still_reads_as_partner():
    """`choose_follow_card` guards with `if winner_player`, which a bare seat
    index 0 fails. The exporter passes truthy `Seat`s for that reason; this
    pins it, using b12 - partner in seat 0 is winning with the Ace and the
    seat feeds the 10 rather than dumping the Queen."""
    s = next(x for x in _committed() if x["id"] == "b12")
    assert s["branch"] == "partner_winning"
    assert s["chosen"] == "10C_1"
    hand = parse_hand(s["hand"])
    plays = [(Seat(seat), card) for seat, card in parse_trick(s["trick"])]
    card = choose_follow_card(hand, parse_hand(s["legal"]), plays, Suit.HEARTS,
                              {Seat(0), Seat(2)}, PlayTracker())
    assert repr(card) == "10C_1"


# ---------------------------------------------------------------------------
# The report.
# ---------------------------------------------------------------------------

def test_a_changed_card_in_the_record_is_caught_and_named():
    committed = read_scenarios()
    tampered = copy.deepcopy(committed)
    target = tampered["scenarios"][0]
    legal = target["legal"].split(" ")
    target["chosen"] = next(t for t in legal if t != target["chosen"])
    ok, report = format_check_report(tampered, committed["scenarios"], [])
    assert not ok
    assert "THE RECORD MOVED" in report and target["id"] in report
    assert "DO NOT re-record" in report


def test_a_dropped_or_added_position_is_caught_from_both_directions():
    rebuilt = _committed()
    assert moved_scenarios(rebuilt[1:], rebuilt)
    assert moved_scenarios(rebuilt, rebuilt[1:])
    assert moved_scenarios(rebuilt, rebuilt) == []


def test_a_stale_fixture_says_it_is_about_the_fixture_and_not_the_engine():
    committed = read_scenarios()
    ok, report = format_check_report(committed, committed["scenarios"], [FIXTURE_TS_PATH])
    assert not ok
    assert "STALE" in report and "THE RECORD MOVED" not in report


def test_the_generated_module_says_it_is_generated():
    module = build_fixture_module(read_scenarios())
    assert module.startswith("// GENERATED FILE")
    assert "export_follow_parity.py" in module
    assert "#158" in module


def test_the_exporter_owns_exactly_one_generated_file():
    files = generated_files()
    assert list(files) == [FIXTURE_TS_PATH]
    assert FIXTURE_TS_PATH.startswith(REPO_ROOT)

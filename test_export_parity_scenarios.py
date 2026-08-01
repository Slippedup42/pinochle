"""
Tests for issue #125 (ROADMAP.md Phase 1.6) - the recorded rounds the
TypeScript engine is replayed against.

The division of labour matters here, because it is easy to assume this file
duplicates `web/src/engine/engineParity.test.ts` and it does the opposite.

  The TypeScript suite asks: does the TS engine reproduce these numbers?
  This one asks: are these numbers what the *Python* engine says?

Both sides compare against the same committed fixture, and neither can vouch for
it alone. A fixture recorded from a broken exporter would be reproduced happily
by a correct TS engine and reported as parity. So every scenario is replayed
here through `Trick`, `score_melds` and the round-scoring rule, from the cards
up, and has to land on the values it claims - which also means a change to a
*rule* in `pinochle_engine.py` fails the Python suite immediately, naming the
scenario, instead of showing up days later as an unexplained TS failure.

What is deliberately NOT asserted: that re-recording reproduces the committed
JSON. Recording replays the AI, and the AI is expected to change - #115 already
swapped the bid policy once. A staleness check over recorded play would turn
every AI tweak into a red suite and a 200 KB diff, which is how a correctness
net gets deleted. The staleness check that *is* here covers the generated
TypeScript against the committed JSON, where drift is real and silent: a
hand-edited fixture would otherwise sail past both suites.
"""

import json
import os

from pinochle_engine import Card, Suit, Trick, score_melds

from export_parity_scenarios import (
    FIXTURE_TS_PATH,
    LAST_TRICK_BONUS,
    REPO_ROOT,
    SCENARIOS_JSON_PATH,
    TRICK_COUNT,
    build_fixture_module,
    generated_files,
    read_scenarios,
    record_scenario,
    stale_files,
    team_of,
)


ARTEFACT = read_scenarios()
SCENARIOS = ARTEFACT["scenarios"]


def _card(token):
    """`10D_1` -> the 10 of Diamonds, first copy. Inverse of `Card.__repr__`."""
    body, copy_id = token.split("_")
    return Card(Suit(body[-1]), body[:-1], int(copy_id))


def _hand(tokens):
    return [_card(token) for token in tokens.split(" ")] if tokens else []


# ---------------------------------------------------------------------------
# The fixture is a real transcript of this engine.
#
# Every scenario replayed from its cards, through the same classes a live Round
# uses. If any of these fail, the TypeScript suite is comparing itself against
# fiction.
# ---------------------------------------------------------------------------

def test_the_recorded_pass_moves_exactly_three_cards_each_way():
    for scenario in SCENARIOS:
        assert len(_hand(scenario["pass_to_bidder"])) == 3, scenario["id"]
        assert len(_hand(scenario["pass_to_partner"])) == 3, scenario["id"]


def test_the_recorded_hands_rebuild_from_the_deal_and_the_pass():
    """
    The post-pass hands are not independent data - they are the dealt hands with
    six cards moved. Recording both and checking they agree is what lets the TS
    side *derive* the post-pass hands rather than trust them.
    """
    for scenario in SCENARIOS:
        hands = [set(hand.split(" ")) for hand in scenario["dealt_hands"]]
        bid_winner = scenario["bid_winner"]
        partner = (bid_winner + 2) % 4
        to_bidder = set(scenario["pass_to_bidder"].split(" "))
        to_partner = set(scenario["pass_to_partner"].split(" "))

        hands[partner] -= to_bidder
        hands[bid_winner] -= to_partner
        hands[bid_winner] |= to_bidder
        hands[partner] |= to_partner

        for seat in range(4):
            assert hands[seat] == set(scenario["hands_after_pass"][seat].split(" ")), (
                scenario["id"], seat
            )
            assert len(hands[seat]) == 12, (scenario["id"], seat)


def test_every_scenario_deals_all_48_cards_exactly_once():
    for scenario in SCENARIOS:
        tokens = [t for hand in scenario["dealt_hands"] for t in hand.split(" ")]
        assert len(tokens) == 48, scenario["id"]
        assert len(set(tokens)) == 48, scenario["id"]


def test_the_recorded_meld_is_what_score_melds_returns():
    for scenario in SCENARIOS:
        trump = Suit(scenario["trump"])
        for seat in range(4):
            total, breakdown = score_melds(_hand(scenario["hands_after_pass"][seat]), trump)
            assert total == scenario["meld_by_player"][seat], (scenario["id"], seat)
            assert breakdown == scenario["meld_breakdown_by_player"][seat], (
                scenario["id"], seat
            )


def test_the_recorded_team_meld_is_the_sum_over_its_two_seats():
    for scenario in SCENARIOS:
        totals = [0, 0]
        for seat, points in enumerate(scenario["meld_by_player"]):
            totals[team_of(seat)] += points
        assert totals == scenario["meld_by_team"], scenario["id"]


def test_every_recorded_play_was_legal_and_every_trick_resolves_as_recorded():
    """
    The heart of the file: 40 rounds re-run card by card through `Trick`.

    Legality, the winner and the points all come back out of the engine rather
    than being restated, so a change to `Trick.legal_moves` or `Trick.winner`
    fails here naming the scenario and trick - which is also the only way the
    committed `legal_follows` sets, the thing the TS side is held to, stay
    honest.
    """
    for scenario in SCENARIOS:
        trump = Suit(scenario["trump"])
        hands = [_hand(hand) for hand in scenario["hands_after_pass"]]
        leader = scenario["bid_winner"]
        trick_points = [0, 0]

        for trick_number, recorded in enumerate(scenario["tricks"]):
            assert recorded["leader"] == leader, (scenario["id"], trick_number)
            trick = Trick(trump)
            seat = leader
            for position, token in enumerate(recorded["cards"]):
                card = _card(token)
                legal = trick.legal_moves(hands[seat])
                assert card in legal, (scenario["id"], trick_number, position)
                if position > 0:
                    recorded_legal = recorded["legal_follows"][position - 1]
                    assert " ".join(sorted(repr(c) for c in legal)) == recorded_legal, (
                        scenario["id"], trick_number, position
                    )
                hands[seat].remove(card)
                trick.play(seat, card)
                seat = (seat + 1) % 4

            assert trick.winner() == recorded["winner"], (scenario["id"], trick_number)
            assert trick.points() == recorded["points"], (scenario["id"], trick_number)
            awarded = recorded["points"] + (
                LAST_TRICK_BONUS if trick_number == TRICK_COUNT - 1 else 0
            )
            trick_points[team_of(recorded["winner"])] += awarded
            leader = recorded["winner"]

        assert trick_points == scenario["trick_points_by_team"], scenario["id"]
        assert all(not hand for hand in hands), scenario["id"]


def test_the_recorded_round_score_follows_the_contract_rule():
    """
    `Round._score_round`, restated over the recorded totals: the bidding team
    takes -bid if meld + tricks falls short, the defenders always keep their own.
    Stated here rather than imported because it is the rule the TS `scoreRound`
    is being held to, and a helper both sides call would make the two agree by
    construction.
    """
    for scenario in SCENARIOS:
        bidding_team = team_of(scenario["bid_winner"])
        for team in (0, 1):
            total = scenario["meld_by_team"][team] + scenario["trick_points_by_team"][team]
            expected = -scenario["bid"] if team == bidding_team and total < scenario["bid"] else total
            assert scenario["round_score_by_team"][team] == expected, (scenario["id"], team)


# ---------------------------------------------------------------------------
# Coverage. A correctness net that only ever sees one shape of round proves
# very little, and nothing about the fixture makes that visible on inspection.
# ---------------------------------------------------------------------------

def test_the_fixture_covers_all_four_trump_suits():
    assert {scenario["trump"] for scenario in SCENARIOS} == {s.value for s in Suit}


def test_the_fixture_covers_both_a_made_contract_and_a_set_one():
    """The `-bid` branch of round scoring is a rule in its own right, and a
    fixture where every contract was made would never reach it."""
    verdicts = {
        scenario["round_score_by_team"][team_of(scenario["bid_winner"])] < 0
        for scenario in SCENARIOS
    }
    assert verdicts == {True, False}


def test_the_fixture_covers_the_meld_types_the_port_can_get_wrong():
    """
    Not every meld - Double Run is rare enough that 40 random deals will usually
    miss it, and `melds.test.ts` covers it directly. These are the ones that
    depend on *counting* copies rather than recognising a shape, which is where
    a port slips.
    """
    seen = {
        name
        for scenario in SCENARIOS
        for breakdown in scenario["meld_breakdown_by_player"]
        for name in breakdown
    }
    for meld in ("Run", "Royal Marriage", "Common Marriage", "Dix",
                 "Pinochle", "Double Pinochle", "As Around"):
        assert meld in seen, meld


def test_the_fixture_covers_a_last_trick_taken_by_the_defenders():
    """Otherwise the +10 bonus would only ever be checked landing on the team
    that was already collecting most of the points, where an error of 10 hides
    inside a made contract."""
    stolen = [
        scenario for scenario in SCENARIOS
        if team_of(scenario["tricks"][-1]["winner"]) != team_of(scenario["bid_winner"])
    ]
    assert stolen, "no scenario where the defenders take the last trick"


def test_the_fixture_reaches_every_branch_of_the_legal_move_filter():
    """
    `Trick.legal_moves` has six outcomes, and the fixture is worth exactly as
    much as the number of them it reaches. The rare two are the point: a port
    can get "follow suit" right and still mishandle "you are void, you hold
    trump, and there is already a trump on the table", which is where the rule
    is least intuitive and least often hit in casual play.

    Classified from the hands rather than from the recorded legal sets, so this
    stays a statement about the *positions* the fixture contains and does not
    quietly become a restatement of what was recorded.
    """
    branches = set()
    for scenario in SCENARIOS:
        trump = Suit(scenario["trump"])
        hands = [_hand(hand) for hand in scenario["hands_after_pass"]]
        leader = scenario["bid_winner"]
        for recorded in scenario["tricks"]:
            trick = Trick(trump)
            seat = leader
            for position, token in enumerate(recorded["cards"]):
                hand = hands[seat]
                if position > 0:
                    branches.add(_branch(trick, hand, trump))
                hand.remove(_card(token))
                trick.play(seat, _card(token))
                seat = (seat + 1) % 4
            leader = recorded["winner"]

    assert branches == {
        "must beat the lead suit",
        "follow the lead suit, cannot beat",
        "must trump, void in the lead suit",
        "must overtrump",
        "must trump, cannot overtrump",
        "sluff, void in the lead suit and in trump",
    }, sorted(branches)


def _branch(trick, hand, trump):
    """Which arm of `Trick.legal_moves` this position lands in."""
    on_table = [card for _seat, card in trick.plays]
    in_lead_suit = [card for card in hand if card.suit == trick.lead_suit]
    if in_lead_suit:
        best = max((c for c in on_table if c.suit == trick.lead_suit),
                   key=lambda c: c.rank_value)
        if any(c.rank_value > best.rank_value for c in in_lead_suit):
            return "must beat the lead suit"
        return "follow the lead suit, cannot beat"

    in_trump = [card for card in hand if card.suit == trump]
    if not in_trump:
        return "sluff, void in the lead suit and in trump"
    trump_on_table = [c for c in on_table if c.suit == trump]
    if not trump_on_table:
        return "must trump, void in the lead suit"
    best_trump = max(trump_on_table, key=lambda c: c.rank_value)
    if any(c.rank_value > best_trump.rank_value for c in in_trump):
        return "must overtrump"
    return "must trump, cannot overtrump"


# ---------------------------------------------------------------------------
# The generated TypeScript.
# ---------------------------------------------------------------------------

def test_the_committed_typescript_is_what_this_exporter_renders():
    """
    A hand-edited fixture is invisible to both suites otherwise: the TS side
    would be checking the engine against whatever the edit said, and reporting
    agreement. This is the only place that drift shows up.
    """
    stale = stale_files(generated_files(ARTEFACT))
    assert stale == [], (
        "generated TypeScript is out of date with parity_scenarios.json: "
        + ", ".join(os.path.relpath(path, REPO_ROOT) for path in stale)
        + " — run `python export_parity_scenarios.py` and commit the result"
    )


def test_the_exporter_owns_exactly_the_one_generated_file_it_claims_to():
    files = generated_files(ARTEFACT)
    assert set(files) == {FIXTURE_TS_PATH}
    assert FIXTURE_TS_PATH.startswith(os.path.join(REPO_ROOT, "web", "src", "engine"))


def test_the_generated_module_says_it_is_generated():
    text = build_fixture_module(ARTEFACT)
    assert "GENERATED FILE" in text.split("\n")[0]
    assert "export_parity_scenarios.py" in text


def test_rendering_is_a_pure_function_of_the_json():
    """What makes `--check` meaningful: the same JSON has to render the same
    TypeScript every time, or the staleness check would be reporting noise."""
    assert build_fixture_module(ARTEFACT) == build_fixture_module(json.loads(
        json.dumps(ARTEFACT)
    ))


def test_the_committed_json_declares_the_scenarios_it_carries():
    assert ARTEFACT["scenario_count"] == len(SCENARIOS)
    assert len(SCENARIOS) >= 20
    assert len({scenario["id"] for scenario in SCENARIOS}) == len(SCENARIOS)
    assert os.path.exists(SCENARIOS_JSON_PATH)


# ---------------------------------------------------------------------------
# The recorder itself.
# ---------------------------------------------------------------------------

def test_recording_a_scenario_is_reproducible_from_its_seed_alone():
    """
    Each scenario reseeds the global RNG from its own seed before playing, so
    re-recording one does not depend on how many random values the scenarios
    before it happened to consume. Without that, `--record` would be
    order-sensitive and a change to `--count` would rewrite every scenario.
    """
    assert record_scenario(0) == record_scenario(0)


def test_re_recording_reproduces_the_committed_deal():
    """
    The deal is the one part of a scenario the AI cannot move: the shuffle draws
    from a `random.Random` built fresh from the scenario's own seed, before any
    player has decided anything. So this is safe to assert against the committed
    fixture where the recorded *play* is not - it fails only if `Deck.shuffle`
    or the seeding changed, which is a genuine reason for the whole fixture to
    be re-recorded rather than a routine AI tweak.
    """
    fresh = record_scenario(0)
    assert fresh["dealt_hands"] == SCENARIOS[0]["dealt_hands"]
    assert fresh["dealer"] == SCENARIOS[0]["dealer"]
    assert fresh["seed"] == SCENARIOS[0]["seed"]

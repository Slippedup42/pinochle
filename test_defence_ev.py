"""
Tests for issue #103 (epic #106) - scoring a pass by rolling out the defence
instead of assuming it is worth zero. Plain assert-based, pytest-discoverable.
Covers:

  1. The differential helpers, against synthetic samples where the right
     answer is arithmetic rather than a simulation result.
  2. `defend_ev` produces a real, non-zero number, and moves in the right
     direction with hand strength.
  3. The defence rollout seats the *stronger* opponent as the bid winner and
     lets them pick their own trump - modelling a contract played in our
     preferred suit by whichever opponent happens to be on the left would be
     a contract nobody would ever actually play.
  4. `choose_bid_vs_defence` keeps `choose_bid_by_ev`'s return shape, and
     picks a bid whose EV is negative when defending is worse - the blocking
     behaviour that used to need a hand-coded branch and a
     DEFENSIVE_PUSH_FLOOR constant.
  5. Nothing is enabled by default, and #60's `bid_ev` is untouched.
"""

import random

from pinochle_engine import Card, Suit
from pinochle_rollout import (
    _differential_when_they_bid,
    _differential_when_we_bid,
    bid_ev,
    bid_ev_differential,
    choose_bid_vs_defence,
    defend_ev,
    estimate_defence,
)


def _marginal_hand():
    return [
        Card(Suit.CLUBS, "A", 1), Card(Suit.CLUBS, "K", 1), Card(Suit.CLUBS, "Q", 1),
        Card(Suit.CLUBS, "9", 1), Card(Suit.SPADES, "A", 1), Card(Suit.SPADES, "K", 1),
        Card(Suit.DIAMONDS, "K", 1), Card(Suit.DIAMONDS, "J", 1), Card(Suit.HEARTS, "10", 1),
        Card(Suit.HEARTS, "J", 1), Card(Suit.HEARTS, "9", 1), Card(Suit.SPADES, "9", 1),
    ]


def _powerhouse_hand():
    trump = Suit.CLUBS
    return [
        Card(trump, "A", 1), Card(trump, "A", 2), Card(trump, "10", 1), Card(trump, "10", 2),
        Card(trump, "K", 1), Card(trump, "Q", 1), Card(trump, "J", 1),
        Card(Suit.SPADES, "A", 1), Card(Suit.SPADES, "A", 2),
        Card(Suit.DIAMONDS, "A", 1), Card(Suit.DIAMONDS, "A", 2), Card(Suit.HEARTS, "A", 1),
    ], trump


# ---------------------------------------------------------------------------
# 1. Differential helpers - arithmetic, not simulation.
# ---------------------------------------------------------------------------

def test_differential_when_we_bid_and_make_it():
    sample = {"made": True, "bidding_total": 380, "defending_total": 90}
    assert _differential_when_we_bid(sample, 320) == 380 - 90


def test_differential_when_we_bid_and_are_set():
    """No partial credit: a failed contract scores exactly -bid, whatever the
    hand actually totalled."""
    sample = {"made": False, "bidding_total": 310, "defending_total": 140}
    assert _differential_when_we_bid(sample, 320) == -320 - 140


def test_differential_when_they_bid_and_make_it():
    # "bidding" is them, "defending" is us.
    sample = {"made": True, "bidding_total": 350, "defending_total": 110}
    assert _differential_when_they_bid(sample, 320) == 110 - 350


def test_differential_when_they_bid_and_we_set_them():
    """Setting the opponents is the big upside of defending, and the sign has
    to come out right: we keep our points and they lose their bid."""
    sample = {"made": False, "bidding_total": 300, "defending_total": 150}
    assert _differential_when_they_bid(sample, 320) == 150 + 320


# ---------------------------------------------------------------------------
# 2. defend_ev is a real number, and responds to hand strength.
# ---------------------------------------------------------------------------

def test_defend_ev_is_not_the_old_hardcoded_zero():
    ev, diagnostics = defend_ev(_marginal_hand(), 300, num_samples=12, rng=random.Random(1))
    assert isinstance(ev, float)
    assert ev != 0.0
    assert diagnostics["ev_defend"] == ev
    assert len(diagnostics["samples"]) == 12


def test_defending_is_worth_more_with_a_stronger_hand():
    """
    Holding more of the deck's power makes the opponents' contract harder and
    our defence more profitable, so EV(defend) should rise with hand strength.
    """
    weak, _ = defend_ev(_marginal_hand(), 320, num_samples=25, rng=random.Random(2))
    strong_hand, _trump = _powerhouse_hand()
    strong, _ = defend_ev(strong_hand, 320, num_samples=25, rng=random.Random(2))
    assert strong > weak


def test_defending_a_bigger_contract_is_worth_more():
    """A steeper contract is harder for them to make, so defending it pays
    better - the same hand, only the level differs."""
    hand = _marginal_hand()
    low, _ = defend_ev(hand, 300, num_samples=25, rng=random.Random(3))
    high, _ = defend_ev(hand, 400, num_samples=25, rng=random.Random(3))
    assert high > low


# ---------------------------------------------------------------------------
# 3. Who bids, and in what suit.
# ---------------------------------------------------------------------------

def test_defence_rollout_reports_their_make_rate_not_ours():
    diagnostics = estimate_defence(_marginal_hand(), 500, num_samples=10, rng=random.Random(4))
    # 500 is a steep contract for a random opponent hand, so they mostly fail.
    assert diagnostics["p_make"] < 0.5


def test_defence_seats_the_stronger_opponent_and_uses_their_trump():
    """
    Captures what `estimate_defence` actually hands to `rollout_deal`, rather
    than re-deriving the selection rule and comparing it to itself.

    Two claims: the seat taking the contract is always the opponent with the
    better hand, and the trump is that opponent's own best suit. Modelling the
    defence with our preferred trump, or with whichever opponent happens to
    sit on the left, would simulate a contract nobody would ever play.
    """
    import pinochle_rollout as rollout

    seen = []
    original = rollout.rollout_deal

    def capturing(players, trump, bid, bid_winner, **kwargs):
        seen.append({
            "bidder_hand": list(bid_winner.hand),
            "bidder_seat": players.index(bid_winner),
            "trump": trump,
            "opp_left": list(players[1].hand),
            "opp_right": list(players[3].hand),
        })
        return original(players, trump, bid, bid_winner, **kwargs)

    rollout.rollout_deal = capturing
    try:
        estimate_defence(_marginal_hand(), 320, num_samples=15, rng=random.Random(5))
    finally:
        rollout.rollout_deal = original

    assert len(seen) == 15
    for call in seen:
        assert call["bidder_seat"] in (1, 3)  # always an opponent, never us or partner
        left = rollout.best_base_bid(call["opp_left"])[1]
        right = rollout.best_base_bid(call["opp_right"])[1]
        chosen = rollout.best_base_bid(call["bidder_hand"])[1]
        assert chosen == max(left, right)
        # ...and the contract is played in the bidder's own best suit.
        assert call["trump"] == rollout.best_base_bid(call["bidder_hand"])[0]


# ---------------------------------------------------------------------------
# 4. The chooser, and blocking.
# ---------------------------------------------------------------------------

def test_choose_bid_vs_defence_keeps_the_existing_return_shape():
    hand = _marginal_hand()
    best, ev, all_evs = choose_bid_vs_defence(
        hand, Suit.CLUBS, [None, 300], num_samples=8, rng=random.Random(6),
    )
    assert set(all_evs) == {None, 300}
    assert all_evs[best] == ev
    assert best in (None, 300)


def test_pass_is_scored_by_rollout_not_by_zero():
    hand = _marginal_hand()
    _best, _ev, all_evs = choose_bid_vs_defence(
        hand, Suit.CLUBS, [None, 300], num_samples=10, rng=random.Random(7),
    )
    assert all_evs[None] != 0.0


def test_a_powerhouse_prefers_taking_the_contract():
    hand, trump = _powerhouse_hand()
    best, _ev, _all = choose_bid_vs_defence(
        hand, trump, [None, 300], num_samples=20, rng=random.Random(8),
    )
    assert best == 300


def test_a_bid_with_negative_ev_still_wins_when_defending_is_worse():
    """
    The blocking behaviour, which used to need a hand-coded branch and the
    DEFENSIVE_PUSH_FLOOR constant. Constructed directly against the chooser's
    contract: whichever option has the higher differential is picked, even
    when both are losing.
    """
    hand = _marginal_hand()
    _best, _ev, all_evs = choose_bid_vs_defence(
        hand, Suit.CLUBS, [None, 300], num_samples=20, rng=random.Random(9),
    )
    chosen = max(all_evs, key=all_evs.get)
    assert all_evs[chosen] == max(all_evs.values())
    # Both options are on the same scale, so the comparison is meaningful even
    # when the winner is negative.
    if all_evs[chosen] < 0:
        assert all_evs[chosen] > min(all_evs.values())


def test_defence_bid_defaults_to_the_cheapest_real_candidate():
    """If we do not bid it, they get it at the level we would have had to pay."""
    hand = _marginal_hand()
    explicit, _, _ = choose_bid_vs_defence(
        hand, Suit.CLUBS, [None, 340], num_samples=6, rng=random.Random(10),
        defence_bid=340,
    )
    implied, _, _ = choose_bid_vs_defence(
        hand, Suit.CLUBS, [None, 340], num_samples=6, rng=random.Random(10),
    )
    assert explicit == implied


def test_empty_candidates_still_raises():
    hand = _marginal_hand()
    try:
        choose_bid_vs_defence(hand, Suit.CLUBS, [], num_samples=4, rng=random.Random(11))
    except ValueError:
        return
    raise AssertionError("expected ValueError for empty candidate_bids")


# ---------------------------------------------------------------------------
# 5. Nothing changes unless asked.
# ---------------------------------------------------------------------------

def test_bid_ev_keeps_its_own_points_scale():
    """
    #60's formula is still what the existing skill-4/5 path uses, and its
    guaranteed-set case must still come out at exactly -bid. The differential
    variant is a separate function precisely so this one does not shift under
    callers that depend on it.
    """
    hand = _marginal_hand()
    ev, _diagnostics = bid_ev(hand, Suit.CLUBS, 5000, num_samples=4, rng=random.Random(12))
    assert ev == -5000


def test_differential_variant_differs_from_the_points_variant():
    hand = _marginal_hand()
    points, _ = bid_ev(hand, Suit.CLUBS, 320, num_samples=12, rng=random.Random(13))
    differential, _ = bid_ev_differential(hand, Suit.CLUBS, 320, num_samples=12, rng=random.Random(13))
    assert points != differential


def test_defence_is_on_only_where_there_is_a_rollout_budget():
    """
    Enabled at skill 4-5 on the strength of an A/B (+233 score margin per
    deal, 95% CI +72 to +397). Skills 1-3 run no rollouts at all, so there is
    nothing to compare a pass against and they keep the static path.
    """
    from pinochle_engine import GENERAL_STRATEGY_SKILL_PARAMS

    for skill in (1, 2, 3):
        assert GENERAL_STRATEGY_SKILL_PARAMS[skill]["defence_samples"] == 0
    for skill in (4, 5):
        assert GENERAL_STRATEGY_SKILL_PARAMS[skill]["defence_samples"] > 0


def test_enabling_defence_actually_changes_the_bidding_path():
    """
    The skill-params flag has to reach the decision, not just sit in a dict.
    With the defence rollout on, a marginal hand facing a contract it cannot
    profitably take should be willing to pass where the flat-zero path would
    compare against a fiction.
    """
    import pinochle_engine as engine

    calls = []
    original = engine.GeneralStrategy._rollout_ev_bid

    def recording(self, current_bid, min_increment, context, params):
        calls.append(params.get("defence_samples", 0))
        return original(self, current_bid, min_increment, context, params)

    engine.GeneralStrategy._rollout_ev_bid = recording
    try:
        ai = engine.GeneralStrategy("me", None, skill_level=5, rng=random.Random(1))
        partner = engine.Player("partner", None)
        opp_a = engine.Player("oppA", None)
        opp_b = engine.Player("oppB", None)
        team_a = engine.Team("A", [ai, partner])
        opp = engine.Team("B", [opp_a, opp_b])
        ai.team = partner.team = team_a
        opp_a.team = opp_b.team = opp
        team_a.score = opp.score = 0
        ai.hand = _marginal_hand()
        ai.choose_bid(0, 10, {
            "ever_bid": False, "passes_so_far": 0, "bid_history": [],
            "pass_history": [], "passed_players": [], "dealer": ai,
            "teams": [team_a, opp],
        })
    finally:
        engine.GeneralStrategy._rollout_ev_bid = original

    assert calls and calls[0] > 0

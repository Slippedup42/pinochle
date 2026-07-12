"""
Tests for issue #60 - bid-time simulated EV via the rollout sampler
(the `bid_ev` / `choose_bid_by_ev` additions to pinochle_rollout.py).
Plain assert-based, pytest-discoverable, matching test_rollout.py's
convention. Covers:

  1. `bid_ev` returns a float EV plus an `estimate_bid_time`-shaped
     diagnostics dict (with the extra `expected_points_if_made` key).
  2. EV is directionally sane: a hand with a strong trump run + double
     Pinochle (huge meld, strong trick-taking) has a much higher EV at a
     fixed bid level than a scattered, meld-free, trump-less hand - the
     doc's own acceptance criterion for this issue.
  3. The -P(fail) x bid tail of the formula: a bid set absurdly high
     (guaranteed Auto-SET on every sample, regardless of the random
     deal) has p_make == 0 and EV == exactly -bid, since no sample ever
     contributes to the "if made" average.
  4. `choose_bid_by_ev` picks the higher-EV candidate in constructed A/B
     comparisons, correctly folds in a `None` ("pass") candidate at EV
     0.0, and raises on an empty candidate list.

Real pass logic (`Player.choose_pass_cards` with trump_suit/is_bid_winner
supplied) and real trick-play logic (`choose_lead_card`/
`choose_follow_card`) are both deterministic given the dealt hands - the
only randomness in a rollout is the determinized deal itself, which is
drawn from the caller-supplied `rng`. So passing a seeded `random.Random`
makes these tests reproducible without needing large sample counts.
"""

import random

from pinochle_engine import Card, Suit
from pinochle_rollout import bid_ev, choose_bid_by_ev


# ---------------------------------------------------------------------------
# Constructed hands.
# ---------------------------------------------------------------------------

def _strong_hand():
    """
    Trump run (A/10/K/Q/J of Clubs) + Double Pinochle (2x QS, 2x JD) +
    an Ace of every other suit (bonus Aces Around, on top of already
    strong trick-taking power from the trump top cards). 12 cards, huge
    guaranteed meld (Run 150 + Double Pinochle 300 + Aces Around 100 =
    550) and excellent trick-taking (holds the top of the trump suit
    outright).
    """
    trump = Suit.CLUBS
    return [
        Card(trump, "A", 1), Card(trump, "10", 1), Card(trump, "K", 1),
        Card(trump, "Q", 1), Card(trump, "J", 1),
        Card(Suit.SPADES, "Q", 1), Card(Suit.SPADES, "Q", 2),
        Card(Suit.DIAMONDS, "J", 1), Card(Suit.DIAMONDS, "J", 2),
        Card(Suit.SPADES, "A", 1), Card(Suit.DIAMONDS, "A", 1), Card(Suit.HEARTS, "A", 1),
    ], trump


def _weak_hand(trump):
    """
    12 cards, zero trump (can never ruff), no marriages, no Pinochle, no
    Arounds - constructed to score exactly 0 meld under `trump` (Clubs)
    and hold little trick-taking power (only 2 Aces, everything else
    low/mid, nothing that can beat a trump lead).
    """
    assert trump == Suit.CLUBS
    return [
        Card(Suit.SPADES, "9", 1), Card(Suit.DIAMONDS, "9", 1), Card(Suit.HEARTS, "9", 1),
        Card(Suit.SPADES, "J", 1), Card(Suit.HEARTS, "J", 1),
        Card(Suit.HEARTS, "Q", 1),
        Card(Suit.SPADES, "K", 1), Card(Suit.DIAMONDS, "K", 1),
        Card(Suit.HEARTS, "A", 1), Card(Suit.SPADES, "A", 1),
        Card(Suit.DIAMONDS, "10", 1), Card(Suit.HEARTS, "10", 1),
    ]


# ---------------------------------------------------------------------------
# 1. bid_ev basic shape.
# ---------------------------------------------------------------------------

def test_bid_ev_returns_float_and_diagnostics():
    hand, trump = _strong_hand()
    ev, diagnostics = bid_ev(hand, trump, bid=300, num_samples=10, rng=random.Random(1))
    assert isinstance(ev, float)
    assert len(diagnostics["samples"]) == 10
    assert 0.0 <= diagnostics["p_make"] <= 1.0
    assert "expected_points_if_made" in diagnostics
    assert diagnostics["expected_points_if_made"] >= 0.0


# ---------------------------------------------------------------------------
# 2. Directional sanity: strong meld/trick hand beats scattered weak hand.
# ---------------------------------------------------------------------------

def test_bid_ev_strong_hand_beats_weak_hand_at_same_bid():
    strong_hand, trump = _strong_hand()
    weak_hand = _weak_hand(trump)
    bid = 300

    strong_ev, strong_diag = bid_ev(strong_hand, trump, bid, num_samples=30, rng=random.Random(11))
    weak_ev, weak_diag = bid_ev(weak_hand, trump, bid, num_samples=30, rng=random.Random(12))

    assert strong_ev > weak_ev, (strong_ev, weak_ev)
    # The strong hand's guaranteed meld alone (550) already clears the
    # bid, so it should make it essentially every sample; the weak,
    # trump-less, meld-free hand should struggle to reach 300 on trick
    # points alone.
    assert strong_diag["p_make"] > weak_diag["p_make"]


# ---------------------------------------------------------------------------
# 3. -P(fail) x bid tail: guaranteed Auto-SET on every sample.
# ---------------------------------------------------------------------------

def test_bid_ev_guaranteed_set_equals_negative_bid():
    # A weak hand can't conceivably reach a bid this absurdly high no
    # matter what partner/opponents are dealt (max any single hand can
    # meld is nowhere near 5000 - 250), so every sample is auto-set,
    # p_make is exactly 0, and EV collapses to exactly -bid (no sample
    # ever contributes to the "if made" average).
    trump = Suit.CLUBS
    weak_hand = _weak_hand(trump)
    bid = 5000

    ev, diagnostics = bid_ev(weak_hand, trump, bid, num_samples=15, rng=random.Random(21))

    assert diagnostics["p_make"] == 0.0
    assert diagnostics["auto_set_rate"] == 1.0
    assert diagnostics["expected_points_if_made"] == 0.0
    assert ev == -float(bid)


# ---------------------------------------------------------------------------
# 4. choose_bid_by_ev - picks the higher-EV candidate.
# ---------------------------------------------------------------------------

def test_choose_bid_by_ev_picks_higher_ev_candidate():
    strong_hand, trump = _strong_hand()
    # 300 is trivially covered by guaranteed meld alone; 5000 is a
    # guaranteed Auto-SET (see test above) regardless of hand strength.
    best_bid, best_ev, all_evs = choose_bid_by_ev(
        strong_hand, trump, candidate_bids=[300, 5000], num_samples=20, rng=random.Random(31),
    )
    assert best_bid == 300
    assert set(all_evs.keys()) == {300, 5000}
    assert all_evs[300] > all_evs[5000]
    assert best_ev == all_evs[300]


def test_choose_bid_by_ev_none_candidate_is_zero_ev_pass_option():
    trump = Suit.CLUBS
    weak_hand = _weak_hand(trump)
    # A weak, meld-free, trump-less hand bidding an absurdly high amount
    # is a guaranteed set (EV == -bid, deeply negative) - passing (EV
    # 0.0) should win over it.
    best_bid, best_ev, all_evs = choose_bid_by_ev(
        weak_hand, trump, candidate_bids=[5000, None], num_samples=10, rng=random.Random(41),
    )
    assert best_bid is None
    assert all_evs[None] == 0.0
    assert best_ev == 0.0


def test_choose_bid_by_ev_rejects_empty_candidates():
    strong_hand, trump = _strong_hand()
    try:
        choose_bid_by_ev(strong_hand, trump, candidate_bids=[], num_samples=5)
        assert False, "expected ValueError for empty candidate_bids"
    except ValueError:
        pass


if __name__ == "__main__":
    tests = [
        test_bid_ev_returns_float_and_diagnostics,
        test_bid_ev_strong_hand_beats_weak_hand_at_same_bid,
        test_bid_ev_guaranteed_set_equals_negative_bid,
        test_choose_bid_by_ev_picks_higher_ev_candidate,
        test_choose_bid_by_ev_none_candidate_is_zero_ev_pass_option,
        test_choose_bid_by_ev_rejects_empty_candidates,
    ]
    for t in tests:
        t()
        print(f"{t.__name__} passed")
    print(f"\n{len(tests)}/{len(tests)} test_bid_ev.py checks passed.")

"""
Tests for issue #255 - the third-bidder positional open gets a hand floor.

The rule under test: the seat that speaks after two passes with nobody having
bid used to open at OPENING_BID on *any* hand, to deny the last player a cheap
contract. Paul's house rule from live play is that a bid asserts a hand -
"assume anyone bidding has 320 or they should not bid" - so the hand's Max Bid
ceiling now has to reach OPENER_THRESHOLD before this seat opens.

What is covered here:

  1. A hand under the floor passes where it used to open, and a hand over it
     still opens - the floor is a floor, not a repeal of the rule.
  2. The floor is the ceiling against OPENER_THRESHOLD, asserted at the
     boundary rather than against a hand that is merely far from it.
  3. The consequence, recorded so it is not rediscovered as a bug: with the
     floor on, this tier gives the same answer as the normal opener for every
     hand. The positional rule was only ever the gap between the two.
"""

from pinochle_engine import (
    Card,
    OPENER_THRESHOLD,
    OPENING_BID,
    Player,
    Suit,
    Team,
    best_base_bid,
    max_bid,
)


# A trump Run plus a second Royal Marriage and an off-suit Ace: comfortably
# over OPENER_THRESHOLD.
STRONG_HAND = [
    Card(Suit.HEARTS, "A", 1),
    Card(Suit.HEARTS, "10", 1),
    Card(Suit.HEARTS, "K", 1),
    Card(Suit.HEARTS, "Q", 1),
    Card(Suit.HEARTS, "J", 1),
    Card(Suit.HEARTS, "K", 2),
    Card(Suit.HEARTS, "Q", 2),
    Card(Suit.SPADES, "A", 1),
]

# No meld, no Aces, nothing near a Run - the hand the old rule opened on.
JUNK_HAND = [
    Card(Suit.SPADES, "9", 1),
    Card(Suit.SPADES, "J", 1),
    Card(Suit.DIAMONDS, "9", 1),
    Card(Suit.DIAMONDS, "J", 2),
    Card(Suit.CLUBS, "9", 2),
    Card(Suit.HEARTS, "9", 1),
]


def _ceiling(hand, my_score=0, opp_score=0):
    trump, base, _ = best_base_bid(hand, my_score, opp_score)
    cap = max_bid(hand, trump)
    return base if cap is None else min(base, cap)


def _seat(hand, my_score=0, opp_score=0):
    """Four seats, two teams, level scores so #256's endgame rule is not what
    answers. Returns (me, dealer_seat)."""
    me = Player("Me", None)
    partner = Player("Partner", None)
    opp_a = Player("OppA", None)
    opp_b = Player("OppB", None)
    me.hand = list(hand)
    us = Team("Us", [me, partner])
    them = Team("Them", [opp_a, opp_b])
    me.team = partner.team = us
    opp_a.team = opp_b.team = them
    us.score = my_score
    them.score = opp_score
    return me, opp_b, [partner, opp_a]


def _bid_as_third(hand, my_score=0, opp_score=0):
    """This seat's turn with two passes behind it and nobody having bid: the
    partner (dealer + 1) and one opponent (dealer + 2) are out, this seat is
    dealer + 3, and the dealer has yet to speak."""
    me, dealer, passers = _seat(hand, my_score, opp_score)
    context = {
        "ever_bid": False,
        "passes_so_far": 2,
        "bid_history": [],
        "pass_history": [(p, OPENING_BID) for p in passers],
        "passed_players": list(passers),
        "dealer": dealer,
        "teams": [me.team, dealer.team],
    }
    return me.choose_bid(OPENING_BID - 10, 10, context)


def _bid_as_opener(hand, my_score=0, opp_score=0):
    """The same seat and hand as the first to speak, for the comparison in
    test 3."""
    me, dealer, _ = _seat(hand, my_score, opp_score)
    context = {
        "ever_bid": False,
        "passes_so_far": 0,
        "bid_history": [],
        "pass_history": [],
        "passed_players": [],
        "dealer": dealer,
        "teams": [me.team, dealer.team],
    }
    return me.choose_bid(OPENING_BID - 10, 10, context)


# ---------------------------------------------------------------------------
# 0. The fixtures sit either side of the floor.
# ---------------------------------------------------------------------------

def test_fixture_hands_sit_either_side_of_the_opener_threshold():
    assert _ceiling(STRONG_HAND) >= OPENER_THRESHOLD
    assert _ceiling(JUNK_HAND) < OPENER_THRESHOLD


# ---------------------------------------------------------------------------
# 1. The floor, both ways round.
# ---------------------------------------------------------------------------

def test_third_bidder_passes_a_hand_under_the_floor():
    # Before #255 this returned OPENING_BID on this hand, and on any hand.
    assert _bid_as_third(JUNK_HAND) is None


def test_third_bidder_still_opens_positionally_over_the_floor():
    assert _bid_as_third(STRONG_HAND) == OPENING_BID


def test_the_high_score_arm_is_the_same_rule_now():
    # The tier used to apply the floor only when my_score > 800. It applies it
    # always, so the two arms have stopped differing - which is why the sub-case
    # was removed rather than left sitting there agreeing with itself.
    assert _bid_as_third(JUNK_HAND, my_score=810, opp_score=600) is None
    assert _bid_as_third(STRONG_HAND, my_score=810, opp_score=600) == OPENING_BID


# ---------------------------------------------------------------------------
# 2. The floor is the ceiling against OPENER_THRESHOLD, at the boundary.
# ---------------------------------------------------------------------------

def test_the_floor_is_reached_not_cleared():
    # A trump Run and one off-suit Ace: ceiling exactly OPENER_THRESHOLD at
    # level scores. It opens, so the comparison is `>=` — matching the normal
    # opener and PARTNER_PASSED_FLOOR's "reach it, do not clear it" (#180).
    # One card less is a bare Run at 300, twenty under, and it passes.
    run = [Card(Suit.HEARTS, r, 1) for r in ("A", "10", "K", "Q", "J")]
    on_the_line = run + [Card(Suit.SPADES, "A", 1)]
    assert _ceiling(on_the_line) == OPENER_THRESHOLD
    assert _bid_as_third(on_the_line) == OPENING_BID
    assert _ceiling(run) < OPENER_THRESHOLD
    assert _bid_as_third(run) is None


# ---------------------------------------------------------------------------
# 3. The finding: floored, the tier says what the normal opener says.
# ---------------------------------------------------------------------------

def test_the_positional_tier_now_agrees_with_the_normal_opener():
    # Recorded rather than left implicit. If a future change wants the third
    # bidder to behave differently from a first bidder, it has to reintroduce a
    # difference on purpose - and this test is what will say so.
    for hand in (STRONG_HAND, JUNK_HAND):
        assert _bid_as_third(hand) == _bid_as_opener(hand)

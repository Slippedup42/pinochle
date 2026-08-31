"""
Tests for issue #255 - the third-bidder positional open gets a hand floor.

The rule under test: the seat that speaks after two passes with nobody having
bid opens at OPENING_BID to deny the last player a cheap contract. It used to
do that on *any* hand at all. It now needs a Max Bid ceiling that reaches
THIRD_BIDDER_FLOOR.

The floor is 200, not the house rule's 320, and that is a measured choice
rather than a compromise - see the constant's own comment for the two A/B
runs. These tests pin the consequences of that choice, because the number
looks like a candidate for tidying up to OPENER_THRESHOLD and is not one.

What is covered here:

  1. A hand under the floor passes where it used to open, and a hand over it
     still opens - the floor is a floor, not a repeal of the rule.
  2. The comparison is `>=` against the ceiling, checked at the tightest pair
     of hands the Base Bid grid actually reaches either side of 200.
  3. The rule still has content: a hand in the 200-320 band opens as third
     bidder and passes as first bidder. That difference *is* the positional
     rule, and it is what a 320 floor would have deleted.
"""

from pinochle_engine import (
    Card,
    OPENER_THRESHOLD,
    OPENING_BID,
    Player,
    Suit,
    THIRD_BIDDER_FLOOR,
    Team,
    best_base_bid,
    max_bid,
)


# A trump Run plus a second Royal Marriage and an off-suit Ace: ceiling 400,
# which is the MAX_BID_DEFAULT cap. It was 360 until #242 stopped the Run
# absorbing the Royal Marriage inside it; every hand holding a trump Run gained
# 40 there, which is why the fixture comments in this file are checked against
# the engine by test_fixture_hands_sit_where_the_tests_assume rather than
# trusted.
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

# No meld, no Aces, nothing near a Run - ceiling 140, the hand the old rule
# opened on and the one Paul saw at the table.
JUNK_HAND = [
    Card(Suit.SPADES, "9", 1),
    Card(Suit.SPADES, "J", 1),
    Card(Suit.DIAMONDS, "9", 1),
    Card(Suit.DIAMONDS, "J", 2),
    Card(Suit.CLUBS, "9", 2),
    Card(Suit.HEARTS, "9", 1),
]

# A Royal Marriage and two off-suit Aces: ceiling 210. Over THIRD_BIDDER_FLOOR
# and well under OPENER_THRESHOLD, so it is the hand the whole disagreement
# between 200 and 320 is about.
MIDDLING_HAND = [
    Card(Suit.HEARTS, "K", 1),
    Card(Suit.HEARTS, "Q", 1),
    Card(Suit.SPADES, "A", 1),
    Card(Suit.CLUBS, "A", 1),
]

# The same Royal Marriage with one Ace instead of two: ceiling 190, the
# nearest hand *below* the floor that the Base Bid grid reaches.
JUST_UNDER_HAND = [
    Card(Suit.HEARTS, "K", 1),
    Card(Suit.HEARTS, "Q", 1),
    Card(Suit.SPADES, "A", 1),
]


def _ceiling(hand, my_score=0, opp_score=0):
    trump, base, _ = best_base_bid(hand, my_score, opp_score)
    cap = max_bid(hand, trump)
    return base if cap is None else min(base, cap)


def _seat(hand, my_score=0, opp_score=0):
    """Four seats, two teams, level scores by default so #256's endgame rule
    is not what answers. Returns (me, dealer_seat, the two seats that pass)."""
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
    """The same seat and hand as the first to speak."""
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
# 0. The fixtures are where the rest of the file says they are.
# ---------------------------------------------------------------------------

def test_fixture_hands_sit_where_the_tests_assume():
    # Derived, not asserted against literals, and checked before anything else
    # in the file leans on them. #242 moved every hand holding a trump Run up
    # by 40 and would have quietly taken a band fixture out of its band.
    assert _ceiling(JUNK_HAND) < THIRD_BIDDER_FLOOR
    assert _ceiling(JUST_UNDER_HAND) < THIRD_BIDDER_FLOOR
    assert THIRD_BIDDER_FLOOR <= _ceiling(MIDDLING_HAND) < OPENER_THRESHOLD
    assert _ceiling(STRONG_HAND) >= OPENER_THRESHOLD


# ---------------------------------------------------------------------------
# 1. The floor, both ways round.
# ---------------------------------------------------------------------------

def test_third_bidder_passes_a_hand_under_the_floor():
    # Before #255 this returned OPENING_BID on this hand, and on any hand.
    assert _bid_as_third(JUNK_HAND) is None


def test_third_bidder_still_opens_positionally_over_the_floor():
    assert _bid_as_third(STRONG_HAND) == OPENING_BID
    assert _bid_as_third(MIDDLING_HAND) == OPENING_BID


def test_the_high_score_arm_is_gone():
    # The tier used to fall back to OPENER_THRESHOLD when my_score > 800. That
    # sub-case is removed: OPENER_THRESHOLD is not this rule's floor any more,
    # and a seat near the end of the game has #256's endgame protection in
    # front of it doing that job with thresholds chosen for it. So a middling
    # hand that opens at 0-0 also opens at 810, where it used to pass.
    # (810/600 is outside the endgame trigger - the opponents are not under
    # ENDGAME_OPP_SCORE_CAP - so this really is the third-bidder rule
    # answering.)
    assert _bid_as_third(MIDDLING_HAND, my_score=810, opp_score=600) == OPENING_BID
    assert _bid_as_third(JUNK_HAND, my_score=810, opp_score=600) is None


# ---------------------------------------------------------------------------
# 2. The comparison is `>=` on the ceiling, at the grid's tightest pair.
# ---------------------------------------------------------------------------

def test_the_floor_is_reached_not_cleared():
    # The Base Bid grid does not land on 200 exactly with any small hand - it
    # steps 190 -> 210 through this region - so the boundary is pinned with the
    # nearest hand either side rather than with an equality case that does not
    # exist. Reach-it-do-not-clear-it still matters as intent: it is the form
    # that was measured, and it matches the normal opener and #180's
    # PARTNER_PASSED_FLOOR.
    assert _ceiling(JUST_UNDER_HAND) < THIRD_BIDDER_FLOOR
    assert _bid_as_third(JUST_UNDER_HAND) is None
    assert _ceiling(MIDDLING_HAND) >= THIRD_BIDDER_FLOOR
    assert _bid_as_third(MIDDLING_HAND) == OPENING_BID


# ---------------------------------------------------------------------------
# 3. The rule still has content - which a 320 floor would have removed.
# ---------------------------------------------------------------------------

def test_the_positional_open_still_differs_from_the_normal_opener():
    # This is the whole rule, and the reason the floor is 200. In the
    # 200-320 band the third bidder opens and a first bidder does not: the
    # positional argument (deny the last seat a cheap contract, and keep the
    # auction off an opponent dealer at FORCED_BID) is doing the work.
    #
    # A floor at OPENER_THRESHOLD would make these two equal for every hand,
    # which is to say it would retire the rule - and the A/B on the constant
    # measured that at -57 points per deal.
    assert _bid_as_third(MIDDLING_HAND) == OPENING_BID
    assert _bid_as_opener(MIDDLING_HAND) is None
    # Either side of the band the two agree, as they should.
    assert _bid_as_third(JUNK_HAND) is None
    assert _bid_as_opener(JUNK_HAND) is None
    assert _bid_as_third(STRONG_HAND) == OPENING_BID
    assert _bid_as_opener(STRONG_HAND) == OPENING_BID

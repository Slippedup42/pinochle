"""
Tests for issue #256 - endgame protection in the auction. Plain assert-based,
pytest-discoverable.

The rule under test: a team within 250 of going out, against opponents more
than 550 away, passes the entire auction and banks its meld. The one exception
opens at OPENING_BID to keep a partner who is dealing off the forced bid, and
only on a hand whose Max Bid ceiling clears ENDGAME_RESCUE_CEILING.

What is covered here:

  1. The trigger boundaries, one point either side on both axes - 749/750 and
     449/450 - because the rule is a threshold effect and a threshold is
     exactly the kind of thing an off-by-one hides in.
  2. The default really is "pass everything", not "decline to open": the same
     seat with a hand worth a contract still passes when opening, over an
     opponent's bid, and over its partner's.
  3. Each of the exception's conditions failing on its own, so a test that
     goes green cannot be leaning on a second condition to do the work.
  4. The retired dealer-protection rule is actually gone - its own scores and
     a hand with nothing in it used to produce an opening bid.
"""

from pinochle_engine import (
    Card,
    ENDGAME_OPP_SCORE_CAP,
    ENDGAME_RESCUE_CEILING,
    ENDGAME_SCORE_FLOOR,
    GAME_WIN_SCORE,
    OPENING_BID,
    Player,
    Suit,
    Team,
    best_base_bid,
)


# A trump Run plus a second Royal Marriage and an off-suit Ace. Comfortably
# over ENDGAME_RESCUE_CEILING at any score, and over OPENER_THRESHOLD too, so
# "this seat passed" is never confusable with "this hand was not worth a bid".
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

# No meld, no Aces, nothing near a Run. Its ceiling is the competitive
# adjustment and nothing else, which is what puts it under the rescue floor.
JUNK_HAND = [
    Card(Suit.SPADES, "9", 1),
    Card(Suit.SPADES, "J", 1),
    Card(Suit.DIAMONDS, "9", 1),
    Card(Suit.DIAMONDS, "J", 2),
    Card(Suit.CLUBS, "9", 2),
    Card(Suit.HEARTS, "9", 1),
]


def _ceiling(hand, my_score, opp_score):
    """The same Max Bid ceiling `Player.choose_bid` computes, so the fixtures
    above can be asserted against the floor rather than assumed to sit where
    the comment says. One line since #283 removed the cap it used to apply."""
    _trump, ceiling, _ = best_base_bid(hand, my_score, opp_score)
    return ceiling


def _table(hand, my_score, opp_score):
    """Four seats, two teams, scores set. Returns (me, partner, opp_before,
    opp_after) where `opp_before` is the seat that speaks immediately before
    me when my partner is the dealer."""
    me = Player("Me", None)
    partner = Player("Partner", None)
    opp_before = Player("OppBefore", None)
    opp_after = Player("OppAfter", None)
    me.hand = list(hand)
    us = Team("Us", [me, partner])
    them = Team("Them", [opp_before, opp_after])
    me.team = partner.team = us
    opp_before.team = opp_after.team = them
    us.score = my_score
    them.score = opp_score
    return me, partner, opp_before, opp_after


def _context(dealer, teams, *, ever_bid=False, passes_so_far=0,
             bid_history=(), passed_players=()):
    return {
        "ever_bid": ever_bid,
        "passes_so_far": passes_so_far,
        "bid_history": list(bid_history),
        "pass_history": [(p, OPENING_BID) for p in passed_players],
        "passed_players": list(passed_players),
        "dealer": dealer,
        "teams": teams,
    }


def _opening_call(hand, my_score, opp_score, *, dealer_is_partner=True,
                  opponent_passed=True):
    """The partner-of-the-dealer seat's one turn: second to speak, after
    exactly one opponent."""
    me, partner, opp_before, opp_after = _table(hand, my_score, opp_score)
    dealer = partner if dealer_is_partner else opp_after
    context = _context(
        dealer,
        [me.team, opp_before.team],
        passes_so_far=1 if opponent_passed else 0,
        passed_players=[opp_before] if opponent_passed else [],
    )
    return me.choose_bid(OPENING_BID - 10, 10, context)


# ---------------------------------------------------------------------------
# 0. The fixtures are what the rest of the file assumes they are.
# ---------------------------------------------------------------------------

def test_fixture_hands_sit_either_side_of_the_rescue_floor():
    my_score, opp_score = ENDGAME_SCORE_FLOOR, 100
    assert _ceiling(STRONG_HAND, my_score, opp_score) > ENDGAME_RESCUE_CEILING
    assert _ceiling(JUNK_HAND, my_score, opp_score) <= ENDGAME_RESCUE_CEILING


def test_thresholds_are_derived_from_the_game_target():
    assert ENDGAME_SCORE_FLOOR == GAME_WIN_SCORE - 250
    assert ENDGAME_OPP_SCORE_CAP == GAME_WIN_SCORE - 550


# ---------------------------------------------------------------------------
# 1. Trigger boundaries.
# ---------------------------------------------------------------------------

def test_trigger_fires_at_the_score_floor_and_not_one_point_below():
    # Dealer is an opponent, so the exception cannot apply and the only thing
    # separating the two calls is the trigger itself.
    at_floor = _opening_call(STRONG_HAND, ENDGAME_SCORE_FLOOR, 100,
                             dealer_is_partner=False)
    below = _opening_call(STRONG_HAND, ENDGAME_SCORE_FLOOR - 1, 100,
                          dealer_is_partner=False)
    assert at_floor is None
    assert below == OPENING_BID


def test_trigger_fires_under_the_opponent_cap_and_not_at_it():
    under_cap = _opening_call(STRONG_HAND, ENDGAME_SCORE_FLOOR,
                              ENDGAME_OPP_SCORE_CAP - 1, dealer_is_partner=False)
    at_cap = _opening_call(STRONG_HAND, ENDGAME_SCORE_FLOOR,
                           ENDGAME_OPP_SCORE_CAP, dealer_is_partner=False)
    assert under_cap is None
    assert at_cap == OPENING_BID


# ---------------------------------------------------------------------------
# 2. The default is to pass the whole auction, not merely to decline to open.
# ---------------------------------------------------------------------------

def test_passes_when_opening_however_good_the_hand():
    assert _opening_call(STRONG_HAND, 910, 110, dealer_is_partner=False) is None


def test_passes_over_an_opponents_bid():
    me, _partner, opp_before, opp_after = _table(STRONG_HAND, 910, 110)
    context = _context(
        opp_after, [me.team, opp_before.team],
        ever_bid=True, bid_history=[(opp_before, 310)],
    )
    assert me.choose_bid(310, 10, context) is None


def test_passes_over_its_own_partners_bid():
    me, partner, opp_before, opp_after = _table(STRONG_HAND, 910, 110)
    context = _context(
        opp_after, [me.team, opp_before.team],
        ever_bid=True, bid_history=[(opp_before, 310), (partner, 320)],
    )
    assert me.choose_bid(320, 10, context) is None


def test_both_seats_of_the_team_pass_the_same_auction():
    # The rule is a property of the team, so the partner seat gets the strong
    # hand here and must pass on it too.
    me, partner, opp_before, opp_after = _table(JUNK_HAND, 910, 110)
    partner.hand = list(STRONG_HAND)
    context = _context(opp_after, [me.team, opp_before.team], passes_so_far=1,
                       passed_players=[opp_before])
    assert me.choose_bid(OPENING_BID - 10, 10, context) is None
    assert partner.choose_bid(OPENING_BID - 10, 10, context) is None


# ---------------------------------------------------------------------------
# 3. The exception, and each of its conditions failing on its own.
# ---------------------------------------------------------------------------

def test_opens_to_save_a_dealing_partner_when_all_three_conditions_hold():
    assert _opening_call(STRONG_HAND, 910, 110) == OPENING_BID


def test_no_rescue_when_the_dealer_is_an_opponent():
    assert _opening_call(STRONG_HAND, 910, 110, dealer_is_partner=False) is None


def test_no_rescue_when_no_opponent_has_passed_yet():
    assert _opening_call(STRONG_HAND, 910, 110, opponent_passed=False) is None


def test_no_rescue_on_a_hand_under_the_ceiling_floor():
    assert _opening_call(JUNK_HAND, 910, 110) is None


def test_no_rescue_once_an_opponent_has_bid():
    # "If the opponent bids 310, pass for both teammates with the high score."
    me, partner, opp_before, opp_after = _table(STRONG_HAND, 910, 110)
    context = _context(
        partner, [me.team, opp_before.team],
        ever_bid=True, bid_history=[(opp_before, 310)],
    )
    assert me.choose_bid(310, 10, context) is None


# ---------------------------------------------------------------------------
# 4. The retired dealer-protection rule.
# ---------------------------------------------------------------------------

def test_the_old_dealer_protection_scores_no_longer_open_on_nothing():
    # 850/400 with a partner dealing was an unconditional OPENING_BID before
    # #256, on any hand at all. It is inside the new trigger, so the hand floor
    # now applies and this one does not clear it.
    assert _opening_call(JUNK_HAND, 850, 400) is None


def test_outside_the_trigger_the_ordinary_rules_decide():
    # 850/500: the old rule fired here too. The opponent is not far enough
    # back for the new trigger, so a hopeless hand simply fails the opener
    # threshold instead of being talked into a bid.
    assert _opening_call(JUNK_HAND, 850, 500) is None
    assert _opening_call(STRONG_HAND, 850, 500) == OPENING_BID


if __name__ == "__main__":
    for fn in [
        test_fixture_hands_sit_either_side_of_the_rescue_floor,
        test_thresholds_are_derived_from_the_game_target,
        test_trigger_fires_at_the_score_floor_and_not_one_point_below,
        test_trigger_fires_under_the_opponent_cap_and_not_at_it,
        test_passes_when_opening_however_good_the_hand,
        test_passes_over_an_opponents_bid,
        test_passes_over_its_own_partners_bid,
        test_both_seats_of_the_team_pass_the_same_auction,
        test_opens_to_save_a_dealing_partner_when_all_three_conditions_hold,
        test_no_rescue_when_the_dealer_is_an_opponent,
        test_no_rescue_when_no_opponent_has_passed_yet,
        test_no_rescue_on_a_hand_under_the_ceiling_floor,
        test_no_rescue_once_an_opponent_has_bid,
        test_the_old_dealer_protection_scores_no_longer_open_on_nothing,
        test_outside_the_trigger_the_ordinary_rules_decide,
    ]:
        fn()
        print(f"  ok  {fn.__name__}")
    print("all endgame bidding tests passed")

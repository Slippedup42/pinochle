"""
Tests for issue #280 - Paul's rework of both pass priority lists, 2026-09-02.

The tiers themselves are stated in `_partner_pass_selection` and
`_bidder_pass_selection`; what is pinned here is the handful of orderings
that a later reader could plausibly "fix" back to what they were, plus the
three bidder tiers that were deleted on purpose and must not come back as
a bug fix.

Six things, in the order they matter:

  1. **The trump spread.** The substantive change. The bidder is building
     a Run, so a partner holding K-K-Q-J of trump sends K, Q and J and
     keeps the spare King - three ranks of the run instead of two copies
     of one. This is the acceptance test for the whole issue.
  2. Trump A/10/J now goes *before* trump K/Q, so a partner with enough
     trump can keep the royal marriage.
  3. The duplicates the spread declined are not lost: they come back at
     the leftover-trump tier, behind a side Ace and ahead of the dix.
  4. The partner's last tier is J, then 10, then Q, then K - increasing
     cost to give away - with the protected 10 (#276) held back behind
     the King.
  5. The bidder ships a spare K/Q before a non-trump 10 and before J/9
     filler; that tier moved from sixth to second.
  6. The bidder never sends an Ace back short of a hand with nothing
     unprotected in it, because the duplicate-AS/AD pro move is gone; and
     the low-trump last resort exists in Hearts/Clubs only.

`test_protected_tens.py` keeps the #276 cases proper. Run directly
(`python test_pass_priority.py`) or via pytest.
"""

from pinochle_engine import (
    Card,
    Suit,
    _bidder_pass_selection,
    _partner_pass_selection,
)


def C(suit, rank, copy_id=1):
    return Card(suit, rank, copy_id)


def _names(cards):
    return sorted(f"{c.rank}{c.suit.value}" for c in cards)


# ---------------------------------------------------------------------------
# Partner -> bidder.
# ---------------------------------------------------------------------------

def test_partner_trump_tiers_send_a_spread_not_duplicates():
    """The acceptance test for #280. K-K-Q-J of trump sends K, Q, J.

    Paul: "do not send KKQ of trump if you have other trump J or better.
    The goal is for a Run so you want to send a spread." The second King
    fills no slot of the bidder's run that the first one has not already
    filled, while the Jack fills one nothing else can.
    """
    hand = [
        C(Suit.HEARTS, "K"), C(Suit.HEARTS, "K", 2), C(Suit.HEARTS, "Q"),
        C(Suit.HEARTS, "J"),
        C(Suit.SPADES, "A"), C(Suit.SPADES, "10"), C(Suit.SPADES, "K"),
        C(Suit.CLUBS, "Q"), C(Suit.CLUBS, "J"), C(Suit.CLUBS, "9"),
        C(Suit.DIAMONDS, "10"), C(Suit.DIAMONDS, "9"),
    ]
    chosen = _partner_pass_selection(hand, Suit.HEARTS, "HC", 3)
    assert _names(chosen) == ["JH", "KH", "QH"], _names(chosen)
    assert sum(1 for c in chosen if c.rank == "K") == 1, "the spare King stays home"


def test_partner_sends_trump_a_ten_jack_before_the_royal_marriage():
    """Paul: "really if you have enough Trump you might keep the Royal
    Marriage." Three slots are gone before the K/Q tier is reached, and
    the A, 10 and J fill the run's other ranks without breaking a pair
    this hand can still score."""
    hand = [
        C(Suit.CLUBS, "A"), C(Suit.CLUBS, "10"), C(Suit.CLUBS, "J"),
        C(Suit.CLUBS, "K"), C(Suit.CLUBS, "Q"),
        C(Suit.SPADES, "A"), C(Suit.SPADES, "K"), C(Suit.SPADES, "9"),
        C(Suit.HEARTS, "10"), C(Suit.HEARTS, "9"),
        C(Suit.DIAMONDS, "K"), C(Suit.DIAMONDS, "J"),
    ]
    chosen = _partner_pass_selection(hand, Suit.CLUBS, "HC", 3)
    assert _names(chosen) == ["10C", "AC", "JC"], _names(chosen)


def test_partner_picks_the_declined_duplicate_up_after_a_side_ace():
    """The spread is a deferral, not a discard. With one trump King sent,
    the second one waits behind the side Ace and ahead of the dix - which
    scores its 10 for the team wherever it sits."""
    hand = [
        C(Suit.HEARTS, "K"), C(Suit.HEARTS, "K", 2), C(Suit.HEARTS, "9"),
        C(Suit.SPADES, "A"),
        C(Suit.CLUBS, "Q"), C(Suit.CLUBS, "J"), C(Suit.CLUBS, "10"),
        C(Suit.DIAMONDS, "K"), C(Suit.DIAMONDS, "Q"), C(Suit.DIAMONDS, "J"),
        C(Suit.DIAMONDS, "10"), C(Suit.DIAMONDS, "9"),
    ]
    chosen = _partner_pass_selection(hand, Suit.HEARTS, "HC", 3)
    assert _names(chosen) == ["AS", "KH", "KH"], _names(chosen)
    assert "9H" not in _names(chosen), "the dix outranks nothing worth sending"


def test_partner_last_tier_goes_jack_ten_queen_king():
    """Increasing cost to give away. Paul: "You do not want to pass points,
    10 and K, and K are even worse because they make marriages, this is
    also why keeping a Q is better." A Jack is neither counter nor marriage
    card; a 10 is a counter; a Queen carries a marriage; a King is both."""
    hand = [
        C(Suit.CLUBS, "K"), C(Suit.CLUBS, "Q"), C(Suit.CLUBS, "10"),
        C(Suit.CLUBS, "J"),
    ]
    chosen = _partner_pass_selection(hand, Suit.HEARTS, "HC", 3)
    assert _names(chosen) == ["10C", "JC", "QC"], _names(chosen)
    assert "KC" not in _names(chosen), "the King is the last thing to go"


def test_partner_last_tier_holds_a_protected_ten_behind_the_king():
    """A reading of #280 rather than something Paul stated, flagged in the
    PR so it is easy to reverse: within the last tier a 10 with both Aces
    of its suit behind it (#276) sorts *behind* the King rather than with
    the ordinary 10s.

    The hand is trimmed to the six cards that make the point - a bigger one
    reaches the void tier, which does not consult the protected-10 rule and
    would ship the whole club suit before this tier ran at all.
    """
    hand = [
        C(Suit.CLUBS, "A"), C(Suit.CLUBS, "A", 2), C(Suit.CLUBS, "10"),
        C(Suit.CLUBS, "K"), C(Suit.CLUBS, "Q"), C(Suit.HEARTS, "9"),
    ]
    chosen = _partner_pass_selection(hand, Suit.HEARTS, "HC", 5)
    assert _names(chosen) == ["9H", "AC", "AC", "KC", "QC"], _names(chosen)
    assert "10C" not in _names(chosen), "the King goes before the protected 10"


# ---------------------------------------------------------------------------
# Bidder -> partner.
# ---------------------------------------------------------------------------

def test_bidder_ships_a_spare_king_before_tens_and_filler():
    """The spare K/Q tier moved from sixth to second. A King or Queen in no
    marriage and no around scores nothing in this hand, and the partner may
    hold the card that marries it - so it goes ahead of the non-trump 10s
    and ahead of the J/9 rags, which is the reverse of the old list."""
    hand = [
        C(Suit.SPADES, "A"), C(Suit.SPADES, "10"), C(Suit.SPADES, "K"),
        C(Suit.SPADES, "Q"),
        C(Suit.HEARTS, "A"), C(Suit.HEARTS, "K"),
        C(Suit.CLUBS, "A"), C(Suit.CLUBS, "10"), C(Suit.CLUBS, "J"),
        C(Suit.DIAMONDS, "A"), C(Suit.DIAMONDS, "10"), C(Suit.DIAMONDS, "9"),
    ]
    chosen = _bidder_pass_selection(hand, Suit.SPADES, "DS", 3)
    assert _names(chosen) == ["10C", "10D", "KH"], _names(chosen)


def test_bidder_never_returns_an_ace_while_anything_else_is_free():
    """The duplicate-AS/AD pro move was the only route by which an Ace was
    ever sent back, and #280 deleted it on purpose - Paul: "I took them out
    on purpose. I want to see the play before I add pro moves." This hand
    has no J/9 filler and no non-trump 10, which is exactly where that tier
    used to fire; the pair of Aces now stays."""
    hand = [
        C(Suit.SPADES, "10"), C(Suit.SPADES, "K"), C(Suit.SPADES, "Q"),
        C(Suit.SPADES, "J"),
        C(Suit.DIAMONDS, "A"), C(Suit.DIAMONDS, "A", 2),
        C(Suit.HEARTS, "K"), C(Suit.HEARTS, "Q"), C(Suit.HEARTS, "A"),
        C(Suit.CLUBS, "K"), C(Suit.CLUBS, "Q"), C(Suit.CLUBS, "A"),
    ]
    chosen = _bidder_pass_selection(hand, Suit.SPADES, "DS", 3)
    assert not any(c.rank == "A" for c in chosen), _names(chosen)


def test_bidder_sends_qs_jd_unconditionally_in_hearts_or_clubs():
    """The Queens-Around-plus-pinochle-plus-a-run-card exception is gone,
    deliberately. In Hearts or Clubs the pinochle cards are worth more to
    the partner's meld than to a hand that cannot use them as trump."""
    hand = [
        C(Suit.HEARTS, "Q"), C(Suit.SPADES, "Q"), C(Suit.DIAMONDS, "Q"),
        C(Suit.CLUBS, "Q"), C(Suit.DIAMONDS, "J"), C(Suit.CLUBS, "9"),
    ]
    chosen = _bidder_pass_selection(hand, Suit.HEARTS, "HC", 1)
    assert _names(chosen) == ["QS"], _names(chosen)


def test_bidder_sheds_low_trump_only_in_hearts_or_clubs():
    """The last-resort tier, for the degenerate all-trump hand where there
    is nothing safe left to send. In Hearts or Clubs the trump J and 9 are
    the cheapest things in it; in Spades or Diamonds those same two cards
    can be a pinochle card or sit in the run, so that hand skips the tier
    and falls through to the flat take-anything one, shedding in hand
    order."""
    def whole_suit(suit):
        return [C(suit, rank, copy)
                for rank in ("A", "10", "K", "Q", "J", "9")
                for copy in (1, 2)]

    chosen = _bidder_pass_selection(whole_suit(Suit.HEARTS), Suit.HEARTS, "HC", 3)
    assert _names(chosen) == ["9H", "JH", "JH"], _names(chosen)

    chosen = _bidder_pass_selection(whole_suit(Suit.SPADES), Suit.SPADES, "DS", 3)
    assert _names(chosen) == ["10S", "AS", "AS"], _names(chosen)


if __name__ == "__main__":
    tests = [obj for name, obj in list(globals().items())
             if name.startswith("test_") and callable(obj)]
    for t in tests:
        t()
        print(f"OK: {t.__name__}")
    print(f"\n{len(tests)} tests passed.")

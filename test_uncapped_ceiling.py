"""
The bid ceiling has no ceiling (#283).

`max_bid` used to stop every hand at MAX_BID_DEFAULT = 400 unless its
*guaranteed* meld (`score_melds`, not the speculative Base Bid) cleared
MAX_BID_MELD_THRESHOLD = 300, and `capped_bid` clamped the valuation to
whatever came back. Both functions and both constants are gone; `compute_max_bid`
is the ceiling and `best_base_bid` returns it unchanged.

Two hand shapes are worth pinning separately, because they were on opposite
sides of the old exemption and only one of them was ever actually stopped.

A Double Run melds 1500 and so already cleared the >300 exemption - the cap
never bound it. It is pinned here anyway because it is the shape the decision
was made for and the one a later reader will reach for: 1500 is more than the
whole game, but the run only exists if this hand names trump, so the hand has
to be able to keep bidding until it wins the auction.

The hands the cap really bound are the ordinary ones - a Run, a marriage or
two, some length - whose speculative valuation runs past 400 while their
guaranteed meld sits nowhere near 300. Since #277 a quarter of all dealt hands
were pinned at 400 and therefore indistinguishable from each other, which is
the second test here and the one the measurement in #283 is about.
"""

from pinochle_engine import (
    Card,
    Suit,
    best_base_bid,
    compute_max_bid,
    score_melds,
)


def _double_run(trump=Suit.HEARTS):
    """Both copies of A-10-K-Q-J in `trump`, plus two worthless off-suit cards."""
    return [Card(trump, r, copy) for r in ("A", "10", "K", "Q", "J") for copy in (1, 2)] + [
        Card(Suit.SPADES, "9", 1),
        Card(Suit.CLUBS, "9", 1),
    ]


def test_a_double_run_hand_has_no_ceiling():
    hand = _double_run()
    double_run_meld, _ = score_melds(hand, Suit.HEARTS)
    assert double_run_meld == 1500

    trump, ceiling, _ = best_base_bid(hand)
    assert trump is Suit.HEARTS
    # Asserted against the meld rather than against a literal, because the
    # ceiling is a sum of three stages that have each moved under this
    # repository's tests before and the property is what matters: this hand can
    # bid past anything an opponent can put on the table.
    assert ceiling >= double_run_meld
    assert ceiling == compute_max_bid(hand, Suit.HEARTS)[0]


def test_an_ordinary_hand_worth_over_400_may_say_so():
    # A trump Run, a second Royal Marriage and an off-suit Ace: 440. Its
    # guaranteed meld is nowhere near the 300 the old exemption wanted, so this
    # is precisely the hand the cap used to bind - worth 440 and allowed to say
    # 400.
    hand = [
        Card(Suit.HEARTS, "A", 1),
        Card(Suit.HEARTS, "10", 1),
        Card(Suit.HEARTS, "K", 1),
        Card(Suit.HEARTS, "Q", 1),
        Card(Suit.HEARTS, "J", 1),
        Card(Suit.HEARTS, "K", 2),
        Card(Suit.HEARTS, "Q", 2),
        Card(Suit.SPADES, "A", 1),
    ]
    actual_meld, _ = score_melds(hand, Suit.HEARTS)
    assert actual_meld < 300

    trump, ceiling, _ = best_base_bid(hand)
    assert ceiling > 400
    assert ceiling == compute_max_bid(hand, trump)[0]


def test_best_base_bid_returns_the_valuation_untouched_for_every_trump():
    hand = _double_run(Suit.SPADES)
    trump, ceiling, _ = best_base_bid(hand)
    per_suit = {t: compute_max_bid(hand, t)[0] for t in Suit}
    # Nothing is clamped, so the suit named is the argmax of the raw valuation
    # rather than the first suit that happened to reach a cap. Under the cap
    # both of these came back as 400 for a hand like this and the tie went to
    # whichever suit `Suit` iterates first.
    assert ceiling == max(per_suit.values())
    assert per_suit[trump] == ceiling

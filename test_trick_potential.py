"""
Tests for issue #277 - the restructured bid valuation. Plain assert-based,
pytest-discoverable, matching the other test modules.

Paul's specification, 2026-09-02. The valuation is three stages now, and each
one answers a different question about the same twelve cards:

    compute_base_bid                what will this hand meld?
    compute_trick_potential         what will it take in tricks?   (new)
    compute_competitive_adjustment  what is the scoreboard asking for?

`compute_max_bid` sums them. What moved:

  * The flat Ace line left the Base Bid for the middle stage, unchanged at 20
    an Ace - only its home moved.
  * The "3 different Aces" bonus (60 with hearts or clubs trump, 50 otherwise)
    is deleted. No rule of pinochle makes three Aces worth more when hearts
    are trump than when spades are.
  * A hand holding a pinochle and no King of Spades at all gains 20, once.
  * The middle stage is six additive lines: every Ace at 20, every Ace *of
    trump* at another 20 on top, every trump card past the fourth at 20, every
    non-trump 10 standing behind both Aces of its suit at 20, every unmarried
    non-trump King at 30 and every unmarried non-trump Queen at 20.

Each rule is pinned on its own below rather than through a total, because a
total is exactly what a wrong rule can hide inside. The two readings Paul
recorded that a reader would otherwise have to guess at - a trump Ace collects
both Ace lines, and "unmarried" is a property of the suit rather than of the
card - get a test each and say so in as many words.
"""

from pinochle_engine import (
    ACE_VALUE,
    Card,
    DIX_VALUE,
    EXTRA_TRUMP_VALUE,
    LOOSE_KING_VALUE,
    LOOSE_QUEEN_VALUE,
    NEAR_RUN_VALUE,
    PINOCHLE_DOUBLE_VALUE,
    PINOCHLE_NO_KING_OF_SPADES_BONUS,
    PINOCHLE_SINGLE_VALUE,
    PROTECTED_TEN_VALUE,
    Suit,
    TRUMP_ACE_VALUE,
    compute_base_bid,
    compute_max_bid,
    compute_trick_potential,
)


TRUMP = Suit.HEARTS
OFF = Suit.CLUBS
OFF2 = Suit.DIAMONDS


def hand(*specs):
    """`hand(("A", Suit.CLUBS), ...)`, allocating copy ids as cards repeat."""
    seen, cards = {}, []
    for rank, suit in specs:
        key = (suit, rank)
        seen[key] = seen.get(key, 0) + 1
        assert seen[key] <= 2, f"only two copies of {rank}{suit} exist"
        cards.append(Card(suit, rank, seen[key]))
    return cards


# ---------------------------------------------------------------------------
# The Ace lines.
# ---------------------------------------------------------------------------

def test_every_ace_is_worth_twenty_wherever_it_sits():
    aces = hand(("A", OFF), ("A", OFF), ("A", OFF2))
    total, breakdown = compute_trick_potential(aces, TRUMP)
    assert breakdown["Aces (flat, 20/ea)"] == 3 * ACE_VALUE
    assert total == 3 * ACE_VALUE


def test_an_ace_of_trump_collects_both_ace_lines_and_is_worth_forty():
    """Paul's recorded reading, and it follows from his keeping the two lines
    separate: the card is a certain trick like any Ace *and* the card that
    controls the trump suit. Both copies count."""
    one = hand(("A", TRUMP))
    total, breakdown = compute_trick_potential(one, TRUMP)
    assert breakdown["Aces (flat, 20/ea)"] == ACE_VALUE
    assert breakdown["Ace of trump"] == TRUMP_ACE_VALUE
    assert total == ACE_VALUE + TRUMP_ACE_VALUE

    both = hand(("A", TRUMP), ("A", TRUMP))
    assert compute_trick_potential(both, TRUMP)[0] == 2 * (ACE_VALUE + TRUMP_ACE_VALUE)

    # The same Ace in a suit that is not trump is worth half as much.
    assert compute_trick_potential(hand(("A", OFF)), TRUMP)[0] == ACE_VALUE


# ---------------------------------------------------------------------------
# Trump length.
# ---------------------------------------------------------------------------

def test_trump_pays_only_beyond_the_fourth_card():
    four = hand(("9", TRUMP), ("9", TRUMP), ("J", TRUMP), ("J", TRUMP))
    assert "Trump length (beyond 4)" not in compute_trick_potential(four, TRUMP)[1]

    six = four + hand(("K", TRUMP), ("Q", TRUMP))
    total, breakdown = compute_trick_potential(six, TRUMP)
    assert breakdown["Trump length (beyond 4)"] == 2 * EXTRA_TRUMP_VALUE
    # The trump K+Q is a Royal Marriage, priced in the Base Bid, so the two
    # extra trump are the whole of what this stage pays for that hand.
    assert total == 2 * EXTRA_TRUMP_VALUE


# ---------------------------------------------------------------------------
# The protected 10 - #276's pass rule, given a price.
# ---------------------------------------------------------------------------

def test_a_ten_behind_both_aces_of_its_suit_is_worth_twenty():
    both = hand(("A", OFF), ("A", OFF), ("10", OFF))
    assert compute_trick_potential(both, TRUMP)[1]["10 behind both Aces"] == PROTECTED_TEN_VALUE


def test_a_ten_behind_one_ace_is_not_protected():
    """Deliberately narrow, per #276: a 10 behind a single Ace is only
    partially protected and Paul did not rule on it."""
    one = hand(("A", OFF), ("10", OFF))
    assert "10 behind both Aces" not in compute_trick_potential(one, TRUMP)[1]


def test_a_trump_ten_is_a_run_card_and_is_not_paid_here():
    trump_ten = hand(("A", TRUMP), ("A", TRUMP), ("10", TRUMP))
    assert "10 behind both Aces" not in compute_trick_potential(trump_ten, TRUMP)[1]


def test_both_tens_of_a_protected_suit_are_paid():
    """A-A-10-10 cashes all four cards if the suit is played out last, so the
    line is counted per card, which is also what reusing `_is_protected_ten`
    unchanged gives. Recorded because "the 10 of any suit" could be read as
    once per suit."""
    pair = hand(("A", OFF), ("A", OFF), ("10", OFF), ("10", OFF))
    assert compute_trick_potential(pair, TRUMP)[1]["10 behind both Aces"] == 2 * PROTECTED_TEN_VALUE


def test_the_valuation_and_the_pass_read_one_predicate():
    """The two halves of Paul's ruling must not be able to disagree about which
    10s they mean, so they share `_is_protected_ten` rather than each carrying
    a copy. This asserts the coupling directly."""
    from pinochle_engine import _is_protected_ten

    cards = hand(("A", OFF), ("A", OFF), ("10", OFF), ("10", OFF2), ("A", OFF2))
    protected = [c for c in cards if _is_protected_ten(cards, TRUMP, c)]
    paid = compute_trick_potential(cards, TRUMP)[1].get("10 behind both Aces", 0)
    assert paid == len(protected) * PROTECTED_TEN_VALUE


# ---------------------------------------------------------------------------
# Unmarried honours.
# ---------------------------------------------------------------------------

def test_an_unmarried_king_pays_thirty_and_an_unmarried_queen_twenty():
    loose = hand(("K", OFF), ("Q", OFF2))
    total, breakdown = compute_trick_potential(loose, TRUMP)
    assert breakdown["Unmarried Kings"] == LOOSE_KING_VALUE
    assert breakdown["Unmarried Queens"] == LOOSE_QUEEN_VALUE
    assert total == LOOSE_KING_VALUE + LOOSE_QUEEN_VALUE


def test_a_married_king_and_queen_pay_nothing_here():
    """The Common Marriage line in the Base Bid has already paid for them."""
    married = hand(("K", OFF), ("Q", OFF))
    assert compute_trick_potential(married, TRUMP)[0] == 0
    assert compute_base_bid(married, TRUMP)[0] == 20


def test_trump_honours_are_excluded():
    """The Run and Royal Marriage lines price the trump King and Queen, so
    paying them again here would be paying twice for one card."""
    trump_honours = hand(("K", TRUMP), ("Q", TRUMP))
    assert compute_trick_potential(trump_honours, TRUMP)[0] == 0

    # A lone trump King has no Royal Marriage to be priced by either, and is
    # deliberately worth nothing: the exclusion is by suit, not by whether the
    # Base Bid actually paid. Recorded as behaviour rather than endorsed - see
    # #277's PR, which reports it.
    assert compute_trick_potential(hand(("K", TRUMP)), TRUMP)[0] == 0
    assert compute_trick_potential(hand(("K", OFF)), TRUMP)[0] == LOOSE_KING_VALUE


def test_unmarried_is_a_property_of_the_suit_not_of_the_card():
    """Paul defined "not part of a marriage" as "no matching Q/K in the same
    suit", which is a test on the suit. So K-K-Q pays the Common Marriage and
    nothing here - the spare King has a Queen behind it. The other reading,
    counting the surplus honour, would pay 30, and this is the only shape where
    the two differ."""
    spare = hand(("K", OFF), ("K", OFF), ("Q", OFF))
    assert compute_trick_potential(spare, TRUMP)[0] == 0

    # Two Kings and no Queen at all: both are loose, and both are paid.
    two_kings = hand(("K", OFF), ("K", OFF))
    assert compute_trick_potential(two_kings, TRUMP)[0] == 2 * LOOSE_KING_VALUE


def test_a_line_that_does_not_fire_is_absent_rather_than_zero():
    assert compute_trick_potential(hand(("9", OFF)), TRUMP) == (0, {})


# ---------------------------------------------------------------------------
# The Base Bid's own two changes.
# ---------------------------------------------------------------------------

def test_the_base_bid_no_longer_carries_an_ace_line():
    """Aces moved out of stage 1 entirely; the Base Bid is meld only now."""
    aces = hand(("A", OFF), ("A", OFF2))
    total, breakdown, _pool = compute_base_bid(aces, TRUMP)
    assert "Aces (flat, 20/ea)" not in breakdown
    assert total == 0


def test_the_three_different_aces_bonus_is_gone():
    """It paid 60 with hearts or clubs trump and 50 otherwise. Nothing in the
    rules makes three Aces worth more in one trump than another, and the
    asymmetry was never explained anywhere in the repo."""
    three = hand(("A", Suit.DIAMONDS), ("A", Suit.CLUBS), ("A", Suit.HEARTS))
    for trump in Suit:
        total, breakdown, _pool = compute_base_bid(three, trump)
        assert "3 different Aces bonus" not in breakdown
        assert total == 0

    # And two Aces in suits that are trump in neither reading are now worth the
    # same in both, which is what the asymmetry denied.
    two_off = hand(("A", Suit.DIAMONDS), ("A", Suit.CLUBS))
    assert (compute_trick_potential(two_off, Suit.SPADES)[0]
            == compute_trick_potential(two_off, Suit.HEARTS)[0])


def test_a_pinochle_with_no_king_of_spades_is_worth_twenty_more():
    """Paul's reasoning: a Queen of Spades that no spade marriage is asking for
    is a freer pinochle card."""
    single = hand(("Q", Suit.SPADES), ("J", Suit.DIAMONDS))
    total, breakdown, _pool = compute_base_bid(single, TRUMP)
    assert breakdown["Pinochle/near-double"] == PINOCHLE_SINGLE_VALUE
    assert breakdown["Pinochle (no King of Spades)"] == PINOCHLE_NO_KING_OF_SPADES_BONUS
    assert total == PINOCHLE_SINGLE_VALUE + PINOCHLE_NO_KING_OF_SPADES_BONUS


def test_the_no_king_of_spades_bonus_is_paid_once_and_never_per_copy():
    """Explicitly ruled: a double pinochle with no K(S) adds 20 and not 40. The
    reason is about the absent King, and there is only one absence however many
    Queens sit behind it."""
    double = hand(("Q", Suit.SPADES), ("Q", Suit.SPADES),
                  ("J", Suit.DIAMONDS), ("J", Suit.DIAMONDS))
    total, breakdown, _pool = compute_base_bid(double, TRUMP)
    assert breakdown["Pinochle/near-double"] == PINOCHLE_DOUBLE_VALUE
    assert breakdown["Pinochle (no King of Spades)"] == PINOCHLE_NO_KING_OF_SPADES_BONUS
    assert total == PINOCHLE_DOUBLE_VALUE + PINOCHLE_NO_KING_OF_SPADES_BONUS


def test_one_king_of_spades_anywhere_in_the_hand_cancels_the_bonus():
    with_king = hand(("Q", Suit.SPADES), ("J", Suit.DIAMONDS), ("K", Suit.SPADES))
    _total, breakdown, _pool = compute_base_bid(with_king, TRUMP)
    assert "Pinochle (no King of Spades)" not in breakdown


def test_the_bonus_needs_a_pinochle_to_hang_on():
    """It is written under the Pinochle heading, so no pinochle, no bonus -
    however many lone Queens of Spades are sitting there."""
    no_pinochle = hand(("Q", Suit.SPADES), ("Q", Suit.SPADES))
    _total, breakdown, _pool = compute_base_bid(no_pinochle, TRUMP)
    assert "Pinochle (no King of Spades)" not in breakdown

    # The near-double branch does hold a pinochle - three of the four pieces
    # cannot be reached without one of each - so it does earn the bonus.
    near_double = hand(("Q", Suit.SPADES), ("Q", Suit.SPADES), ("J", Suit.DIAMONDS))
    _total, breakdown, _pool = compute_base_bid(near_double, TRUMP)
    assert breakdown["Pinochle (no King of Spades)"] == PINOCHLE_NO_KING_OF_SPADES_BONUS


# ---------------------------------------------------------------------------
# The three stages together.
# ---------------------------------------------------------------------------

def test_compute_max_bid_sums_all_three_stages():
    """One worked hand, so the wiring is pinned and not only the pieces: a
    near-run in trump with its Dix. 120 + 10 of Base Bid; the trump Ace at 40
    and one trump past the fourth at 20 of trick potential; + the 130 baseline
    adjustment = 320."""
    near_run = hand(("A", TRUMP), ("K", TRUMP), ("Q", TRUMP), ("J", TRUMP), ("9", TRUMP))
    base, _b, _pool = compute_base_bid(near_run, TRUMP)
    trick, _t = compute_trick_potential(near_run, TRUMP)
    total, breakdown = compute_max_bid(near_run, TRUMP)

    assert base == NEAR_RUN_VALUE + DIX_VALUE
    assert trick == ACE_VALUE + TRUMP_ACE_VALUE + EXTRA_TRUMP_VALUE
    assert total == base + trick + 130
    assert total == 320

    # And the breakdown carries every stage's lines rather than the last one's.
    assert breakdown["Run/near-run"] == NEAR_RUN_VALUE
    assert breakdown["Ace of trump"] == TRUMP_ACE_VALUE
    assert breakdown["Competitive adj (baseline)"] == 130


def test_the_competitive_adjustment_is_untouched():
    """#277 left stage 2 exactly as it was, deliberately and on Paul's answer
    to a direct question. Pinned here so a later change to the valuation cannot
    quietly compensate through it."""
    from pinochle_engine import compute_competitive_adjustment

    empty = []
    assert compute_competitive_adjustment(empty, TRUMP)[0] == 130
    assert compute_competitive_adjustment(empty, TRUMP, 0, 600)[0] == 160
    assert compute_competitive_adjustment(empty, TRUMP, 700, 500)[0] == 100

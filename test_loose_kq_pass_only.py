"""
Issue #326: the off-by-default `LOOSE_KQ_PASS_ONLY` reading of Paul's written
valuation (`pinochle_valuation.md`): "for every K or Q that is not a marriage
*and you will pass* - 20".

With the flag on, an unmarried non-trump K/Q is worth LOOSE_KQ_PASSED_VALUE
when the bid winner's own return pass (`_bidder_pass_selection` on the dealt
hand, at the trump being valued) would send it, and 0 when it would be kept.
With the flag off - the shipped default - nothing changes: every loose K is
LOOSE_KING_VALUE and every loose Q LOOSE_QUEEN_VALUE, as since #277.

`web/src/engine/bidding.test.ts` pins the same two hands in TypeScript.
"""

import random

import pinochle_rules_engine
from pinochle_engine import (
    ACE_VALUE,
    Card,
    Deck,
    EXTRA_TRUMP_VALUE,
    LOOSE_KING_VALUE,
    LOOSE_KQ_PASS_ONLY,
    LOOSE_KQ_PASSED_VALUE,
    LOOSE_QUEEN_VALUE,
    Player,
    Suit,
    TRUMP_ACE_VALUE,
    _bidder_pass_selection,
    best_base_bid,
    compute_max_bid,
    compute_trick_potential,
)

H, C, D, S = Suit.HEARTS, Suit.CLUBS, Suit.DIAMONDS, Suit.SPADES
PASSED_LABEL = "Unmarried K/Q going into the pass"


def hand(*specs):
    seen, cards = {}, []
    for rank, suit in specs:
        seen[(suit, rank)] = seen.get((suit, rank), 0) + 1
        cards.append(Card(suit, rank, seen[(suit, rank)]))
    return cards


# Hearts trump. K(C) and Q(D) are loose, and the bidder's spare-K/Q tier sends
# both (the third card is the unprotected 10 of diamonds).
BOTH_PASSED = hand(("A", H), ("10", H), ("K", H), ("Q", H), ("J", H),
                   ("A", C), ("K", C), ("9", C), ("9", C),
                   ("A", D), ("Q", D), ("10", D))

# Hearts trump. K(S), K(C), K(D) are all loose. K(S) is a singleton suit, so
# the void tier sends it; K(C) and K(D) are each the only King of their suit in
# Kings Around, so the spare-K tier skips them and they are kept.
ONE_PASSED_TWO_KEPT = hand(("A", H), ("10", H), ("K", H), ("Q", H), ("J", H),
                           ("A", C), ("K", C), ("9", C),
                           ("A", D), ("K", D), ("9", D),
                           ("K", S))

# Aces 3 x 20, trump Ace 20, five trump = 1 past the baseline.
NON_KQ_LINES = 3 * ACE_VALUE + TRUMP_ACE_VALUE + EXTRA_TRUMP_VALUE


def _ranks(cards):
    return sorted(f"{c.rank}{c.suit.name[0]}" for c in cards)


def test_the_flag_ships_off():
    assert LOOSE_KQ_PASS_ONLY is False
    assert LOOSE_KQ_PASSED_VALUE == 20
    # The shipped values are untouched by #326.
    assert LOOSE_KING_VALUE == 30
    assert LOOSE_QUEEN_VALUE == 20
    assert Player.loose_kq_pass_only is None


def test_the_fixture_hands_pass_what_the_tests_say_they_pass():
    assert _ranks(_bidder_pass_selection(BOTH_PASSED, H, "HC", 3)) == ["10D", "KC", "QD"]
    assert _ranks(_bidder_pass_selection(ONE_PASSED_TWO_KEPT, H, "HC", 3)) == ["9C", "9D", "KS"]


def test_flag_off_is_the_flat_rule():
    total, breakdown = compute_trick_potential(BOTH_PASSED, H)
    assert breakdown["Unmarried Kings"] == LOOSE_KING_VALUE
    assert breakdown["Unmarried Queens"] == LOOSE_QUEEN_VALUE
    assert PASSED_LABEL not in breakdown
    assert total == NON_KQ_LINES + LOOSE_KING_VALUE + LOOSE_QUEEN_VALUE

    total, breakdown = compute_trick_potential(ONE_PASSED_TWO_KEPT, H)
    assert breakdown["Unmarried Kings"] == 3 * LOOSE_KING_VALUE
    assert total == NON_KQ_LINES + 3 * LOOSE_KING_VALUE


def test_flag_on_pays_twenty_for_a_passed_king_or_queen():
    """A passed King is 20, not LOOSE_KING_VALUE: the doc prices K and Q alike."""
    total, breakdown = compute_trick_potential(BOTH_PASSED, H, loose_kq_pass_only=True)
    assert breakdown[PASSED_LABEL] == 2 * LOOSE_KQ_PASSED_VALUE
    assert "Unmarried Kings" not in breakdown and "Unmarried Queens" not in breakdown
    assert total == NON_KQ_LINES + 2 * LOOSE_KQ_PASSED_VALUE


def test_flag_on_pays_nothing_for_a_kept_king_or_queen():
    total, breakdown = compute_trick_potential(ONE_PASSED_TWO_KEPT, H, loose_kq_pass_only=True)
    assert breakdown[PASSED_LABEL] == 1 * LOOSE_KQ_PASSED_VALUE
    assert total == NON_KQ_LINES + LOOSE_KQ_PASSED_VALUE



def test_the_module_default_follows_the_constant(monkeypatch):
    # Patched on the defining module: since #250 `pinochle_engine` is a
    # re-export shim, and rebinding a name there would not reach
    # compute_trick_potential, which reads its own module's globals.
    monkeypatch.setattr(pinochle_rules_engine, "LOOSE_KQ_PASS_ONLY", True)
    assert compute_trick_potential(BOTH_PASSED, H) == \
        compute_trick_potential(BOTH_PASSED, H, loose_kq_pass_only=True)


def test_flag_off_leaves_every_valuation_unchanged_on_random_deals():
    """`None` (the default) and an explicit False are the same function, so
    every committed fixture built on the default is unaffected."""
    rng = random.Random(326)
    for _ in range(200):
        deck = Deck()
        rng.shuffle(deck.cards)
        cards = deck.cards[:12]
        for trump in Suit:
            assert compute_max_bid(cards, trump, 300, 500) == \
                compute_max_bid(cards, trump, 300, 500, loose_kq_pass_only=False)
        assert best_base_bid(cards) == best_base_bid(cards, loose_kq_pass_only=False)


def test_a_seat_override_reaches_its_own_trump_choice():
    seat = Player("p", None)
    seat.hand = list(ONE_PASSED_TWO_KEPT)
    assert seat.choose_trump() == best_base_bid(ONE_PASSED_TWO_KEPT)[0]
    seat.loose_kq_pass_only = True
    assert seat.choose_trump() == best_base_bid(ONE_PASSED_TWO_KEPT, loose_kq_pass_only=True)[0]

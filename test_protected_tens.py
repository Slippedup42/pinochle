"""
Tests for issue #276 - a non-trump 10 behind BOTH Aces of its suit is a
winner, not a liability, and must not be shed ahead of ordinary filler.

Paul's ruling, 2026-09-02, from live play. Two reasons, either sufficient:

  - **Held**: with both Aces of the suit in hand, the suit can be played
    out last and the 10 takes the trick behind them.
  - **Passed**: a 10 delivered to a partner holding the Ace becomes a
    20-point trick when the Ace is led and the 10 falls on it.

Which of the two applies at a pass decision decides where the card
belongs. If THIS hand holds both Aces then the other hand holds none, so
passing this 10 cannot buy the drop-on-partner's-Ace trick. All of the
value is in keeping the suit intact and cashing it late, so a protected 10
is shed only once ordinary filler is gone.

The corollary is pinned here too, because it is what makes the rule safe:
A-A-10 moves as a group. A pass rule that kept the 10 while shedding one
of the Aces holding it up would leave a bare 10 - strictly worse than the
behaviour it replaced.

One file, because the rule crosses five call sites that used to agree on
the opposite: `_bidder_pass_selection`, `_tier1_forward_pass_candidates`,
`_return_pass_pool_priority`, and the two simplified `choose_pass_cards`
bidder branches (EasyPlayer and GeneralStrategy's `pass_logic == "easy"`
arm). Each site gets the same three cases: both Aces (kept), one Ace
(still shed - the single-Ace case is deliberately out of scope), no Ace
(unchanged).

Run directly (`python test_protected_tens.py`) or via pytest.
"""

from pinochle_engine import (
    Card,
    EasyPlayer,
    GeneralStrategy,
    Suit,
    choose_return_pass_cards,
    _bidder_pass_selection,
    _in_protected_ten_run,
    _is_protected_ten,
    _protects_a_ten,
    _tier1_forward_pass_candidates,
)


def C(suit, rank, copy_id=1):
    return Card(suit, rank, copy_id)


def _names(cards):
    return sorted(f"{c.rank}{c.suit.value}" for c in cards)


# ---------------------------------------------------------------------------
# The predicates themselves.
# ---------------------------------------------------------------------------

def test_predicate_needs_both_aces_and_a_non_trump_suit():
    """`_is_protected_ten` is exactly "non-trump 10, both Aces of its suit
    in hand" - not one Ace, and never a trump 10 (a run card, explicitly
    out of scope for #276)."""
    trump = Suit.HEARTS
    ten_c = C(Suit.CLUBS, "10")
    two_aces = [ten_c, C(Suit.CLUBS, "A"), C(Suit.CLUBS, "A", 2)]

    assert _is_protected_ten(two_aces, trump, ten_c)
    assert not _is_protected_ten([ten_c, C(Suit.CLUBS, "A")], trump, ten_c)
    assert not _is_protected_ten([ten_c, C(Suit.CLUBS, "K")], trump, ten_c)

    ten_h = C(Suit.HEARTS, "10")
    assert not _is_protected_ten(
        [ten_h, C(Suit.HEARTS, "A"), C(Suit.HEARTS, "A", 2)], trump, ten_h)

    king = C(Suit.CLUBS, "K")
    assert not _is_protected_ten(two_aces + [king], trump, king)


def test_the_two_aces_are_protected_with_the_ten_they_hold_up():
    """The corollary: keeping the 10 while shedding an Ace would leave a
    bare 10, so the Aces of a suit that also holds a 10 are part of the
    same group. Two Aces with no 10 behind them are ordinary Aces."""
    trump = Suit.HEARTS
    ace = C(Suit.CLUBS, "A")
    with_ten = [C(Suit.CLUBS, "10"), ace, C(Suit.CLUBS, "A", 2)]
    without_ten = [C(Suit.CLUBS, "K"), ace, C(Suit.CLUBS, "A", 2)]

    assert _protects_a_ten(with_ten, trump, ace)
    assert not _protects_a_ten(without_ten, trump, ace)
    assert not _protects_a_ten([C(Suit.CLUBS, "10"), ace], trump, ace)

    assert all(_in_protected_ten_run(with_ten, trump, c) for c in with_ten)
    assert not any(_in_protected_ten_run(without_ten, trump, c) for c in without_ten)


# ---------------------------------------------------------------------------
# `_bidder_pass_selection` (proficient tier). `bidderPassSelection` in
# web/src/engine/passing.ts is the shipped port; passing.test.ts mirrors
# these three cases.
#
# Trump is SPADES so the category is D/S and the Q(S)/J(D) tier stays out
# of it. Every King and Queen in the hand is married and no rank is around,
# so #280's spare-K/Q tier - which now runs *ahead* of the 10s - takes
# nothing, and the ordinary filler the 10 has to outlast is the safe J/9
# tier below it.
# ---------------------------------------------------------------------------

TRUMP_S = Suit.SPADES

_SIDE_SUITS = [C(Suit.HEARTS, "A"), C(Suit.HEARTS, "K"), C(Suit.HEARTS, "Q"),
               C(Suit.HEARTS, "9"),
               C(Suit.DIAMONDS, "A"), C(Suit.DIAMONDS, "K"),
               C(Suit.DIAMONDS, "Q"), C(Suit.DIAMONDS, "9")]


def _bidder_hand(club_aces):
    hand = [C(Suit.CLUBS, "10"), C(Suit.CLUBS, "K"), C(Suit.CLUBS, "Q"),
            C(Suit.CLUBS, "J")]
    hand += [C(Suit.CLUBS, "A", i + 1) for i in range(club_aces)]
    hand += _SIDE_SUITS
    trump_filler = [C(Suit.SPADES, "A"), C(Suit.SPADES, "10"), C(Suit.SPADES, "J")]
    hand += trump_filler[:15 - len(hand)]
    assert len(hand) == 15, len(hand)
    return hand


def test_bidder_pass_keeps_a_ten_behind_both_aces():
    """Both Aces of clubs in hand: the 10C wins once the suit is played out
    last, so the bidder ships J/9 rags instead. Passing it could not buy
    the Ace-drop trick anyway - both Aces are here, so the partner has
    none of them."""
    chosen = _bidder_pass_selection(_bidder_hand(2), TRUMP_S, "DS", 3)
    assert "10C" not in _names(chosen), _names(chosen)
    assert "AC" not in _names(chosen), ("the Aces go with it", _names(chosen))


def test_bidder_pass_still_ships_a_ten_behind_one_ace():
    """One Ace is only partial protection and #276 deliberately does not
    cover it - the 10 is shed exactly as before."""
    chosen = _bidder_pass_selection(_bidder_hand(1), TRUMP_S, "DS", 3)
    assert "10C" in _names(chosen), _names(chosen)


def test_bidder_pass_unchanged_with_no_ace_of_the_suit():
    """The ordinary case and the majority of hands: an unprotected 10 has
    no meld value and no way to win a trick, and still goes first."""
    chosen = _bidder_pass_selection(_bidder_hand(0), TRUMP_S, "DS", 3)
    assert "10C" in _names(chosen), _names(chosen)


# The fourth case here used to be the duplicate-AS/AD pro move standing
# down when that pair was holding a 10 up. #280 deleted the pro move
# itself - deliberately, and it may come back - so there is nothing left
# for that case to assert: the bidder no longer sends an Ace back at all
# short of a hand with nothing unprotected in it.


# ---------------------------------------------------------------------------
# `_tier1_forward_pass_candidates`. Called with `exclude` = whatever Tier 0
# has already committed to the Bidder, and protection is measured against
# what is left - see the function's docstring for why that is not the same
# question as "does the hand hold both Aces".
# ---------------------------------------------------------------------------

TRUMP_H = Suit.HEARTS


def _forward_hand(club_aces):
    hand = [
        C(Suit.CLUBS, "10"),
        C(Suit.SPADES, "9"), C(Suit.SPADES, "9", 2), C(Suit.SPADES, "J"),
        C(Suit.DIAMONDS, "9"), C(Suit.DIAMONDS, "9", 2), C(Suit.DIAMONDS, "J"),
        C(Suit.HEARTS, "9"), C(Suit.HEARTS, "9", 2),
        C(Suit.CLUBS, "9"),
    ]
    hand += [C(Suit.CLUBS, "A", i + 1) for i in range(club_aces)]
    pad = [C(Suit.SPADES, "K"), C(Suit.DIAMONDS, "K")]
    hand += pad[:12 - len(hand)]
    assert len(hand) == 12, len(hand)
    return hand


def test_forward_tier1_keeps_a_ten_behind_both_aces_that_are_staying():
    """Tier 1 used to list non-trump 10s first, on the stated reasoning
    that they have zero meld value and are pure liability. True of an
    unprotected 10, false here - with both Aces staying, this is the suit
    partner plays out last."""
    hand = _forward_hand(2)
    ranked = _tier1_forward_pass_candidates(hand, TRUMP_H, exclude=[])
    assert "10C" not in _names(ranked[:3]), _names(ranked[:3])
    assert "AC" not in _names(ranked[:3]), _names(ranked[:3])


def test_forward_tier1_ships_the_ten_after_tier0_takes_the_aces():
    """The case that decides where the test is measured. Tier 0 chases
    every Ace, so once both Aces are committed to the Bidder the 10 is not
    protected in what remains - and shipping it is right, because it
    arrives behind the very Aces that make it a winner."""
    hand = _forward_hand(2)
    aces = [c for c in hand if c.rank == "A"]
    ranked = _tier1_forward_pass_candidates(hand, TRUMP_H, exclude=aces)
    assert "10C" == _names(ranked[:1])[0], _names(ranked[:3])


def test_forward_tier1_still_ships_a_ten_behind_one_ace():
    hand = _forward_hand(1)
    ranked = _tier1_forward_pass_candidates(hand, TRUMP_H, exclude=[])
    assert "10C" in _names(ranked[:3]), _names(ranked[:3])


def test_forward_tier1_unchanged_with_no_ace_of_the_suit():
    hand = _forward_hand(0)
    ranked = _tier1_forward_pass_candidates(hand, TRUMP_H, exclude=[])
    assert "10C" in _names(ranked[:3]), _names(ranked[:3])


# ---------------------------------------------------------------------------
# `_return_pass_pool_priority`, reached through `choose_return_pass_cards`.
# ---------------------------------------------------------------------------

def _return_hand(club_aces):
    hand = [
        C(Suit.CLUBS, "10"),
        C(Suit.HEARTS, "A"), C(Suit.HEARTS, "K"), C(Suit.HEARTS, "Q"),
        C(Suit.SPADES, "9"), C(Suit.SPADES, "9", 2), C(Suit.SPADES, "J"),
        C(Suit.DIAMONDS, "9"), C(Suit.DIAMONDS, "9", 2), C(Suit.DIAMONDS, "J"),
        C(Suit.CLUBS, "9"), C(Suit.CLUBS, "9", 2), C(Suit.CLUBS, "J"),
    ]
    hand += [C(Suit.CLUBS, "A", i + 1) for i in range(club_aces)]
    hand += [C(Suit.SPADES, "K"), C(Suit.SPADES, "Q")][:15 - len(hand)]
    assert len(hand) == 15, len(hand)
    return hand


def test_return_pass_keeps_a_ten_behind_both_aces():
    """Section 3 calls a non-trump 10 an automatic ship candidate. It stays
    automatic - for the unprotected ones. Here the Bidder keeps all three
    clubs and returns rags."""
    chosen = choose_return_pass_cards(_return_hand(2), TRUMP_H, 3)
    assert "10C" not in _names(chosen), _names(chosen)
    assert "AC" not in _names(chosen), ("the Aces go with it", _names(chosen))


def test_return_pass_still_ships_a_ten_behind_one_ace():
    chosen = choose_return_pass_cards(_return_hand(1), TRUMP_H, 3)
    assert "10C" in _names(chosen), _names(chosen)


def test_return_pass_unchanged_with_no_ace_of_the_suit():
    chosen = choose_return_pass_cards(_return_hand(0), TRUMP_H, 3)
    assert "10C" in _names(chosen), _names(chosen)


# ---------------------------------------------------------------------------
# The two simplified bidder branches: EasyPlayer and GeneralStrategy's
# `pass_logic == "easy"` arm (skill 1). Same rule, same three cases - this
# is not expert-tier sophistication, it is what the card is worth.
# ---------------------------------------------------------------------------

def _easy_players(hand):
    easy = EasyPlayer("Easy", None)
    easy.hand = list(hand)
    general = GeneralStrategy("General", None, skill_level=1)
    general.hand = list(hand)
    return [easy, general]


def test_easy_bidder_keeps_a_ten_behind_both_aces():
    for p in _easy_players(_return_hand(2)):
        chosen = p.choose_pass_cards(3, TRUMP_H, is_bid_winner=True)
        assert "10C" not in _names(chosen), (type(p).__name__, _names(chosen))


def test_easy_bidder_still_ships_a_ten_behind_one_ace():
    for p in _easy_players(_return_hand(1)):
        chosen = p.choose_pass_cards(3, TRUMP_H, is_bid_winner=True)
        assert "10C" in _names(chosen), (type(p).__name__, _names(chosen))


def test_easy_bidder_unchanged_with_no_ace_of_the_suit():
    for p in _easy_players(_return_hand(0)):
        chosen = p.choose_pass_cards(3, TRUMP_H, is_bid_winner=True)
        assert "10C" in _names(chosen), (type(p).__name__, _names(chosen))


if __name__ == "__main__":
    tests = [obj for name, obj in list(globals().items())
             if name.startswith("test_") and callable(obj)]
    for t in tests:
        t()
        print(f"OK: {t.__name__}")
    print(f"\n{len(tests)} tests passed.")

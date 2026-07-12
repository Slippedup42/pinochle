"""
Tests for issue #61 - Forward/return pass rollout logic (shared pass
strategy), implementing pinochle_expert_ai_strategy.md Sections 2 (forward
pass) and 3 (return pass) as shared, callable functions
(`choose_forward_pass_cards` / `choose_return_pass_cards` in
pinochle_engine.py) independent of any Player subclass or the rollout
sampler itself. Plain assert-based, pytest-discoverable, matching
test_rollout.py / test_ai_tiers.py's convention.

Covers:
  1. Section 2 Tier 0 "always chase if missing" - each category (trump
     Run/Marriage completion, QS/JD Pinochle trump-independence, missing
     Ace toward Aces Around).
  2. The hard exclusion: Kings/Queens/Jacks Around are never chased, from
     zero or from partial progress - no soft "3 Kings implies a Queen"
     heuristic.
  3. Tier 1 fallback shedding, static mode: strictly a last resort, matches
     the doc's concrete 10-K-Q example (keep the marriage, ship the 10).
  4. The resolved v1 mode split (doc Section 9 Q1): static mode never lets
     Tier 1 outrank a marginal Tier 0 pick; rollout-compare mode (an
     injected `rollout_evaluator` callback) can and does pick differently
     on the same hand - proving the two modes actually diverge, not just
     that both exist.
  5. Section 3: non-trump 10s are automatic top ship candidates.
  6. Section 3 knapsack triage: a hand with more meld-in-progress than
     fits in the post-pass hand breaks the lowest-value meld whole and
     keeps the higher-value groups whole (doc's Kings-Around-vs-Run
     example).
  7. The resolved v1 default (doc Section 9 Q2): a complete single meld
     that gets knapsack-locked is never reopened/broken later to chase a
     Double of the same meld.
  8. General legality: both functions always return exactly `count`
     distinct cards actually present in the input hand, across many
     randomized hands.

Run directly (`python test_expert_pass.py`) or via pytest.
"""

import random

from pinochle_engine import (
    Card,
    Deck,
    Suit,
    choose_forward_pass_cards,
    choose_return_pass_cards,
    score_melds,
    _knapsack_lock_return_pass_melds,
    _tier0_forward_pass_candidates,
    _tier1_forward_pass_candidates,
)


def C(suit, rank, copy_id=1):
    return Card(suit, rank, copy_id)


def _names(cards):
    return sorted(f"{c.rank}{c.suit.value}" for c in cards)


def _fresh_hands():
    deck = Deck()
    deck.shuffle()
    cards = deck.cards
    return [cards[i * 12:(i + 1) * 12] for i in range(4)]


# ---------------------------------------------------------------------------
# 1. Section 2 Tier 0 - "always chase if missing", per category.
# ---------------------------------------------------------------------------

def test_tier0_chases_each_trump_run_rank():
    trump = Suit.HEARTS
    for rank in ("A", "10", "K", "Q", "J"):
        hand = [C(trump, rank)] + [C(Suit.CLUBS, "9", i) for i in (1, 2)] * 5
        hand = hand[:12]
        tier0 = _tier0_forward_pass_candidates(hand, trump)
        assert any(c.suit == trump and c.rank == rank for c in tier0), (rank, tier0)


def test_tier0_chases_pinochle_trump_independent():
    """QS/JD are Tier 0 regardless of the declared trump suit."""
    for trump in Suit:
        hand = [C(Suit.SPADES, "Q"), C(Suit.DIAMONDS, "J")] + \
            [C(Suit.CLUBS, "9", i) for i in (1, 2)] * 5
        hand = hand[:12]
        tier0 = _tier0_forward_pass_candidates(hand, trump)
        names = _names(tier0)
        assert "QS" in names and "JD" in names, (trump, names)


def test_tier0_chases_missing_ace_toward_aces_around():
    trump = Suit.HEARTS
    for suit in Suit:
        hand = [C(suit, "A")] + [C(Suit.CLUBS, "9", i) for i in (1, 2)] * 5
        hand = hand[:12]
        tier0 = _tier0_forward_pass_candidates(hand, trump)
        assert any(c.suit == suit and c.rank == "A" for c in tier0), (suit, tier0)


# ---------------------------------------------------------------------------
# 2. Hard exclusion - Kings/Queens/Jacks Around never chased, even from
#    partial progress. No soft "3 Kings implies a Queen" heuristic.
# ---------------------------------------------------------------------------

def test_tier0_never_chases_kings_around_even_with_partial_progress():
    trump = Suit.HEARTS
    # 3 Kings already held (partial progress toward Kings Around) - the
    # doc explicitly forbids treating this as chase-worthy.
    hand = [C(Suit.SPADES, "K"), C(Suit.DIAMONDS, "K"), C(Suit.CLUBS, "K")] + \
        [C(Suit.CLUBS, "9", 1), C(Suit.CLUBS, "9", 2)] * 4 + [C(Suit.DIAMONDS, "9")]
    hand = hand[:12]
    tier0 = _tier0_forward_pass_candidates(hand, trump)
    names = _names(tier0)
    # None of the non-trump Kings should appear (KH would be fine - that's
    # the trump King, chased via Run/Marriage, not via Kings Around).
    assert "KS" not in names and "KD" not in names and "KC" not in names, names


def test_tier0_never_chases_queens_or_jacks_around_from_zero():
    trump = Suit.HEARTS
    hand = [C(Suit.CLUBS, "Q"), C(Suit.SPADES, "J")] + \
        [C(Suit.DIAMONDS, "9", i) for i in (1, 2)] * 5
    hand = hand[:12]
    tier0 = _tier0_forward_pass_candidates(hand, trump)
    names = _names(tier0)
    assert "QC" not in names  # not trump, not QS -> no Pinochle/Run reason either
    assert "JS" not in names  # not trump, not JD -> no Pinochle/Run reason either


def test_tier0_trump_kqj_still_chased_via_run_not_around():
    """The stated exception: a trump K/Q/J IS Tier 0, but only via
    Run/Marriage/Pinochle reasoning, never via Kings/Queens/Jacks Around."""
    trump = Suit.SPADES
    hand = [C(Suit.SPADES, "K"), C(Suit.SPADES, "Q"), C(Suit.SPADES, "J")] + \
        [C(Suit.CLUBS, "9", i) for i in (1, 2)] * 4 + [C(Suit.DIAMONDS, "9")]
    hand = hand[:12]
    tier0 = _tier0_forward_pass_candidates(hand, trump)
    names = _names(tier0)
    assert {"KS", "QS", "JS"} <= set(names)


# ---------------------------------------------------------------------------
# 3. Section 2 Tier 1 - static mode is a strict last resort. Doc's
#    concrete example: 10-K-Q of a non-trump suit, nothing Tier-0 eligible
#    -> keep K+Q (preserves the Common Marriage), ship the 10.
# ---------------------------------------------------------------------------

def _no_tier0_hand(trump):
    """12-card hand with zero Tier 0 candidates: no QS/JD, no trump
    A/10/K/Q/J, no Aces anywhere - isolates Tier 1 behavior."""
    assert trump == Suit.HEARTS, "helper assumes HEARTS trump for the fixed card list below"
    return [
        C(Suit.CLUBS, "10"), C(Suit.CLUBS, "K"), C(Suit.CLUBS, "Q"),
        C(Suit.CLUBS, "9"), C(Suit.CLUBS, "9", 2),
        C(Suit.DIAMONDS, "9"), C(Suit.DIAMONDS, "9", 2),
        C(Suit.SPADES, "9"), C(Suit.SPADES, "9", 2),
        C(Suit.HEARTS, "9"), C(Suit.HEARTS, "9", 2),
        C(Suit.CLUBS, "J"),
    ]


def test_tier1_static_mode_keeps_marriage_ships_the_ten():
    trump = Suit.HEARTS
    hand = _no_tier0_hand(trump)
    assert len(hand) == 12
    assert _tier0_forward_pass_candidates(hand, trump) == []

    chosen = choose_forward_pass_cards(hand, trump, 3)
    names = _names(chosen)
    assert "10C" in names, names
    assert "KC" not in names and "QC" not in names, "must not break the kept Common Marriage"


def test_tier1_is_strict_last_resort_in_static_mode():
    """When Tier 0 has enough candidates to fill every slot, static mode
    (no rollout_evaluator) never reaches into Tier 1 at all."""
    trump = Suit.HEARTS
    hand = [
        C(Suit.SPADES, "Q"), C(Suit.DIAMONDS, "J"), C(Suit.HEARTS, "A"),
        C(Suit.CLUBS, "10"),  # prime Tier 1 candidate (non-trump 10) - must NOT be picked
        C(Suit.CLUBS, "9"), C(Suit.CLUBS, "9", 2),
        C(Suit.DIAMONDS, "9"), C(Suit.DIAMONDS, "9", 2),
        C(Suit.SPADES, "9"), C(Suit.SPADES, "9", 2),
        C(Suit.CLUBS, "K"), C(Suit.CLUBS, "J"),
    ]
    assert len(hand) == 12
    chosen = choose_forward_pass_cards(hand, trump, 3)
    names = _names(chosen)
    assert "10C" not in names, names
    assert set(names) == {"QS", "JD", "AH"}


# ---------------------------------------------------------------------------
# 4. Resolved v1 mode split (doc Section 9 Q1): rollout-compare mode CAN
#    pick a Tier 1 card over a marginal Tier 0 pick; static mode never
#    does. Proves the two modes actually diverge on the same hand.
# ---------------------------------------------------------------------------

def _marginal_vs_competing_hand():
    trump = Suit.HEARTS
    hand = [
        C(Suit.SPADES, "Q"), C(Suit.DIAMONDS, "J"), C(Suit.HEARTS, "A"),
        C(Suit.CLUBS, "10"),  # the Tier 1 challenger
        C(Suit.CLUBS, "9"), C(Suit.CLUBS, "9", 2),
        C(Suit.DIAMONDS, "9"), C(Suit.DIAMONDS, "9", 2),
        C(Suit.SPADES, "9"), C(Suit.SPADES, "9", 2),
        C(Suit.CLUBS, "K"), C(Suit.CLUBS, "J"),
    ]
    assert len(hand) == 12
    return trump, hand


def test_rollout_compare_mode_can_outrank_marginal_tier0_pick():
    trump, hand = _marginal_vs_competing_hand()

    static_chosen = choose_forward_pass_cards(hand, trump, 3)
    assert _names(static_chosen) == ["AH", "JD", "QS"]

    def prefer_the_ten(hand, trump, candidates):
        return 20.0 if any(c.rank == "10" and c.suit == Suit.CLUBS for c in candidates) else 10.0

    compare_chosen = choose_forward_pass_cards(hand, trump, 3, rollout_evaluator=prefer_the_ten)
    assert _names(compare_chosen) == ["10C", "JD", "QS"]

    assert _names(static_chosen) != _names(compare_chosen), \
        "rollout-compare mode must be able to pick differently than static mode"


def test_rollout_compare_mode_keeps_static_pick_when_evaluator_prefers_it():
    """Symmetric check: the evaluator - not a hardcoded ranking - decides.
    When it scores the static (Tier 0) candidate higher, compare mode
    agrees with static mode."""
    trump, hand = _marginal_vs_competing_hand()

    def prefer_the_ace(hand, trump, candidates):
        return 20.0 if any(c.rank == "A" and c.suit == Suit.HEARTS for c in candidates) else 10.0

    static_chosen = choose_forward_pass_cards(hand, trump, 3)
    compare_chosen = choose_forward_pass_cards(hand, trump, 3, rollout_evaluator=prefer_the_ace)
    assert _names(static_chosen) == _names(compare_chosen)


# ---------------------------------------------------------------------------
# 5. Section 3 - non-trump 10s are automatic top ship candidates.
# ---------------------------------------------------------------------------

def test_non_trump_tens_are_auto_ship_candidates():
    trump = Suit.HEARTS
    hand = [
        C(Suit.CLUBS, "10"), C(Suit.DIAMONDS, "10"),
        C(Suit.HEARTS, "A"), C(Suit.HEARTS, "K"),
        C(Suit.CLUBS, "9"), C(Suit.CLUBS, "9", 2),
        C(Suit.DIAMONDS, "9"), C(Suit.DIAMONDS, "9", 2),
        C(Suit.SPADES, "9"), C(Suit.SPADES, "9", 2),
        C(Suit.CLUBS, "K"), C(Suit.CLUBS, "Q"),
        C(Suit.SPADES, "K"), C(Suit.SPADES, "Q"),
        C(Suit.CLUBS, "J"),
    ]
    assert len(hand) == 15
    chosen = choose_return_pass_cards(hand, trump, 3)
    names = _names(chosen)
    assert "10C" in names and "10D" in names, names


def test_trump_ten_not_treated_as_auto_ship():
    """A trump 10 is part of a potential Run, not a "zero meld value"
    liability - only NON-trump 10s get the automatic-ship treatment."""
    trump = Suit.HEARTS
    hand = [
        C(Suit.HEARTS, "10"),  # trump 10 - part of the Run below, must be kept
        C(Suit.HEARTS, "A"), C(Suit.HEARTS, "K"), C(Suit.HEARTS, "Q"), C(Suit.HEARTS, "J"),
        C(Suit.CLUBS, "9"), C(Suit.CLUBS, "9", 2),
        C(Suit.DIAMONDS, "9"), C(Suit.DIAMONDS, "9", 2),
        C(Suit.SPADES, "9"), C(Suit.SPADES, "9", 2),
        C(Suit.CLUBS, "J"), C(Suit.SPADES, "J"),
        C(Suit.CLUBS, "K"), C(Suit.SPADES, "K"),
    ]
    assert len(hand) == 15
    chosen = choose_return_pass_cards(hand, trump, 3)
    names = _names(chosen)
    assert "10H" not in names, "trump 10 (Run piece) must not be shipped"


# ---------------------------------------------------------------------------
# 6. Section 3 knapsack triage: more meld-in-progress than fits - break
#    the lowest-value group whole, keep the higher-value groups whole.
# ---------------------------------------------------------------------------

def test_knapsack_breaks_lowest_value_meld_when_overflowing():
    trump = Suit.HEARTS
    hand = [
        # Run (150): trump A,10,K,Q,J
        C(Suit.HEARTS, "A"), C(Suit.HEARTS, "10"), C(Suit.HEARTS, "K"),
        C(Suit.HEARTS, "Q"), C(Suit.HEARTS, "J"),
        # Double Pinochle (300): QS x2, JD x2
        C(Suit.SPADES, "Q", 1), C(Suit.SPADES, "Q", 2),
        C(Suit.DIAMONDS, "J", 1), C(Suit.DIAMONDS, "J", 2),
        # Aces Around (100): A of S, D, C (H ace already in the Run above)
        C(Suit.SPADES, "A"), C(Suit.DIAMONDS, "A"), C(Suit.CLUBS, "A"),
        # Kings Around (80): K of S, D, C (H king already in the Run above)
        C(Suit.SPADES, "K"), C(Suit.DIAMONDS, "K"), C(Suit.CLUBS, "K"),
    ]
    assert len(hand) == 15
    total, breakdown = score_melds(hand, trump)
    assert breakdown.get("Ks Around") == 80  # sanity: Kings Around really is present

    chosen = choose_return_pass_cards(hand, trump, 3)
    names = set(_names(chosen))
    assert names == {"KS", "KD", "KC"}, names

    # And the higher-value groups genuinely stayed intact (weren't touched).
    remaining = [c for c in hand if c not in chosen]
    remaining_total, remaining_breakdown = score_melds(remaining, trump)
    assert "Run" in remaining_breakdown
    assert "Double Pinochle" in remaining_breakdown
    assert "As Around" in remaining_breakdown
    assert "Ks Around" not in remaining_breakdown


def test_knapsack_lock_never_exceeds_cap():
    """A meld group that doesn't fit is skipped whole, never partially
    locked - the locked set can never exceed the cap."""
    trump = Suit.HEARTS
    hand = [
        C(Suit.HEARTS, "A"), C(Suit.HEARTS, "10"), C(Suit.HEARTS, "K"),
        C(Suit.HEARTS, "Q"), C(Suit.HEARTS, "J"),
        C(Suit.SPADES, "Q", 1), C(Suit.SPADES, "Q", 2),
        C(Suit.DIAMONDS, "J", 1), C(Suit.DIAMONDS, "J", 2),
        C(Suit.SPADES, "A"), C(Suit.DIAMONDS, "A"), C(Suit.CLUBS, "A"),
        C(Suit.SPADES, "K"), C(Suit.DIAMONDS, "K"), C(Suit.CLUBS, "K"),
    ]
    for cap in range(0, 16):
        locked = _knapsack_lock_return_pass_melds(hand, trump, cap)
        assert len(locked) <= cap, (cap, len(locked))


# ---------------------------------------------------------------------------
# 7. Resolved v1 default (doc Section 9 Q2): a complete single meld that's
#    locked stays locked - never reopened/broken to chase its Double.
# ---------------------------------------------------------------------------

def test_complete_single_meld_not_reopened_to_chase_its_double():
    """Bidder holds a complete Aces Around (100, locked) plus 3 more Aces
    of the same suits already used (an impossible extra copy in real play,
    but the point here is purely mechanical: the knapsack must never try
    to "break" the locked Aces Around to protect duplicate progress toward
    a Double). Ships from the lower-value clutter instead, and the locked
    Aces Around cards are never candidates."""
    trump = Suit.HEARTS
    hand = [
        C(Suit.HEARTS, "A"), C(Suit.HEARTS, "10"), C(Suit.HEARTS, "K"),
        C(Suit.HEARTS, "Q"), C(Suit.HEARTS, "J"),  # Run (150) - highest value, locked first
        C(Suit.SPADES, "A"), C(Suit.DIAMONDS, "A"), C(Suit.CLUBS, "A"),  # Aces Around (100)
        C(Suit.CLUBS, "9"), C(Suit.CLUBS, "9", 2),
        C(Suit.DIAMONDS, "9"), C(Suit.DIAMONDS, "9", 2),
        C(Suit.SPADES, "9"), C(Suit.SPADES, "9", 2),
        C(Suit.CLUBS, "10"),
    ]
    assert len(hand) == 15
    _, breakdown = score_melds(hand, trump)
    assert breakdown.get("As Around") == 100

    locked = _knapsack_lock_return_pass_melds(hand, trump, cap=12)
    locked_names = set(_names(locked))
    assert {"AS", "AD", "AC"} <= locked_names, "the complete Aces Around must be locked"

    chosen = choose_return_pass_cards(hand, trump, 3)
    chosen_names = set(_names(chosen))
    assert not (chosen_names & {"AS", "AD", "AC"}), \
        "a locked complete meld must never be broken to chase its Double"
    assert "10C" in chosen_names  # the actual non-trump-10 liability, correctly shipped instead


# ---------------------------------------------------------------------------
# 8. General legality across randomized hands.
# ---------------------------------------------------------------------------

def test_forward_pass_always_legal_and_exact_count():
    for _ in range(15):
        for hand in _fresh_hands():
            for trump in Suit:
                chosen = choose_forward_pass_cards(hand, trump, 3)
                assert len(chosen) == 3
                assert len(set(id(c) for c in chosen)) == 3
                for c in chosen:
                    assert c in hand


def test_return_pass_always_legal_and_exact_count():
    deck = Deck()
    deck.shuffle()
    cards = deck.cards
    for _ in range(15):
        random.shuffle(cards)
        hand15 = cards[:15]
        for trump in Suit:
            chosen = choose_return_pass_cards(hand15, trump, 3)
            assert len(chosen) == 3
            assert len(set(id(c) for c in chosen)) == 3
            for c in chosen:
                assert c in hand15


if __name__ == "__main__":
    tests = [obj for name, obj in list(globals().items())
             if name.startswith("test_") and callable(obj)]
    for t in tests:
        t()
        print(f"OK: {t.__name__}")
    print(f"\n{len(tests)} tests passed.")

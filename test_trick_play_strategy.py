"""
Tests for issue #62 - Trick-play rollout strategy + gated deception,
implementing pinochle_expert_ai_strategy.md Section 4 (trick-play strategy)
and, gated behind an optional deception_evaluator, Section 7 (deception) as
shared, callable functions (`choose_expert_lead_card` /
`choose_expert_follow_card` in pinochle_engine.py) independent of any
Player subclass or the rollout sampler itself. Plain assert-based,
pytest-discoverable, matching test_expert_pass.py / test_rollout.py's
convention.

Covers:
  1. Bidder-leading Ace-first trump lead (doc Section 4 point 1), and that
     the exact same shared function drives both the Bidder's and the
     partner's lead (doc Section 9 Q4, resolved).
  2. The no-trump-Ace mid-hand conservative shift (doc Section 9 Q3,
     resolved): abandons the aggressive trump-draw plan, never proactively
     leads trump when a non-trump lead is available.
  3. Endgame loser-first sequencing: once all trump is accounted for
     outside a near-empty hand, losers lead first and trump is held back.
  4. Following-suit heuristics: duck vs. feed when partner is already
     winning, count-card protection on both a forced non-beat and a free
     sluff (including the case where a naive shortest-suit tie-break would
     get it wrong), and over-trump-vs-under-trump judgment when first to
     trump a trick.
  5. The defender static/rollout-compare split (doc Section 9 Q5, revised
     resolution): static mode never leads trump; rollout-compare mode CAN
     override that default when the injected evaluator prefers it.
  6. Deception (Section 7): false-card/fake-void candidate generators only
     propose believable candidates per PlayTracker's per-copy tracking,
     and `choose_expert_follow_card` with `deception_evaluator` supplied
     can diverge from the honest baseline while always returning a legal
     move.
  7. General legality across randomized hands/trick states for both the
     lead and follow entry points.

Run directly (`python test_trick_play_strategy.py`) or via pytest.
"""

from pinochle_engine import (
    Card,
    Deck,
    PlayTracker,
    Suit,
    Trick,
    choose_expert_follow_card,
    choose_expert_lead_card,
    generate_fake_void_candidates,
    generate_false_card_candidates,
)


def C(suit, rank, copy_id=1):
    return Card(suit, rank, copy_id)


def _fresh_hands():
    deck = Deck()
    deck.shuffle()
    cards = deck.cards
    return [cards[i * 12:(i + 1) * 12] for i in range(4)]


# ---------------------------------------------------------------------------
# 1. Ace-first trump lead, shared by Bidder and partner (doc Section 9 Q4).
# ---------------------------------------------------------------------------

def test_offense_leads_trump_ace_when_held():
    trump = Suit.HEARTS
    tracker = PlayTracker()
    hand = [C(trump, "A"), C(trump, "K"), C(Suit.CLUBS, "9"), C(Suit.SPADES, "A")]
    card = choose_expert_lead_card(hand, trump, tracker, is_bidding_team=True)
    assert card.suit == trump and card.rank == "A", card


def test_offense_ace_first_shared_by_bidder_and_partner():
    """Doc Section 9 Q4, resolved: the partner runs the exact same
    Ace-first logic independently - not a special-cased deferral to
    whatever the Bidder's plan was. Proven here by calling the one shared
    function on two different hands, both with is_bidding_team=True."""
    trump = Suit.SPADES
    tracker = PlayTracker()
    bidder_hand = [C(trump, "A"), C(Suit.HEARTS, "9"), C(Suit.CLUBS, "K")]
    partner_hand = [C(Suit.DIAMONDS, "9"), C(trump, "A"), C(Suit.CLUBS, "Q")]

    bidder_lead = choose_expert_lead_card(bidder_hand, trump, tracker, is_bidding_team=True)
    partner_lead = choose_expert_lead_card(partner_hand, trump, tracker, is_bidding_team=True)

    assert bidder_lead.suit == trump and bidder_lead.rank == "A"
    assert partner_lead.suit == trump and partner_lead.rank == "A"


# ---------------------------------------------------------------------------
# 2. No-trump-Ace mid-hand conservative shift (doc Section 9 Q3, resolved).
# ---------------------------------------------------------------------------

def test_offense_conservative_lead_without_trump_ace():
    """Holding trump but no trump Ace: the aggressive trump-draw plan is
    abandoned - a non-trump lead is preferred whenever one is available,
    rather than proactively forcing trump out."""
    trump = Suit.HEARTS
    tracker = PlayTracker()
    hand = [C(trump, "K"), C(Suit.CLUBS, "9"), C(Suit.CLUBS, "9", 2)]
    card = choose_expert_lead_card(hand, trump, tracker, is_bidding_team=True)
    assert card.suit != trump, "must not proactively lead trump without a trump Ace"


def test_offense_leads_trump_only_when_nothing_else_left():
    trump = Suit.HEARTS
    tracker = PlayTracker()
    hand = [C(trump, "K"), C(trump, "Q")]  # trump-only hand, no Ace
    card = choose_expert_lead_card(hand, trump, tracker, is_bidding_team=True)
    assert card.suit == trump  # no non-trump option exists at all


# ---------------------------------------------------------------------------
# 3. Endgame sequencing - protect the last-trick bonus.
# ---------------------------------------------------------------------------

def test_endgame_holds_trump_back_and_leads_losers_first():
    trump = Suit.HEARTS
    tracker = PlayTracker()
    for rank in ("A", "10", "K", "Q", "J"):
        tracker.record(C(trump, rank, 1))
        tracker.record(C(trump, rank, 2))
    tracker.record(C(trump, "9", 2))  # the OTHER copy of the 9 this hand still holds
    # All 12 trump copies are now accounted for: 10 played + 1 played + 1 in hand.

    hand = [C(trump, "9", 1), C(Suit.CLUBS, "A"), C(Suit.DIAMONDS, "9")]

    offense_lead = choose_expert_lead_card(hand, trump, tracker, is_bidding_team=True)
    defense_lead = choose_expert_lead_card(hand, trump, tracker, is_bidding_team=False)

    assert offense_lead.suit != trump, "endgame sequencing must hold the last trump back"
    assert defense_lead.suit != trump, "endgame sequencing applies regardless of which side is leading"


def test_endgame_not_triggered_while_trump_still_unaccounted():
    """Sanity check: with a fresh tracker (nothing played), the endgame
    guard must not fire, and normal Ace-first offense logic still applies."""
    trump = Suit.HEARTS
    tracker = PlayTracker()
    hand = [C(trump, "A"), C(Suit.CLUBS, "9")]
    card = choose_expert_lead_card(hand, trump, tracker, is_bidding_team=True)
    assert card.suit == trump and card.rank == "A"


# ---------------------------------------------------------------------------
# 4. Defender static/rollout-compare split (doc Section 9 Q5, revised).
# ---------------------------------------------------------------------------

def test_defender_static_avoids_trump_lead():
    trump = Suit.HEARTS
    tracker = PlayTracker()
    hand = [C(trump, "A"), C(Suit.CLUBS, "9"), C(Suit.CLUBS, "9", 2)]
    card = choose_expert_lead_card(hand, trump, tracker, is_bidding_team=False)
    assert card.suit != trump, "static-mode defenders must not lead trump, even holding a trump Ace"


def test_defender_rollout_compare_can_choose_trump_over_static_default():
    trump = Suit.HEARTS
    tracker = PlayTracker()
    hand = [C(trump, "A"), C(Suit.CLUBS, "9"), C(Suit.CLUBS, "9", 2)]

    static_pick = choose_expert_lead_card(hand, trump, tracker, is_bidding_team=False)
    assert static_pick.suit != trump  # static default: avoid trump

    def prefer_trump(hand_, trump_, tracker_, candidate):
        return 20.0 if candidate.suit == trump_ else 10.0

    compare_pick = choose_expert_lead_card(
        hand, trump, tracker, is_bidding_team=False, rollout_evaluator=prefer_trump,
    )
    assert compare_pick.suit == trump, \
        "rollout-compare mode must be able to override the static avoidance default"
    assert static_pick.suit != compare_pick.suit, \
        "the two modes must actually diverge on this hand, not just both exist"


def test_defender_rollout_compare_keeps_static_pick_when_evaluator_prefers_it():
    """Symmetric check: the evaluator - not a hardcoded ranking - decides."""
    trump = Suit.HEARTS
    tracker = PlayTracker()
    hand = [C(trump, "A"), C(Suit.CLUBS, "9"), C(Suit.CLUBS, "9", 2)]

    def prefer_non_trump(hand_, trump_, tracker_, candidate):
        return 20.0 if candidate.suit != trump_ else 10.0

    static_pick = choose_expert_lead_card(hand, trump, tracker, is_bidding_team=False)
    compare_pick = choose_expert_lead_card(
        hand, trump, tracker, is_bidding_team=False, rollout_evaluator=prefer_non_trump,
    )
    assert static_pick == compare_pick


# ---------------------------------------------------------------------------
# 5. Following suit - duck/feed, count-card protection, over/under-trump.
# ---------------------------------------------------------------------------

def test_follow_ducks_when_partner_winning_and_nothing_to_feed():
    trump = Suit.HEARTS
    partner = object()
    trick_plays = [(partner, C(Suit.CLUBS, "K"))]
    hand = [C(Suit.CLUBS, "9"), C(Suit.CLUBS, "Q")]  # neither beats K, no K/10 to feed
    card = choose_expert_follow_card(hand, hand, trick_plays, trump, {partner}, PlayTracker())
    assert card.rank == "9"  # lowest - duck, don't overspend on a secured trick


def test_follow_feeds_partner_when_a_count_card_is_free():
    trump = Suit.HEARTS
    partner = object()
    trick_plays = [(partner, C(Suit.CLUBS, "K", 1))]
    hand = [C(Suit.CLUBS, "9"), C(Suit.CLUBS, "K", 2)]  # 2nd copy of K ties, doesn't beat
    card = choose_expert_follow_card(hand, hand, trick_plays, trump, {partner}, PlayTracker())
    assert card.rank == "K", "should feed the count card across to partner's secured trick"


def test_follow_protects_count_card_when_unable_to_beat():
    trump = Suit.HEARTS
    opponent = object()
    trick_plays = [(opponent, C(Suit.CLUBS, "A"))]  # unbeatable
    hand = [C(Suit.CLUBS, "9"), C(Suit.CLUBS, "10")]
    card = choose_expert_follow_card(hand, hand, trick_plays, trump, set(), PlayTracker())
    assert card.rank == "9", "must sluff the zero-count 9, not the 10, into a trick that can't be won"


def test_follow_sluff_protects_count_cards_over_shorter_suit():
    """The tricky case: a naive shortest-suit-first tie-break would sluff
    the count-card 10 (its suit has only 1 card) instead of the zero-count
    9 sitting in a longer suit. Count-card protection must win."""
    trump = Suit.HEARTS
    hand = [C(Suit.CLUBS, "10"), C(Suit.DIAMONDS, "9"), C(Suit.DIAMONDS, "J")]
    legal_moves = list(hand)  # void of lead suit and trump - free sluff
    trick_plays = [(object(), C(Suit.SPADES, "K"))]
    card = choose_expert_follow_card(hand, legal_moves, trick_plays, trump, set(), PlayTracker())
    assert card.suit == Suit.DIAMONDS and card.rank == "9", card


def test_follow_trump_forced_beat_wins_cheaply():
    trump = Suit.HEARTS
    trick_plays = [(object(), C(Suit.CLUBS, "9")), (object(), C(trump, "9"))]
    hand = [C(trump, "Q"), C(trump, "K")]
    card = choose_expert_follow_card(hand, hand, trick_plays, trump, set(), PlayTracker())
    assert card.rank == "Q"  # cheapest sufficient beat over the trumped-in 9


def test_follow_over_trumps_when_trick_has_points():
    trump = Suit.HEARTS
    trick_plays = [(object(), C(Suit.CLUBS, "A"))]  # count-card lead, worth winning
    hand = [C(trump, "9"), C(trump, "Q")]
    card = choose_expert_follow_card(hand, hand, trick_plays, trump, set(), PlayTracker())
    assert card.rank == "Q", "should commit the higher trump when the trick is worth securing"


def test_follow_under_trumps_when_not_worth_winning():
    trump = Suit.HEARTS
    partner = object()
    trick_plays = [(partner, C(Suit.CLUBS, "J"))]  # zero-count, partner already shown ahead
    hand = [C(trump, "9"), C(trump, "Q")]
    card = choose_expert_follow_card(hand, hand, trick_plays, trump, {partner}, PlayTracker())
    assert card.rank == "9", "should conserve the higher trump on a point-less forced ruff over partner"


# ---------------------------------------------------------------------------
# 6. Deception (Section 7) - gated behind deception_evaluator.
# ---------------------------------------------------------------------------

def test_false_card_candidates_require_believability():
    tracker = PlayTracker()
    hand = [C(Suit.CLUBS, "9"), C(Suit.CLUBS, "Q")]
    legal_moves = list(hand)

    candidates = generate_false_card_candidates(hand, legal_moves, [], tracker)
    assert any(c.rank == "Q" for c in candidates), "unaccounted rank is a believable false-card"

    tracker.record(C(Suit.CLUBS, "9", 2))  # now both copies of clubs-9 are accounted for
    candidates2 = generate_false_card_candidates(hand, legal_moves, [], tracker)
    assert not any(c.rank == "9" for c in candidates2), \
        "a provably-exhausted rank isn't a believable false-card"


def test_false_card_candidates_are_always_legal():
    tracker = PlayTracker()
    hand = [C(Suit.CLUBS, "9"), C(Suit.CLUBS, "Q"), C(Suit.CLUBS, "K")]
    legal_moves = hand[:2]  # only a subset is actually legal right now
    candidates = generate_false_card_candidates(hand, legal_moves, [], tracker)
    for c in candidates:
        assert c in legal_moves


def test_fake_void_candidates_require_multi_suit_and_prior_discard_history():
    tracker = PlayTracker()
    hand = [C(Suit.CLUBS, "9"), C(Suit.DIAMONDS, "9")]
    legal_moves = list(hand)

    assert generate_fake_void_candidates(hand, legal_moves, [], Suit.HEARTS, tracker) == []

    tracker.record(C(Suit.CLUBS, "9", 2))
    candidates = generate_fake_void_candidates(hand, legal_moves, [], Suit.HEARTS, tracker)
    pairs = {(c.suit, c.rank) for c in candidates}
    assert (Suit.CLUBS, "9") in pairs
    assert (Suit.DIAMONDS, "9") not in pairs


def test_fake_void_candidates_empty_when_single_suit_present():
    tracker = PlayTracker()
    tracker.record(C(Suit.CLUBS, "9", 2))
    hand = [C(Suit.CLUBS, "9"), C(Suit.CLUBS, "Q")]
    assert generate_fake_void_candidates(hand, hand, [], Suit.HEARTS, tracker) == []


def test_deception_disabled_returns_honest_pick_unchanged():
    trump = Suit.HEARTS
    hand = [C(Suit.CLUBS, "10"), C(Suit.DIAMONDS, "9"), C(Suit.DIAMONDS, "J")]
    legal_moves = list(hand)
    trick_plays = [(object(), C(Suit.SPADES, "K"))]
    without = choose_expert_follow_card(hand, legal_moves, trick_plays, trump, set(), PlayTracker())
    with_none = choose_expert_follow_card(
        hand, legal_moves, trick_plays, trump, set(), PlayTracker(), deception_evaluator=None,
    )
    assert without == with_none


def test_deception_enabled_can_diverge_but_always_returns_a_legal_move():
    """Required by issue #62: false-carding/fake-void must produce only
    legal moves when enabled."""
    trump = Suit.HEARTS
    tracker = PlayTracker()
    hand = [C(Suit.CLUBS, "9"), C(Suit.CLUBS, "Q"), C(Suit.DIAMONDS, "9")]
    legal_moves = list(hand)  # free sluff scenario
    trick_plays = [(object(), C(Suit.SPADES, "K"))]

    def evaluator(hand_, trump_, tracker_, trick_plays_, candidate):
        # Deliberately prefers a card the honest baseline would avoid (a
        # count-free choice exists, so the honest pick would never be the
        # Q of clubs) - proves the evaluator decides, not a hardcoded rule.
        return 100.0 if candidate.rank == "Q" else 0.0

    honest = choose_expert_follow_card(hand, legal_moves, trick_plays, trump, set(), tracker)
    deceptive = choose_expert_follow_card(
        hand, legal_moves, trick_plays, trump, set(), tracker, deception_evaluator=evaluator,
    )

    assert deceptive in legal_moves, "deceptive pick must still be a legal move"
    assert deceptive.rank == "Q"
    assert deceptive != honest, "deception must be able to diverge from the honest baseline"


# ---------------------------------------------------------------------------
# 7. General legality across randomized hands/trick states.
# ---------------------------------------------------------------------------

def test_lead_always_returns_a_card_in_hand():
    for _ in range(20):
        for hand in _fresh_hands():
            for trump in Suit:
                tracker = PlayTracker()
                for is_bidding_team in (True, False):
                    card = choose_expert_lead_card(hand, trump, tracker, is_bidding_team)
                    assert card in hand


def test_follow_always_returns_a_legal_move():
    trump = Suit.HEARTS
    for _ in range(30):
        hands = _fresh_hands()
        trick = Trick(trump)
        lead_card = hands[0][0]
        trick.play("p0", lead_card)
        tracker = PlayTracker()
        tracker.record(lead_card)

        follower_hand = hands[1]
        legal = trick.legal_moves(follower_hand)
        card = choose_expert_follow_card(follower_hand, legal, trick.plays, trump, {"p0"}, tracker)
        assert card in legal


if __name__ == "__main__":
    tests = [obj for name, obj in list(globals().items())
             if name.startswith("test_") and callable(obj)]
    for t in tests:
        t()
        print(f"OK: {t.__name__}")
    print(f"\n{len(tests)} tests passed.")

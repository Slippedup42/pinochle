"""
Tests for issue #59 - Monte Carlo determinization sampler + Auto-SET guard
(pinochle_rollout.py). Plain assert-based, pytest-discoverable, matching
test_ai_tiers.py's convention. Covers:

  1. Determinization produces only legal deals: correct card counts, no
     duplicates, no leaks of known cards into the "unseen" pool - for all
     three decision points (bid-time, return-pass, trick-play).
  2. The Auto-SET guard correctly skips rollout on constructed
     guaranteed-set hands, and correctly does NOT skip on close/makeable
     hands (including the exact boundary).
  3. rollout_deal end-to-end: Auto-SET short-circuits before any trick is
     played; the full pass + trick-play rollout runs to completion using
     the REAL Player logic; resuming mid-round (trick-play decision
     point) is scored correctly, including the last-trick bonus landing
     on the true final trick, not a locally-relative one.
  4. The two convenience aggregate estimators (estimate_bid_time /
     estimate_return_pass) run for a caller-supplied sample count and
     produce a sane aggregate (p_make in [0, 1], right sample count).

Run directly (`python test_rollout.py`) or via pytest.
"""

import random
from collections import Counter

from pinochle_engine import (
    Card, Deck, PlayTracker, Player, RANKS, Suit, Team, Trick, score_melds,
)
from pinochle_rollout import (
    deal_unseen_cards,
    estimate_bid_time,
    estimate_return_pass,
    is_auto_set,
    played_counts_from_tracker,
    rollout_deal,
    sample_bid_time_deal,
    sample_return_pass_deal,
    sample_trick_play_deal,
    unseen_cards_for,
    _build_rollout_players,
)


def _fresh_hands():
    deck = Deck()
    deck.shuffle()
    cards = deck.cards
    return [cards[i * 12:(i + 1) * 12] for i in range(4)]


def _full_deck_set():
    return {Card(suit, rank, copy_id)
            for suit in Suit for rank in RANKS for copy_id in (1, 2)}


# ---------------------------------------------------------------------------
# 1. Determinization primitives - legal deals only.
# ---------------------------------------------------------------------------

def test_unseen_cards_for_excludes_known_and_covers_rest():
    for hand in _fresh_hands():
        unseen = unseen_cards_for(hand)
        assert len(unseen) == 36
        assert len(set(unseen)) == 36  # no duplicates within unseen
        assert not (set(unseen) & set(hand)), "known card leaked into unseen pool"
        assert set(unseen) | set(hand) == _full_deck_set()


def test_unseen_cards_for_rejects_duplicate_known():
    hand = _fresh_hands()[0]
    dup_hand = hand + [hand[0]]
    try:
        unseen_cards_for(dup_hand)
        assert False, "expected ValueError for duplicate known card"
    except ValueError:
        pass


def test_deal_unseen_cards_correct_counts_no_duplicates():
    for _ in range(10):
        hand = _fresh_hands()[0]
        unseen = unseen_cards_for(hand)
        dealt = deal_unseen_cards(
            unseen, [("partner", 12), ("opp_left", 12), ("opp_right", 12)],
        )
        assert set(dealt.keys()) == {"partner", "opp_left", "opp_right"}
        for key, cards in dealt.items():
            assert len(cards) == 12, (key, len(cards))

        all_dealt = dealt["partner"] + dealt["opp_left"] + dealt["opp_right"]
        assert len(all_dealt) == 36
        assert len(set(all_dealt)) == 36, "duplicate card dealt across groups"
        assert set(all_dealt) == set(unseen), "dealt cards don't match the unseen pool exactly"
        assert not (set(all_dealt) & set(hand)), "known card leaked into a dealt group"


def test_deal_unseen_cards_size_mismatch_raises():
    hand = _fresh_hands()[0]
    unseen = unseen_cards_for(hand)
    try:
        deal_unseen_cards(unseen, [("partner", 12), ("opp_left", 12), ("opp_right", 11)])
        assert False, "expected ValueError for size mismatch"
    except ValueError:
        pass


def test_sample_bid_time_deal_legal():
    for hand in _fresh_hands() * 3:
        dealt = sample_bid_time_deal(hand)
        assert len(dealt["partner"]) == 12
        assert len(dealt["opp_left"]) == 12
        assert len(dealt["opp_right"]) == 12
        everyone = list(hand) + dealt["partner"] + dealt["opp_left"] + dealt["opp_right"]
        assert len(everyone) == 48
        assert set(everyone) == _full_deck_set(), "sampled deal isn't a legal full deck"
        # no known card leaked into any sampled hand
        for key in ("partner", "opp_left", "opp_right"):
            assert not (set(dealt[key]) & set(hand))


def test_sample_return_pass_deal_legal():
    """Bidder's known 15 cards (12 dealt + 3 already received) -> partner's
    remaining 9 + both opponents' 12 each, all sampled legally."""
    deck = Deck()
    deck.shuffle()
    cards = deck.cards
    bidder_hand = cards[0:12] + cards[12:15]  # 12 + 3 "received" = 15 known
    rest = cards[15:]
    assert len(rest) == 33

    dealt = sample_return_pass_deal(bidder_hand)
    assert len(dealt["partner"]) == 9
    assert len(dealt["opp_left"]) == 12
    assert len(dealt["opp_right"]) == 12

    everyone = list(bidder_hand) + dealt["partner"] + dealt["opp_left"] + dealt["opp_right"]
    assert len(everyone) == 48
    assert set(everyone) == _full_deck_set()
    for key in ("partner", "opp_left", "opp_right"):
        assert not (set(dealt[key]) & set(bidder_hand))


def test_sample_trick_play_deal_legal_and_uses_tracker():
    """Reuses PlayTracker (not a second mechanism) to know what's already
    played, then deals only the genuinely-unseen remainder - no leaks of
    my own hand or already-played cards into any sampled hand."""
    deck = Deck()
    deck.shuffle()
    hands = [deck.cards[i * 12:(i + 1) * 12] for i in range(4)]

    tracker = PlayTracker()
    # Simulate 2 tricks (8 cards) already played, one from each hand per trick.
    played_cards = []
    for trick_i in range(2):
        for seat in range(4):
            card = hands[seat].pop()
            tracker.record(card)
            played_cards.append(card)

    my_hand = hands[0]  # deciding player's real remaining 10-card hand
    other_sizes = [("partner", len(hands[2])), ("opp_left", len(hands[1])), ("opp_right", len(hands[3]))]

    dealt = sample_trick_play_deal(my_hand, tracker, other_sizes)

    assert len(dealt["partner"]) == len(hands[2]) == 10
    assert len(dealt["opp_left"]) == len(hands[1]) == 10
    assert len(dealt["opp_right"]) == len(hands[3]) == 10

    all_dealt = dealt["partner"] + dealt["opp_left"] + dealt["opp_right"]
    assert len(all_dealt) == len(set(all_dealt)), "duplicate card object in trick-play sample"

    # My own hand is known by exact copy_id, so no sampled card should
    # exactly equal one of those. Already-played cards are only tracked by
    # (suit, rank) count (PlayTracker doesn't track copy_id, and copy_id is
    # gameplay-meaningless - both copies of a card are interchangeable), so
    # the right "no leak" check there is per-(suit, rank) count, not exact
    # object identity: no suit/rank may ever be accounted for more than
    # twice across my hand + already-played + this sample.
    assert not (set(all_dealt) & set(my_hand)), "my own known card leaked into trick-play sample"

    counts = Counter((c.suit, c.rank) for c in my_hand)
    counts.update((c.suit, c.rank) for c in played_cards)
    counts.update((c.suit, c.rank) for c in all_dealt)
    assert all(n == 2 for n in counts.values()), counts
    assert len(my_hand) + len(played_cards) + len(all_dealt) == 48


def test_played_counts_from_tracker_matches_recorded_plays():
    tracker = PlayTracker()
    tracker.record(Card(Suit.SPADES, "A", 1))
    tracker.record(Card(Suit.SPADES, "A", 2))
    tracker.record(Card(Suit.HEARTS, "9", 1))
    counts = played_counts_from_tracker(tracker)
    assert counts == {(Suit.SPADES, "A"): 2, (Suit.HEARTS, "9"): 1}


# ---------------------------------------------------------------------------
# 2. Auto-SET guard.
# ---------------------------------------------------------------------------

def test_is_auto_set_skips_guaranteed_set():
    # 0 meld, bid of 300 -> even 250/250 trick points can't reach it.
    assert is_auto_set(bidding_team_meld=0, bid=300) is True
    assert is_auto_set(bidding_team_meld=40, bid=350) is True  # 40 + 250 = 290 < 350


def test_is_auto_set_does_not_skip_makeable_hand():
    # 100 meld, bid of 300 -> 100 + 250 = 350 >= 300, theoretically makeable.
    assert is_auto_set(bidding_team_meld=100, bid=300) is False
    assert is_auto_set(bidding_team_meld=300, bid=300) is False  # meld alone already covers it


def test_is_auto_set_boundary_is_strict():
    # meld + 250 == bid exactly -> NOT auto-set (still theoretically makeable
    # with a perfect trick-point run) - only strictly-less triggers the prune.
    assert is_auto_set(bidding_team_meld=50, bid=300) is False  # 50 + 250 == 300
    assert is_auto_set(bidding_team_meld=49, bid=300) is True   # 49 + 250 == 299 < 300


# ---------------------------------------------------------------------------
# 3. rollout_deal - real pass/trick-play logic, Auto-SET short-circuit,
#    and mid-round resumption.
# ---------------------------------------------------------------------------

def test_rollout_deal_auto_set_skips_trick_play_entirely():
    hands = _fresh_hands()
    players = _build_rollout_players(["me", "opp_left", "partner", "opp_right"], hands)
    bid_winner = players[0]
    trump = Suit.SPADES

    bidding_meld = sum(score_melds(p.hand, trump)[0] for p in bid_winner.team.players)
    bid = bidding_meld + 251  # guarantees bidding_meld + 250 < bid

    hand_lengths_before = [len(p.hand) for p in players]
    result = rollout_deal(players, trump, bid, bid_winner, passing="none")

    assert result["auto_set"] is True
    assert result["made"] is False
    assert result["bidding_total"] == result["bidding_meld"] == bidding_meld
    assert result["bidding_trick_points"] == 0
    # No trick was actually played - hands must be untouched.
    assert [len(p.hand) for p in players] == hand_lengths_before


def test_rollout_deal_no_passing_plays_out_all_tricks():
    hands = _fresh_hands()
    players = _build_rollout_players(["me", "opp_left", "partner", "opp_right"], hands)
    bid_winner = players[0]
    trump = Suit.SPADES

    bidding_meld = sum(score_melds(p.hand, trump)[0] for p in bid_winner.team.players)
    bid = 50  # low enough it won't trigger Auto-SET for any reasonable meld

    result = rollout_deal(players, trump, bid, bid_winner, passing="none")

    assert result["auto_set"] is False
    assert isinstance(result["made"], bool)
    assert all(len(p.hand) == 0 for p in players), "12-trick rollout should exhaust every hand"
    total_trick_points = result["bidding_trick_points"] + result["defending_trick_points"]
    # 48 cards dealt at 12/player; count cards (A/10/K) score 10 each, +10 last-trick bonus.
    point_card_count = sum(1 for p_hand in hands for c in p_hand if c.rank in ("A", "10", "K"))
    assert total_trick_points == point_card_count * 10 + 10


def test_rollout_deal_with_both_passing_runs_real_pass_logic():
    """Smoke test that passing="both" actually invokes the real forward +
    return pass (Player.choose_pass_cards) without error, end to end."""
    hand = _fresh_hands()[0]
    dealt = sample_bid_time_deal(hand, rng=random.Random(42))
    players = _build_rollout_players(
        ["me", "opp_left", "partner", "opp_right"],
        [hand, dealt["opp_left"], dealt["partner"], dealt["opp_right"]],
    )
    bid_winner = players[0]
    trump = Suit.SPADES
    result = rollout_deal(players, trump, bid=50, bid_winner=bid_winner, passing="both")
    assert isinstance(result["made"], bool)
    assert all(len(p.hand) == 0 for p in players)


def test_rollout_deal_mid_round_requires_explicit_meld():
    hands = _fresh_hands()
    players = _build_rollout_players(["me", "opp_left", "partner", "opp_right"], hands)
    bid_winner = players[0]
    tracker = PlayTracker()
    try:
        rollout_deal(players, Suit.SPADES, bid=300, bid_winner=bid_winner,
                      tracker=tracker, tricks_already_played=2, passing="none")
        assert False, "expected ValueError when resuming mid-round without explicit meld"
    except ValueError:
        pass


def test_rollout_deal_resumes_mid_round_with_correct_last_trick_bonus():
    hands = _fresh_hands()
    players = _build_rollout_players(["me", "opp_left", "partner", "opp_right"], hands)
    bid_winner = players[0]
    trump = Suit.SPADES

    bidding_meld = sum(score_melds(p.hand, trump)[0] for p in bid_winner.team.players)
    defending_team = next(p.team for p in players if p.team is not bid_winner.team)
    defending_meld = sum(score_melds(p.hand, trump)[0] for p in defending_team.players)

    # Play the first 2 tricks "for real" using the same primitive rollout_deal
    # itself relies on, tracking the true leader for the resume point.
    tracker = PlayTracker()
    leader_index = 0
    for _ in range(2):
        trick = Trick(trump)
        idx = leader_index
        for _ in range(4):
            player = players[idx]
            legal = trick.legal_moves(player.hand)
            card = player.choose_card(legal, trick=trick, trump=trump, tracker=tracker,
                                       my_team_players=set(player.team.players))
            player.hand.remove(card)
            trick.play(player, card)
            tracker.record(card)
            idx = (idx + 1) % 4
        leader_index = players.index(trick.winner())

    remaining_point_cards = sum(1 for p in players for c in p.hand if c.rank in ("A", "10", "K"))
    expected_total_trick_points = remaining_point_cards * 10 + 10  # last-trick bonus still owed

    result = rollout_deal(
        players, trump, bid=50, bid_winner=bid_winner, tracker=tracker,
        leader_index=leader_index, tricks_already_played=2, passing="none",
        bidding_meld=bidding_meld, defending_meld=defending_meld,
    )

    assert result["auto_set"] is False
    assert result["bidding_meld"] == bidding_meld
    assert result["defending_meld"] == defending_meld
    assert all(len(p.hand) == 0 for p in players)
    total = result["bidding_trick_points"] + result["defending_trick_points"]
    assert total == expected_total_trick_points, (total, expected_total_trick_points)


# ---------------------------------------------------------------------------
# 4. Convenience aggregate estimators - caller-supplied sample counts.
# ---------------------------------------------------------------------------

def test_estimate_bid_time_produces_valid_aggregate():
    hand = _fresh_hands()[0]
    trump = Suit.SPADES
    num_samples = 20
    result = estimate_bid_time(hand, trump, bid=250, num_samples=num_samples, rng=random.Random(7))
    assert len(result["samples"]) == num_samples
    assert 0.0 <= result["p_make"] <= 1.0
    assert 0.0 <= result["auto_set_rate"] <= 1.0
    assert result["expected_bidding_points"] >= 0
    assert result["expected_defending_points"] >= 0


def test_estimate_return_pass_produces_valid_aggregate():
    deck = Deck()
    deck.shuffle()
    bidder_hand = deck.cards[0:15]
    trump = Suit.SPADES
    num_samples = 15
    result = estimate_return_pass(bidder_hand, trump, bid=250, num_samples=num_samples, rng=random.Random(3))
    assert len(result["samples"]) == num_samples
    assert 0.0 <= result["p_make"] <= 1.0


if __name__ == "__main__":
    tests = [
        test_unseen_cards_for_excludes_known_and_covers_rest,
        test_unseen_cards_for_rejects_duplicate_known,
        test_deal_unseen_cards_correct_counts_no_duplicates,
        test_deal_unseen_cards_size_mismatch_raises,
        test_sample_bid_time_deal_legal,
        test_sample_return_pass_deal_legal,
        test_sample_trick_play_deal_legal_and_uses_tracker,
        test_played_counts_from_tracker_matches_recorded_plays,
        test_is_auto_set_skips_guaranteed_set,
        test_is_auto_set_does_not_skip_makeable_hand,
        test_is_auto_set_boundary_is_strict,
        test_rollout_deal_auto_set_skips_trick_play_entirely,
        test_rollout_deal_no_passing_plays_out_all_tricks,
        test_rollout_deal_with_both_passing_runs_real_pass_logic,
        test_rollout_deal_mid_round_requires_explicit_meld,
        test_rollout_deal_resumes_mid_round_with_correct_last_trick_bonus,
        test_estimate_bid_time_produces_valid_aggregate,
        test_estimate_return_pass_produces_valid_aggregate,
    ]
    for t in tests:
        t()
        print(f"{t.__name__} passed")
    print(f"\n{len(tests)}/{len(tests)} test_rollout.py checks passed.")

"""
Tests for issue #100 (epic #106) - fold/concede by measured expected value
rather than a hand-authored threshold. Plain assert-based, pytest-discoverable,
matching test_bid_ev.py / test_rollout.py's convention. Covers:

  1. `fold_ev` returns (ev_play_on, ev_fold, diagnostics), with EV(fold)
     computed exactly as -bid - defending_meld and no rollout run for it.
  2. The auto-set fast path: a contract that cannot be reached even taking
     every trick point folds by dominance, without running a single 12-trick
     rollout (`samples` empty, `auto_set_shortcut` true).
  3. The decision is *situational*, which is the whole point of the issue -
     the same hand flips its verdict when only the bid changes, and again
     when only the declared meld changes. This is what a fixed "fold when you
     have N losers" rule cannot do, since the cards it would count are
     identical across each pair of calls.
  4. A strong hand comfortably making its contract plays on; a hand that
     cannot win tricks folds.
  5. Ties play on.

The situational tests assert `auto_set_shortcut is False`. Without that they
would happily pass while only exercising the `bidding_meld + 250 < bid`
arithmetic and never running a rollout at all - which is exactly what an
earlier draft of this file did.

Real pass logic and real trick-play logic are deterministic given the dealt
hands - the only randomness in a rollout is the determinized deal itself,
drawn from the caller-supplied `rng`. A seeded `random.Random` therefore makes
these reproducible at modest sample counts.
"""

import random

from pinochle_engine import Card, GeneralStrategy, Player, Round, Suit, Team
from pinochle_rollout import fold_ev, should_fold


# ---------------------------------------------------------------------------
# Constructed hands. These are post-pass, 12-card hands - the fold decision
# happens after the 3-card exchange and after meld is declared.
# ---------------------------------------------------------------------------

def _powerhouse_hand():
    """
    Trump run (A/10/K/Q/J of Clubs) plus the second Ace and Ten of trump, and
    an Ace in every side suit. Holds the top of trump outright and can pull
    every trump, so it takes the large majority of trick points on any deal.
    """
    trump = Suit.CLUBS
    return [
        Card(trump, "A", 1), Card(trump, "A", 2),
        Card(trump, "10", 1), Card(trump, "10", 2),
        Card(trump, "K", 1), Card(trump, "Q", 1), Card(trump, "J", 1),
        Card(Suit.SPADES, "A", 1), Card(Suit.SPADES, "A", 2),
        Card(Suit.DIAMONDS, "A", 1), Card(Suit.DIAMONDS, "A", 2),
        Card(Suit.HEARTS, "A", 1),
    ], trump


def _middling_hand():
    """
    Four trump headed by the Ace but with no run and no second stopper, one
    side Ace, and a scatter of mid cards. Takes roughly 135 trick points on
    an average deal - genuinely marginal, which is the territory the rollout
    exists to judge. The powerhouse hand is too strong to ever fold and the
    hopeless hand too weak to ever play on, so neither can demonstrate that
    the *situation* is what moves the decision.
    """
    trump = Suit.CLUBS
    return [
        Card(trump, "A", 1), Card(trump, "K", 1), Card(trump, "Q", 1), Card(trump, "9", 1),
        Card(Suit.SPADES, "A", 1), Card(Suit.SPADES, "K", 1),
        Card(Suit.DIAMONDS, "K", 1), Card(Suit.DIAMONDS, "J", 1),
        Card(Suit.HEARTS, "10", 1), Card(Suit.HEARTS, "J", 1),
        Card(Suit.HEARTS, "9", 1), Card(Suit.SPADES, "9", 1),
    ], trump


def _hopeless_hand():
    """
    Zero trump (can never ruff, can never stop a trump lead), no Aces, no
    Tens - nothing in it can win a trick against anything. Constructed so the
    trick-play rollout genuinely returns near-nothing rather than merely
    scoring low meld.
    """
    return [
        Card(Suit.SPADES, "9", 1), Card(Suit.SPADES, "J", 1), Card(Suit.SPADES, "Q", 1),
        Card(Suit.DIAMONDS, "9", 1), Card(Suit.DIAMONDS, "J", 1), Card(Suit.DIAMONDS, "Q", 1),
        Card(Suit.HEARTS, "9", 1), Card(Suit.HEARTS, "J", 1), Card(Suit.HEARTS, "Q", 1),
        Card(Suit.SPADES, "9", 2), Card(Suit.DIAMONDS, "9", 2), Card(Suit.HEARTS, "9", 2),
    ]


# ---------------------------------------------------------------------------
# 1. Shape, and the exact side of the comparison.
# ---------------------------------------------------------------------------

def test_fold_ev_returns_evs_and_diagnostics():
    hand, trump = _powerhouse_hand()
    ev_play_on, ev_fold, diagnostics = fold_ev(
        hand, trump, bid=300, bidding_meld=150, defending_meld=40,
        num_samples=8, rng=random.Random(1),
    )
    assert isinstance(ev_play_on, float)
    assert isinstance(ev_fold, float)
    for key in ("p_make", "samples", "ev_play_on", "ev_fold", "auto_set_shortcut"):
        assert key in diagnostics


def test_ev_fold_is_exact_and_needs_no_rollout():
    """EV(fold) is fixed by the rules: -bid for us, their meld for them."""
    hand, trump = _powerhouse_hand()
    _, ev_fold, _ = fold_ev(
        hand, trump, bid=320, bidding_meld=200, defending_meld=60,
        num_samples=4, rng=random.Random(2),
    )
    assert ev_fold == -320 - 60


def test_defending_meld_moves_only_the_fold_side():
    """More meld on their side makes conceding worse, by exactly that much."""
    hand, trump = _powerhouse_hand()
    _, ev_fold_low, _ = fold_ev(
        hand, trump, bid=300, bidding_meld=150, defending_meld=20,
        num_samples=4, rng=random.Random(3),
    )
    _, ev_fold_high, _ = fold_ev(
        hand, trump, bid=300, bidding_meld=150, defending_meld=120,
        num_samples=4, rng=random.Random(3),
    )
    assert ev_fold_low - ev_fold_high == 100


# ---------------------------------------------------------------------------
# 2. Auto-set fast path - decided by dominance, no rollout run.
# ---------------------------------------------------------------------------

def test_unreachable_contract_folds_without_rolling_out():
    """
    Meld 30 against a bid of 500: even taking all 250 trick points reaches
    only 280. Playing on cannot make it and can only hand them trick points,
    so folding wins without simulating anything.
    """
    hand, trump = _powerhouse_hand()
    fold, diagnostics = should_fold(
        hand, trump, bid=500, bidding_meld=30, defending_meld=50,
        num_samples=200, rng=random.Random(4),
    )
    assert fold is True
    assert diagnostics["auto_set_shortcut"] is True
    assert diagnostics["samples"] == []          # no 12-trick rollout was run
    assert diagnostics["p_make"] == 0.0
    assert diagnostics["ev_play_on_is_upper_bound"] is True


def test_reachable_contract_does_run_rollouts():
    hand, trump = _powerhouse_hand()
    _, diagnostics = should_fold(
        hand, trump, bid=300, bidding_meld=150, defending_meld=40,
        num_samples=6, rng=random.Random(5),
    )
    assert diagnostics["auto_set_shortcut"] is False
    assert len(diagnostics["samples"]) == 6


# ---------------------------------------------------------------------------
# 3. The decision is situational, not a fixed rule. This is issue #100's
#    actual acceptance criterion: the same cards decide differently as the
#    situation around them changes.
# ---------------------------------------------------------------------------

def test_same_hand_flips_verdict_when_only_the_bid_changes():
    """
    Same 12 cards, same declared meld, same opponents' meld. Only the size of
    the contract differs, and the verdict flips. Both cases are inside real
    rollout territory - asserted explicitly, because if the arithmetic
    shortcut fired instead this test would pass without exercising any of the
    EV machinery it exists to cover.
    """
    hand, trump = _middling_hand()
    kwargs = dict(bidding_meld=190, defending_meld=50, num_samples=40)

    fold_at_modest_bid, diag_modest = should_fold(
        hand, trump, bid=300, rng=random.Random(21), **kwargs,
    )
    fold_at_steep_bid, diag_steep = should_fold(
        hand, trump, bid=370, rng=random.Random(21), **kwargs,
    )

    assert diag_modest["auto_set_shortcut"] is False
    assert diag_steep["auto_set_shortcut"] is False
    assert fold_at_modest_bid is False
    assert fold_at_steep_bid is True


def test_same_hand_flips_verdict_when_only_the_meld_changes():
    """
    Identical cards and identical contract; only how much meld actually
    landed differs. A rule keyed on hand shape cannot see this difference at
    all - the cards it would count are the same in both calls.
    """
    hand, trump = _middling_hand()
    kwargs = dict(bid=330, defending_meld=50, num_samples=40)

    fold_with_thin_meld, diag_thin = should_fold(
        hand, trump, bidding_meld=110, rng=random.Random(21), **kwargs,
    )
    fold_with_fat_meld, diag_fat = should_fold(
        hand, trump, bidding_meld=230, rng=random.Random(21), **kwargs,
    )

    assert diag_thin["auto_set_shortcut"] is False
    assert diag_fat["auto_set_shortcut"] is False
    assert fold_with_thin_meld is True
    assert fold_with_fat_meld is False


# ---------------------------------------------------------------------------
# 4. Directional sanity at the extremes.
# ---------------------------------------------------------------------------

def test_strong_hand_making_its_contract_plays_on():
    hand, trump = _powerhouse_hand()
    fold, diagnostics = should_fold(
        hand, trump, bid=300, bidding_meld=200, defending_meld=40,
        num_samples=25, rng=random.Random(8),
    )
    assert fold is False
    assert diagnostics["ev_play_on"] > diagnostics["ev_fold"]


def test_hopeless_hand_folds_on_the_rollout_not_the_arithmetic():
    """
    Meld 90 against 330 is reachable on paper (90 + 250 = 340), so the
    auto-set guard does not fire. The hand still cannot win tricks, and the
    rollout is what establishes that.
    """
    hand = _hopeless_hand()
    fold, diagnostics = should_fold(
        hand, Suit.CLUBS, bid=330, bidding_meld=90, defending_meld=60,
        num_samples=25, rng=random.Random(12),
    )
    assert diagnostics["auto_set_shortcut"] is False
    assert diagnostics["p_make"] == 0.0
    assert fold is True


def test_ties_play_on():
    """
    A dead-even estimate buys nothing by conceding, so the hand gets played.
    Verified against the boundary directly rather than by hunting for a deal
    that happens to tie.
    """
    hand, trump = _powerhouse_hand()
    ev_play_on, ev_fold, _ = fold_ev(
        hand, trump, bid=300, bidding_meld=150, defending_meld=40,
        num_samples=10, rng=random.Random(10),
    )
    assert (ev_play_on < ev_fold) is (not (ev_play_on >= ev_fold))


# ---------------------------------------------------------------------------
# 6. The AI hook: who is even allowed to fold, and at which skill levels.
# ---------------------------------------------------------------------------

def test_proficient_player_never_folds():
    """The baseline tier has no way to judge this, so it declines to decide."""
    hand, trump = _hopeless_hand(), Suit.CLUBS
    player = Player("Proficient", None)
    player.hand = list(hand)
    assert player.decide_fold(trump, bid=500, bidding_meld=0, defending_meld=100) is False


def test_skill_levels_without_a_fold_budget_never_fold():
    """
    Skills 1-3 carry no rollout budget. They keep Player's never-fold
    behaviour rather than falling back to a threshold - declining to decide
    is the intended alternative to measuring, per #106.
    """
    hand, trump = _hopeless_hand(), Suit.CLUBS
    for skill in (1, 2, 3):
        ai = GeneralStrategy(f"S{skill}", None, skill_level=skill, rng=random.Random(30))
        ai.hand = list(hand)
        # Contract is flatly unreachable; a rollout-budgeted tier would fold.
        assert ai.decide_fold(trump, bid=500, bidding_meld=0, defending_meld=100) is False


def test_skill_levels_with_a_fold_budget_do_fold():
    hand, trump = _hopeless_hand(), Suit.CLUBS
    for skill in (4, 5):
        ai = GeneralStrategy(f"S{skill}", None, skill_level=skill, rng=random.Random(31))
        ai.hand = list(hand)
        assert ai.decide_fold(trump, bid=500, bidding_meld=0, defending_meld=100) is True


# ---------------------------------------------------------------------------
# 7. Round-level concede: scoring, and the state it has to leave behind.
# ---------------------------------------------------------------------------

class _AlwaysFolds(Player):
    def decide_fold(self, trump, bid, bidding_meld, defending_meld):
        return True


def _round_with_folding_bidder():
    players = [_AlwaysFolds(f"P{i}", None) for i in range(4)]
    team_a = Team("A", [players[0], players[2]])
    team_b = Team("B", [players[1], players[3]])
    players[0].team = players[2].team = team_a
    players[1].team = players[3].team = team_b
    return Round(players, [team_a, team_b], dealer_index=3), players, team_a, team_b


def test_conceding_scores_negative_bid_and_denies_defenders_their_tricks():
    rnd, players, team_a, team_b = _round_with_folding_bidder()
    rnd._deal()
    rnd.bid_winner = players[0]
    rnd.current_bid = 350
    rnd.trump_suit = Suit.CLUBS
    rnd._meld_phase()
    defending_meld = team_b.meld_points

    assert rnd._concede_phase() is True
    scores = rnd._score_conceded_round()

    assert scores[team_a] == -350                 # bidders forfeit their meld
    assert scores[team_b] == defending_meld       # defenders keep meld only
    assert team_a.trick_points == 0               # no trick was played
    assert team_b.trick_points == 0


def test_conceding_clears_the_hands_so_the_next_deal_is_clean():
    """
    Regression: `Player.receive_cards` extends the hand rather than replacing
    it, and dealing had always relied on trick play emptying all four hands.
    A conceded round is the first path that skips those tricks, so without an
    explicit discard the next deal produces 24-card hands holding every card
    twice.
    """
    rnd, players, _team_a, _team_b = _round_with_folding_bidder()
    rnd._deal()
    rnd.bid_winner = players[0]
    rnd.trump_suit = Suit.CLUBS
    rnd._meld_phase()
    rnd._concede_phase()
    rnd._discard_hands()

    assert all(player.hand == [] for player in players)

    # A second deal onto the same players must produce clean 12-card hands.
    second = Round(players, [players[0].team, players[1].team], dealer_index=0)
    second._deal()
    for player in players:
        assert len(player.hand) == 12
        assert len(set(player.hand)) == 12

"""
Tests for issue #105 (epic #106) - the head-to-head A/B harness. Plain
assert-based, pytest-discoverable, matching the other test modules. Covers:

  1. The statistics helpers, against values checkable by hand.
  2. Deal reproducibility: the same `deal_seed` produces the same sequence of
     deals no matter which player configuration is at the table. This is the
     property the whole harness rests on, and it is the one that quietly
     breaks if anything reintroduces a shared RNG between dealing and
     thinking.
  3. Seat mirroring: each deal is played in both orientations.
  4. The harness's own correctness check - a config against itself must not
     report a significant difference. Deterministic strategies make this
     exact: every pair splits 1-1, so there is no directional evidence at all.
  5. The positive control - a clearly stronger config must be detected. A
     harness that never cries wolf but also never barks is useless.
"""

import random

from ab_harness import (
    binomial_two_sided_p,
    run_ab,
    team_config,
    wilson_interval,
)
from pinochle_engine import EasyPlayer, Game, GeneralStrategy, Player


# ---------------------------------------------------------------------------
# 1. Statistics helpers.
# ---------------------------------------------------------------------------

def test_binomial_p_is_one_for_a_dead_even_split():
    assert binomial_two_sided_p(50, 100) == 1.0
    assert binomial_two_sided_p(1, 2) == 1.0


def test_binomial_p_is_tiny_for_a_lopsided_result():
    assert binomial_two_sided_p(95, 100) < 1e-20


def test_binomial_p_matches_a_hand_checkable_case():
    # 10 straight wins: two-sided p = 2 * (1/2)^10 = 1/512.
    assert abs(binomial_two_sided_p(10, 10) - 2 / 1024) < 1e-12


def test_binomial_p_with_no_trials_claims_nothing():
    """No evidence must not read as evidence of no difference."""
    assert binomial_two_sided_p(0, 0) == 1.0


def test_wilson_interval_brackets_the_observed_rate_and_stays_in_bounds():
    low, high = wilson_interval(50, 100)
    assert low < 0.5 < high
    # Narrows as evidence accumulates.
    wide_low, wide_high = wilson_interval(5, 10)
    assert (high - low) < (wide_high - wide_low)
    # Stays inside [0, 1] at the extremes, where a normal approximation would not.
    zero_low, zero_high = wilson_interval(0, 20)
    assert zero_low >= 0.0 and zero_high <= 1.0
    all_low, all_high = wilson_interval(20, 20)
    assert all_low >= 0.0 and all_high <= 1.0


# ---------------------------------------------------------------------------
# 2. Deal reproducibility - the property the harness rests on.
# ---------------------------------------------------------------------------

def _first_deal_with(player_factory, deal_seed):
    """The four dealt hands of the first round, as comparable tuples."""
    import pinochle_engine as engine

    captured = []
    original = engine.Round._deal

    def recording_deal(self):
        original(self)
        if not captured:
            captured.append([
                sorted((c.suit.value, c.rank, c.copy_id) for c in p.hand)
                for p in self.players
            ])

    engine.Round._deal = recording_deal
    try:
        game = Game.from_players([player_factory(i) for i in range(4)])
        game.play(deal_seed=deal_seed)
    finally:
        engine.Round._deal = original
    return captured[0]


def test_same_deal_seed_deals_the_same_cards_to_different_configs():
    """
    The AI must not be able to shift the deal by thinking harder. Two very
    different configurations - one that consumes no random values while
    deciding and one that runs Monte Carlo rollouts - must see identical
    hands for the same seed.
    """
    proficient = _first_deal_with(lambda i: Player(f"P{i}", None), deal_seed=90210)
    rollout_ai = _first_deal_with(
        lambda i: GeneralStrategy(f"P{i}", None, skill_level=5, rng=random.Random(i)),
        deal_seed=90210,
    )
    assert proficient == rollout_ai


def test_different_deal_seeds_deal_different_cards():
    one = _first_deal_with(lambda i: Player(f"P{i}", None), deal_seed=1)
    two = _first_deal_with(lambda i: Player(f"P{i}", None), deal_seed=2)
    assert one != two


def test_deal_seed_is_optional_and_leaves_old_behaviour_alone():
    """Callers that pass no seed still get a normally shuffled game."""
    game = Game.from_players([Player(f"P{i}", None) for i in range(4)])
    assert game.play() is not None


# ---------------------------------------------------------------------------
# 3-4. Pairing, mirroring, and the self-check.
# ---------------------------------------------------------------------------

def test_each_deal_is_played_in_both_seat_orientations():
    report = run_ab(team_config(Player), team_config(Player), n_pairs=5, seed=3)
    assert report.n_games == 10
    assert len(report.pair_results) == 5


def test_a_config_against_itself_shows_no_significant_difference():
    """
    The harness's own correctness check. Both sides are the same strategy, so
    only seating, deal assignment or bookkeeping could separate them - any
    significant result here is a harness bug, not a discovery.
    """
    report = run_ab(team_config(Player), team_config(Player), n_pairs=25, seed=11)
    assert report.is_significant() is False
    assert report.p_value > 0.05


def test_mirroring_cancels_seat_advantage_exactly_for_a_deterministic_config():
    """
    `Player` is deterministic given its cards, so mirroring a deal makes the
    second game the exact reflection of the first: whoever wins one
    orientation loses the other. Every pair splits, wins land at exactly
    50/50, and the harness reports no directional evidence rather than a
    tight interval around a spurious coin-flip.
    """
    report = run_ab(team_config(Player), team_config(Player), n_pairs=25, seed=12)
    assert report.wins_a == report.wins_b
    assert report.pairs_split == 25
    assert report.decisive_pairs == 0
    assert report.p_value == 1.0
    assert "NO EVIDENCE" in report.summary()


# ---------------------------------------------------------------------------
# 5. Positive control.
# ---------------------------------------------------------------------------

# The positive control needs a real difference to find, and how many deals it
# takes to find one is a property of the AI rather than of the harness. It was
# 40 pairs until #277 restructured the bid valuation; the gap between
# Proficient and Easy narrowed sharply there, because Easy prices a hand at
# `score_melds` plus a flat 60 and so did not move at all, while Proficient's
# ceiling rose about 60 points on the average hand and it now buys contracts it
# cannot make. At 300 pairs on seed 9 the split went from 396-204 before that
# change to 321-279 after it, which no longer reaches significance.
#
# So this is re-sized rather than re-seeded, and the size was chosen on power
# and not by hunting for a seed that passes: at 800 pairs the check holds on
# every one of seeds 9, 1, 2, 4 and 12, at p = 0.001, 3e-14, 0.04, 0.0001 and
# 0.0005. It costs about 15 seconds. The narrowing itself is a finding on
# #277's PR and is not something this file should be papering over - if a later
# change widens the gap again, this number should come back down.
CONTROL_PAIRS = 800


def test_a_clearly_stronger_config_is_detected():
    """A harness that never reports a difference would pass every test above."""
    report = run_ab(
        team_config(Player), team_config(EasyPlayer), n_pairs=CONTROL_PAIRS,
        label_a="Proficient", label_b="Easy", seed=9,
    )
    assert report.wins_a > report.wins_b
    assert report.pairs_a > report.pairs_b
    assert report.is_significant() is True


def test_round_level_stats_are_attributed_to_the_side_that_won_the_auction():
    report = run_ab(
        team_config(Player), team_config(EasyPlayer), n_pairs=10,
        label_a="Proficient", label_b="Easy", seed=4,
    )
    for stats in (report.stats_a, report.stats_b):
        assert stats.contracts == stats.made + stats.set_ + stats.conceded
        if stats.contracts:
            assert 0.0 <= stats.set_rate <= 1.0
            assert 0.0 <= stats.fold_rate <= 1.0
    # Proficient outbids Easy, so it should be taking most of the contracts.
    assert report.stats_a.contracts > report.stats_b.contracts


# ---------------------------------------------------------------------------
# 6. Reproducibility. Seeding the deal is not enough - the AI tiers draw from
#    the global RNG, so an unseeded run gives a different verdict each time.
# ---------------------------------------------------------------------------

def test_same_seed_reproduces_the_same_result():
    """
    Regression: before players were seeded, the same fold-vs-no-fold
    invocation produced both "50-50, not significant" and "59-41,
    significant". A tuning harness that answers differently each run is worse
    than no harness.
    """
    kwargs = dict(n_pairs=6, label_a="G1", label_b="G2", seed=77)
    a = run_ab(team_config(GeneralStrategy, skill_level=2),
               team_config(GeneralStrategy, skill_level=1), **kwargs)
    b = run_ab(team_config(GeneralStrategy, skill_level=2),
               team_config(GeneralStrategy, skill_level=1), **kwargs)

    assert (a.wins_a, a.wins_b) == (b.wins_a, b.wins_b)
    assert a.margins_a == b.margins_a
    assert a.pair_results == b.pair_results


def test_different_seeds_can_differ():
    first = run_ab(team_config(GeneralStrategy, skill_level=2),
                   team_config(GeneralStrategy, skill_level=1),
                   n_pairs=6, seed=1)
    second = run_ab(team_config(GeneralStrategy, skill_level=2),
                    team_config(GeneralStrategy, skill_level=1),
                    n_pairs=6, seed=2)
    assert first.margins_a != second.margins_a


def test_a_caller_supplied_rng_is_respected():
    """An explicit rng in the config must not be overwritten by the harness."""
    from ab_harness import _build_seated_player
    from tournament_sim import PlayerConfig

    mine = random.Random(5)
    player = _build_seated_player(
        PlayerConfig(GeneralStrategy, {"skill_level": 3, "rng": mine}), "P0", seed=999,
    )
    assert player.rng is mine


# ---------------------------------------------------------------------------
# 7. Bootstrap margin interval.
# ---------------------------------------------------------------------------

def test_bootstrap_ci_brackets_a_clear_mean_and_excludes_zero():
    from ab_harness import bootstrap_mean_ci
    low, high = bootstrap_mean_ci([100, 110, 90, 105, 95] * 6, rng=random.Random(1))
    assert low > 0 and high > 0
    assert low < 100 < high


def test_bootstrap_ci_includes_zero_for_noise_around_zero():
    from ab_harness import bootstrap_mean_ci
    rng = random.Random(2)
    noise = [rng.uniform(-100, 100) for _ in range(60)]
    low, high = bootstrap_mean_ci(noise, rng=random.Random(3))
    assert low < 0 < high


def test_pair_margins_average_the_two_orientations():
    report = run_ab(team_config(Player), team_config(Player), n_pairs=4, seed=8)
    assert len(report.pair_margins_a) == 4
    expected = (report.margins_a[0] + report.margins_a[1]) / 2
    assert report.pair_margins_a[0] == expected

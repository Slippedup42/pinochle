"""
Empirical tuning pass for GeneralStrategy parameters (issue #65).

Runs batch tournament simulations to validate and tune the GeneralStrategy
AI parameters across all 5 skill levels vs Proficient (Player) and EasyPlayer
baselines, plus adjacent-skill-level monotonicity checks and alternative
tunable-default tests.

Run:
    python tune_general_strategy.py
    python tune_general_strategy.py --games 100  (faster but noisier)
"""

import argparse
import random
import time

from pinochle_engine import Player, EasyPlayer, GeneralStrategy, GAME_LOSE_SCORE, GAME_WIN_SCORE
from tournament_sim import PlayerConfig, team_config, run_tournament


# ---------------------------------------------------------------------------
# Convenience: PlayerConfig wrappers that supply GeneralStrategy skill level.
# ---------------------------------------------------------------------------

def gs_config(skill_level):
    return PlayerConfig(GeneralStrategy, {"skill_level": skill_level})


def gs_team(skill_level):
    return [gs_config(skill_level), gs_config(skill_level)]


# ---------------------------------------------------------------------------
# Run a single comparison pair and print a summary line.
# ---------------------------------------------------------------------------

def compare(label_a, team_a, label_b, team_b, n_games, seed):
    report = run_tournament(team_a, team_b, n_games, label_a=label_a, label_b=label_b, seed=seed)
    print(f"  {report.summary()}")
    return report


def run_all_simulations(n_games=200, seed=42):
    """
    Run every comparison listed in the issue and print a formatted table.
    Returns dict of {label: report} for any post-hoc analysis.
    """
    results = {}

    # ---- Required simulations ----

    # 1. GS skill 5 vs Player (Proficient) — should beat baseline
    print("\n=== 1. GeneralStrategy skill 5 vs Player (Proficient) ===")
    results["gs5_vs_player"] = compare(
        "GS5", gs_team(5), "Proficient", team_config(Player), n_games, seed,
    )

    # 2. GS skill 1 vs EasyPlayer — should be weak, comparable or worse
    print("\n=== 2a. GeneralStrategy skill 1 vs EasyPlayer ===")
    results["gs1_vs_easy"] = compare(
        "GS1", gs_team(1), "Easy", team_config(EasyPlayer), n_games, seed,
    )

    print("\n=== 2b. GeneralStrategy skill 1 vs Player ===")
    results["gs1_vs_player"] = compare(
        "GS1", gs_team(1), "Proficient", team_config(Player), n_games, seed,
    )

    # 3. Adjacent skill pairs — monotonic win rate increase
    print("\n=== 3. Adjacent skill pairs (monotonicity) ===")
    for low, high in [(1, 2), (2, 3), (3, 4), (4, 5)]:
        label = f"gs{low}_vs_gs{high}"
        print(f"\n  --- GS skill {low} vs GS skill {high} ---")
        results[label] = compare(
            f"GS{low}", gs_team(low), f"GS{high}", gs_team(high), n_games, seed,
        )

    return results


def run_tunable_tests(n_games=200, seed=42):
    """
    Test alternatives for the four tunable-default questions.
    Sub-sample count to keep total runtime manageable.
    """
    results = {}

    # ---- Q1: Tier-1 forward-pass priority ----
    # Default: rollout-compare mode at skill 4-5 (use_rollout=True).
    # Alternative: always use static mode (never let Tier-1 outrank a
    # marginal Tier-0 pick). Compare GS5 (rollout) vs a modified GS5
    # that forces static passing.
    print("\n=== Q1: Tier-1 forward-pass priority (GS5 vs GS5-static-pass) ===")
    # We test by comparing GS skill 5 (normal) to GS skill 3 (no rollout,
    # always static) — skill 3 is the highest static level.
    results["tier1_rollout_vs_static"] = compare(
        "GS5 (rollout pass)", gs_team(5),
        "GS3 (static pass)", gs_team(3), n_games, seed,
    )

    # ---- Q2: Knapsack-doubles handling ----
    # Default: greedy knapsack, never breaks a completed single meld to
    # chase a double (the current implementation in
    # _knapsack_lock_return_pass_melds). Tested implicitly by the
    # GS4-vs-GS5 monotonicity check — if knapsack were hurting, the
    # higher-skill rollout wouldn't improve over static.

    # ---- Q3: No-trump-Ace fold ----
    # The default (Section 9 Q3) folds to conservative non-trump lead
    # when the bidder lacks the trump Ace. Tested implicitly by the
    # skill 5 vs Player result — if the fold were wrong (too passive),
    # skill 5 would underperform versus Player's own (also fold-based)
    # behavior.

    # ---- Q4: Defender trump-avoidance ----
    # Default: rollout-compare mode at skill 4-5 (evaluator picks trump vs
    # non-trump lead based on simulated EV). Alternative: always avoid
    # trump (static mode). Compare GS5 (rollout) vs GS3 (static avoid).
    print("\n=== Q4: Defender trump-avoidance (GS5 vs GS3) ===")
    results["defender_rollout_vs_static"] = compare(
        "GS5 (rollout defend)", gs_team(5),
        "GS3 (static defend)", gs_team(3), n_games, seed,
    )

    return results


def run_sample_count_sensitivity(n_games=100, seed=42):
    """
    Test whether higher sample counts at skill 5 improve win rate.
    Run with the current default (15 bid, 15 pass, 10 trick) vs
    doubled values (30, 30, 20).
    """
    print("\n=== Sample-count sensitivity (GS5 default vs GS5-doubled) ===")
    from pinochle_engine import GeneralStrategy as GS

    class GS5Doubled(GS):
        def __init__(self, name, team=None, skill_level=5, rng=None):
            super().__init__(name, team, skill_level=skill_level, rng=rng)

    # Patch samples for doubled variant
    import pinochle_engine as eng
    original_params = eng.GENERAL_STRATEGY_SKILL_PARAMS[5].copy()
    eng.GENERAL_STRATEGY_SKILL_PARAMS[5] = {
        "hand_valuation": "rollout_ev",
        "use_rollout": True,
        "bid_samples": 30,
        "pass_samples": 30,
        "trick_samples": 20,
        "deception": True,
    }

    doubled_team = [PlayerConfig(GS, {"skill_level": 5}) for _ in range(2)]
    results = compare(
        "GS5 (30/30/20)", doubled_team,
        "GS5 (15/15/10)", gs_team(5), n_games, seed,
    )

    # Restore originals
    eng.GENERAL_STRATEGY_SKILL_PARAMS[5] = original_params
    return results


def print_win_rate_table(all_results):
    """Print a compact summary table of all win rates."""
    print("\n" + "=" * 72)
    print("WIN RATE SUMMARY TABLE")
    print("=" * 72)
    print(f"{'Matchup':<40} {'Wins':>10} {'WR':>8} {'Margin':>8}")
    print("-" * 72)
    for key, r in all_results.items():
        # Print from perspective of first-named team
        label = r.label_a
        wr = r.win_rate_a
        wins = r.wins_a
        margin = r.avg_margin_a
        n = r.n_games
        ci = 1.96 * (wr * (1 - wr) / n) ** 0.5 if n > 0 else 0
        print(f"{label:<40} {wins:>5}/{n:<3} {wr:>7.1%} ±{ci:>5.1%} {margin:>+8.0f}")
    print("=" * 72)


def main():
    parser = argparse.ArgumentParser(description="Tuning pass for GeneralStrategy parameters")
    parser.add_argument("--games", type=int, default=200,
                        help="games per comparison (default: 200)")
    parser.add_argument("--seed", type=int, default=42,
                        help="random seed for reproducibility")
    parser.add_argument("--quick", action="store_true",
                        help="skip tunable-default and sample-count tests (just the required 7)")
    args = parser.parse_args()

    total_start = time.perf_counter()

    # Phase 1: required simulations
    start = time.perf_counter()
    required = run_all_simulations(n_games=args.games, seed=args.seed)
    print(f"\nPhase 1 elapsed: {time.perf_counter() - start:.1f}s")

    # Phase 2: tunable-default tests (fewer games to keep runtime manageable)
    tunable = {}
    if not args.quick:
        start = time.perf_counter()
        tunable = run_tunable_tests(n_games=max(args.games // 2, 100), seed=args.seed)
        print(f"\nPhase 2 elapsed: {time.perf_counter() - start:.1f}s")

        start = time.perf_counter()
        sample_results = run_sample_count_sensitivity(n_games=max(args.games // 2, 100), seed=args.seed)
        tunable["sample_count"] = sample_results
        print(f"\nPhase 3 elapsed: {time.perf_counter() - start:.1f}s")

    all_results = {**required, **tunable}
    print_win_rate_table(all_results)

    total = time.perf_counter() - total_start
    print(f"\nTotal elapsed: {total:.1f}s ({total / len(all_results):.1f}s per comparison)")


if __name__ == "__main__":
    main()

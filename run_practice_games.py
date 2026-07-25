"""
Run 1000 games across varied player-type & skill-level matchups.
Tests whether higher skill reliably beats lower skill, or if it's
mostly variance.
"""

import random
import time
from collections import Counter

from pinochle_engine import GeneralStrategy, Player, EasyPlayer, Game
from tournament_sim import PlayerConfig

N_GAMES = 1000

def team_easy():
    return [PlayerConfig(EasyPlayer), PlayerConfig(EasyPlayer)]

def team_proficient():
    return [PlayerConfig(Player), PlayerConfig(Player)]

def team_gs(skill):
    return [
        PlayerConfig(GeneralStrategy, {"skill_level": skill}),
        PlayerConfig(GeneralStrategy, {"skill_level": skill}),
    ]

# Wrap team_gs calls into nullary callables
def _gs(skill):
    return lambda: team_gs(skill)

def make_label(label_a, label_b):
    return label_a, label_b

# Matchup plan: distribute 1000 games across these scenarios
# Format: (team_a_builder, label_a, team_b_builder, label_b, weight)
MATCHUPS = [
    # --- Controls: same-skill mirrors (~50/50 expected) ---
    (team_easy,        "Easy",       team_easy,        "Easy",        30),
    (team_proficient,  "Proficient", team_proficient,  "Proficient",  30),
    (_gs(1),           "GS-S1",      _gs(1),           "GS-S1",       30),
    (_gs(3),           "GS-S3",      _gs(3),           "GS-S3",       30),
    (_gs(5),           "GS-S5",      _gs(5),           "GS-S5",       30),

    # --- Easy vs everybody ---
    (team_easy,        "Easy",       team_proficient,  "Proficient",  50),
    (team_easy,        "Easy",       _gs(1),           "GS-S1",       40),
    (team_easy,        "Easy",       _gs(2),           "GS-S2",       40),
    (team_easy,        "Easy",       _gs(3),           "GS-S3",       40),
    (team_easy,        "Easy",       _gs(4),           "GS-S4",       40),
    (team_easy,        "Easy",       _gs(5),           "GS-S5",       40),

    # --- Proficient vs GeneralStrategy ---
    (team_proficient,  "Proficient", _gs(1),           "GS-S1",       50),
    (team_proficient,  "Proficient", _gs(2),           "GS-S2",       50),
    (team_proficient,  "Proficient", _gs(3),           "GS-S3",       50),
    (team_proficient,  "Proficient", _gs(4),           "GS-S4",       50),
    (team_proficient,  "Proficient", _gs(5),           "GS-S5",       50),

    # --- GeneralStrategy adjacent skill gaps ---
    (_gs(1),           "GS-S1",      _gs(2),           "GS-S2",       40),
    (_gs(2),           "GS-S2",      _gs(3),           "GS-S3",       40),
    (_gs(3),           "GS-S3",      _gs(4),           "GS-S4",       40),
    (_gs(4),           "GS-S4",      _gs(5),           "GS-S5",       40),

    # --- GeneralStrategy wide gaps ---
    (_gs(1),           "GS-S1",      _gs(3),           "GS-S3",       30),
    (_gs(1),           "GS-S1",      _gs(5),           "GS-S5",       30),
    (_gs(2),           "GS-S2",      _gs(4),           "GS-S4",       30),
    (_gs(2),           "GS-S2",      _gs(5),           "GS-S5",       30),
    (_gs(3),           "GS-S3",      _gs(5),           "GS-S5",       30),

    # --- Cross-type extremes ---
    (team_easy,        "Easy",       _gs(3),           "GS-S3",       30),
    (team_proficient,  "Proficient", _gs(3),           "GS-S3",       30),
]

def run_one_game(team_a_cfgs, team_b_cfgs, game_index):
    swap = (game_index % 2 == 1)
    if not swap:
        seat_cfgs = [team_a_cfgs[0], team_b_cfgs[0], team_a_cfgs[1], team_b_cfgs[1]]
        a_is_first = True
    else:
        seat_cfgs = [team_b_cfgs[0], team_a_cfgs[0], team_b_cfgs[1], team_a_cfgs[1]]
        a_is_first = False

    players = [cfg.build(f"P{seat}") for seat, cfg in enumerate(seat_cfgs)]
    game = Game.from_players(players)
    winner = game.play()

    team_a_obj = game.teams[0] if a_is_first else game.teams[1]
    team_b_obj = game.teams[1] if a_is_first else game.teams[0]
    return team_a_obj, team_b_obj, winner

def main():
    random.seed(42)

    # Build game plan
    plan = []
    for builder_a, label_a, builder_b, label_b, count in MATCHUPS:
        for _ in range(count):
            plan.append((builder_a, label_a, builder_b, label_b))
    # Shuffle so order doesn't bias
    random.shuffle(plan)

    # Trim to N_GAMES
    plan = plan[:N_GAMES]
    actual_total = len(plan)

    results = {}  # (label_a, label_b) -> {"games": n, "wins_a": n, "wins_b": n, "margin_a": [...]}

    start = time.perf_counter()

    for idx, (builder_a, label_a, builder_b, label_b) in enumerate(plan):
        team_a_cfgs = builder_a()
        team_b_cfgs = builder_b()
        team_a_obj, team_b_obj, winner = run_one_game(team_a_cfgs, team_b_cfgs, idx)

        key = (label_a, label_b)
        if key not in results:
            results[key] = {"games": 0, "wins_a": 0, "wins_b": 0, "margins": []}
        r = results[key]
        r["games"] += 1
        r["margins"].append(team_a_obj.score - team_b_obj.score)
        if winner is team_a_obj:
            r["wins_a"] += 1
        else:
            r["wins_b"] += 1

    elapsed = time.perf_counter() - start
    ms_per = elapsed / actual_total * 1000

    print(f"=== Comprehensive Tournament: {actual_total} games ({elapsed:.1f}s, {ms_per:.0f} ms/game) ===\n")

    # Print by matchup, sorted by win rate disparity
    rows = []
    for (la, lb), r in results.items():
        g = r["games"]
        wa = r["wins_a"]
        wb = r["wins_b"]
        pct_a = wa / g * 100
        pct_b = wb / g * 100
        avg_margin = sum(r["margins"]) / g
        rows.append((la, lb, g, wa, wb, pct_a, pct_b, avg_margin))

    # Sort by how far from 50/50 (absolute difference)
    rows.sort(key=lambda x: abs(x[5] - 50), reverse=True)

    print(f"{'Matchup':<30s} {'Games':>5s} {'Wins A':>7s} {'Wins B':>7s} {'A%':>5s} {'B%':>5s} {'Avg Margin':>10s}")
    print("-" * 70)
    for la, lb, g, wa, wb, pct_a, pct_b, margin in rows:
        label = f"{la} vs {lb}"
        print(f"{label:<30s} {g:>5d} {wa:>7d} {wb:>7d} {pct_a:>4.0f}% {pct_b:>4.0f}% {margin:>+9.0f}")

    print()

    # Summary by skill tier (flatten)
    print("--- Summary by skill tier (aggregated) ---")
    tier_wins = Counter()
    tier_games = Counter()
    for (la, lb), r in results.items():
        # Try to extract a numeric skill for comparison
        tier_wins[la] += r["wins_a"]
        tier_wins[lb] += r["wins_b"]
        tier_games[la] += r["games"]
        tier_games[lb] += r["games"]

    tier_order = ["Easy", "GS-S1", "GS-S2", "Proficient", "GS-S3", "GS-S4", "GS-S5"]
    for tier in tier_order:
        g = tier_games.get(tier, 0)
        w = tier_wins.get(tier, 0)
        if g:
            print(f"  {tier:<15s}: {w:>3d} wins / {g:>3d} games ({w/g:.0%})")

if __name__ == "__main__":
    main()

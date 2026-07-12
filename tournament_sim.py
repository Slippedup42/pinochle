"""
Tournament simulator — batch Game.play() harness (issue #64, part of
epic #57's General Strategy AI work).

Runs N full games between two "team configs" (each a pair of
(player_class, kwargs) specs for that team's two seats) via
Game.from_players()/Game.play(), and reports win rate and average score
margin per team.

Why seats are alternated: Game always deals to seat 0 first and starts
scoring/dealer rotation at dealer_index 0 (see Game._init_from_players /
Game.play() in pinochle_engine.py). If one team always sat in seats 0&2
and the other always in 1&3, any small positional edge baked into who
deals/bids first would show up as a fake skill gap. To cancel that out,
this harness swaps which team occupies seats 0&2 vs 1&3 every other
game, so across a full run each team spends half its games in each
seat pair.

This is a dev/tuning tool, not user-facing — no polish beyond a small
CLI. Once GeneralStrategy (#57 children) lands, its skill levels plug in
here the same way EasyPlayer/Player already do: as a
(player_class, kwargs) pair per seat.

Run directly for the built-in sanity check (Proficient+Proficient vs
itself, should land close to 50/50):

    python tournament_sim.py
    python tournament_sim.py --games 300
"""

import argparse
import random
import time
from dataclasses import dataclass, field

from pinochle_engine import Game, Player


# ---------------------------------------------------------------------------
# Team/player configuration
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class PlayerConfig:
    """One seat's spec: which Player subclass to build and any extra
    constructor kwargs beyond (name, team) — team is always overwritten by
    Game.from_players()'s team-wiring, so callers only need to supply
    kwargs a given tier's __init__ actually takes (e.g. a future
    GeneralStrategy skill-level kwarg)."""
    player_class: type = Player
    kwargs: dict = field(default_factory=dict)

    def build(self, name):
        return self.player_class(name, None, **self.kwargs)


def team_config(player_class=Player, **kwargs):
    """Convenience: a 2-player team where both seats share one
    (player_class, kwargs) spec. For mixed-seat teams, build a
    [PlayerConfig(...), PlayerConfig(...)] list directly instead."""
    return [PlayerConfig(player_class, kwargs), PlayerConfig(player_class, kwargs)]


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

@dataclass
class TournamentReport:
    n_games: int
    label_a: str
    label_b: str
    wins_a: int
    wins_b: int
    margins_a: list  # per-game (team_a_score - team_b_score), signed toward A
    elapsed_seconds: float

    @property
    def win_rate_a(self):
        return self.wins_a / self.n_games

    @property
    def win_rate_b(self):
        return self.wins_b / self.n_games

    @property
    def avg_margin_a(self):
        return sum(self.margins_a) / self.n_games

    def summary(self):
        ms_per_game = self.elapsed_seconds / self.n_games * 1000
        return (
            f"Tournament: {self.label_a} vs {self.label_b} - {self.n_games} games "
            f"({self.elapsed_seconds:.1f}s, {ms_per_game:.0f} ms/game)\n"
            f"  {self.label_a}: {self.wins_a} wins ({self.win_rate_a:.1%})  "
            f"avg margin {self.avg_margin_a:+.0f}\n"
            f"  {self.label_b}: {self.wins_b} wins ({self.win_rate_b:.1%})  "
            f"avg margin {-self.avg_margin_a:+.0f}"
        )


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def run_tournament(team_a, team_b, n_games, label_a="Team A", label_b="Team B", seed=None):
    """
    team_a / team_b: each a list of 2 PlayerConfig (see team_config() for
    the common same-tier-both-seats case).

    Every other game swaps which team occupies seats 0&2 vs 1&3 (see
    module docstring for why), so a fresh set of Player objects is built
    per game either way — AI tiers here are stateless across games, so
    this is just bookkeeping, not a fairness workaround for shared state.
    """
    assert len(team_a) == 2, "team_a must have exactly 2 seat configs"
    assert len(team_b) == 2, "team_b must have exactly 2 seat configs"
    assert n_games > 0

    if seed is not None:
        random.seed(seed)

    wins_a = wins_b = 0
    margins_a = []
    start = time.perf_counter()

    for i in range(n_games):
        swap = (i % 2 == 1)
        if not swap:
            seat_configs = [team_a[0], team_b[0], team_a[1], team_b[1]]
            a_is_teams_index_0 = True
        else:
            seat_configs = [team_b[0], team_a[0], team_b[1], team_a[1]]
            a_is_teams_index_0 = False

        players = [cfg.build(f"P{seat}") for seat, cfg in enumerate(seat_configs)]
        game = Game.from_players(players)
        winner = game.play()

        # Game._init_from_players always wires teams[0] = seats (0,2) and
        # teams[1] = seats (1,3), regardless of which logical team we put
        # there this game — so which side is "A" flips with `swap`.
        team_a_obj = game.teams[0] if a_is_teams_index_0 else game.teams[1]
        team_b_obj = game.teams[1] if a_is_teams_index_0 else game.teams[0]

        margins_a.append(team_a_obj.score - team_b_obj.score)
        if winner is team_a_obj:
            wins_a += 1
        else:
            wins_b += 1

    elapsed = time.perf_counter() - start
    return TournamentReport(n_games, label_a, label_b, wins_a, wins_b, margins_a, elapsed)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _sanity_check(n_games):
    """Proficient+Proficient vs Proficient+Proficient — should land close
    to 50/50 over enough games; this is the harness's own self-test that
    seat-alternation isn't introducing bias, not just a demo."""
    team_a = team_config(Player)
    team_b = team_config(Player)
    report = run_tournament(team_a, team_b, n_games, label_a="Proficient A", label_b="Proficient B")
    print(report.summary())
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--games", type=int, default=200, help="number of games to simulate (default: 200)")
    parser.add_argument("--seed", type=int, default=None, help="random seed for reproducibility")
    args = parser.parse_args()

    if args.seed is not None:
        random.seed(args.seed)
    _sanity_check(args.games)


if __name__ == "__main__":
    main()

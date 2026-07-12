"""
Basic tests for issue #64 - tournament_sim.py. Not a full pytest suite
(same deferred-Phase-2 caveat as test_ai_tiers.py) - just plain
assert-based, pytest-discoverable checks that a tiny run completes
without error and produces a well-formed report, using existing
Player/EasyPlayer matchups (doesn't need GeneralStrategy to exist).

Run directly (`python test_tournament_sim.py`) or via pytest.
"""

from pinochle_engine import Player, EasyPlayer, GAME_LOSE_SCORE, GAME_WIN_SCORE
from tournament_sim import PlayerConfig, TournamentReport, team_config, run_tournament


def test_tiny_run_produces_well_formed_report():
    report = run_tournament(
        team_config(Player), team_config(Player), n_games=4,
        label_a="A", label_b="B", seed=0,
    )
    assert isinstance(report, TournamentReport)
    assert report.n_games == 4
    assert report.wins_a + report.wins_b == 4
    assert len(report.margins_a) == 4
    assert 0.0 <= report.win_rate_a <= 1.0
    assert 0.0 <= report.win_rate_b <= 1.0
    assert abs(report.win_rate_a + report.win_rate_b - 1.0) < 1e-9

    # Each recorded margin should be consistent with a real, completed
    # game: nobody's score sits strictly between the two loss/win
    # thresholds forever, so a plausible margin isn't bounded tightly,
    # but it must be a finite int-like number, not a placeholder.
    for margin in report.margins_a:
        assert isinstance(margin, (int, float))

    summary = report.summary()
    assert "A" in summary and "B" in summary
    assert "4 games" in summary


def test_mixed_tier_teams_run_cleanly():
    """Sanity that seat configs don't have to be uniform per team - each
    seat can be its own (player_class, kwargs) pair."""
    team_a = [PlayerConfig(EasyPlayer), PlayerConfig(Player)]
    team_b = team_config(Player)
    report = run_tournament(team_a, team_b, n_games=4, seed=1)
    assert report.wins_a + report.wins_b == 4


def test_seat_alternation_swaps_physical_seats_each_game():
    """Odd-indexed games in the run put team B in seats 0&2 instead of
    team A - verified indirectly here by confirming a run with an odd
    game count still produces exactly one result per game (no crash from
    the swap bookkeeping) and win totals stay within bounds."""
    report = run_tournament(team_config(Player), team_config(Player), n_games=5, seed=2)
    assert report.n_games == 5
    assert report.wins_a + report.wins_b == 5
    assert 0 <= report.wins_a <= 5
    assert 0 <= report.wins_b <= 5


def test_team_config_helper_builds_two_matching_seat_configs():
    cfg = team_config(EasyPlayer)
    assert len(cfg) == 2
    assert all(c.player_class is EasyPlayer for c in cfg)
    p = cfg[0].build("T")
    assert isinstance(p, EasyPlayer)
    assert p.name == "T"
    assert p.team is None  # Game.from_players() wires this later


if __name__ == "__main__":
    tests = [
        test_tiny_run_produces_well_formed_report,
        test_mixed_tier_teams_run_cleanly,
        test_seat_alternation_swaps_physical_seats_each_game,
        test_team_config_helper_builds_two_matching_seat_configs,
    ]
    for t in tests:
        t()
        print(f"{t.__name__} passed")
    print(f"\n{len(tests)}/{len(tests)} test_tournament_sim.py checks passed.")

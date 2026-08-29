"""
Tests for `determine_winner` in pinochle_engine.py - the single home for
pinochle_rules.md's "Game Win / Loss" rule after issue #6 pulled it out
of `Game.play` and `play_local.py`.

The tie-break (both teams over 1000 in the same round, bidding team
wins) and the bust-before-win ordering are the two clauses that were
previously stated twice with nothing checking them against each other,
so they get explicit cases here.

Run directly (`python test_determine_winner.py`) or via pytest.
"""

from pinochle_engine import (
    GAME_LOSE_SCORE,
    GAME_WIN_SCORE,
    Player,
    Team,
    determine_winner,
)


def make_teams(score_a, score_b):
    team_a = Team("Team A", [Player("N", None), Player("S", None)])
    team_b = Team("Team B", [Player("E", None), Player("W", None)])
    team_a.score = score_a
    team_b.score = score_b
    return team_a, team_b


def test_game_continues_below_thresholds():
    team_a, team_b = make_teams(900, -400)
    assert determine_winner([team_a, team_b], team_a) is None


def test_single_team_over_wins_even_if_it_was_not_bidding():
    team_a, team_b = make_teams(GAME_WIN_SCORE, 300)
    assert determine_winner([team_a, team_b], team_b) is team_a


def test_exactly_at_win_score_counts():
    team_a, team_b = make_teams(999, 500)
    assert determine_winner([team_a, team_b], team_a) is None
    team_a.score = GAME_WIN_SCORE
    assert determine_winner([team_a, team_b], team_a) is team_a


def test_both_over_in_same_round_bidding_team_wins_the_tie():
    team_a, team_b = make_teams(1100, 1050)
    assert determine_winner([team_a, team_b], team_b) is team_b
    # ...and the same scores decided the other way when A held the bid,
    # so the result tracks the bid and not the higher score or the order.
    assert determine_winner([team_a, team_b], team_a) is team_a


def test_bust_hands_the_game_to_the_other_team():
    team_a, team_b = make_teams(200, GAME_LOSE_SCORE)
    assert determine_winner([team_a, team_b], team_b) is team_a
    team_b.score = GAME_LOSE_SCORE - 50
    assert determine_winner([team_a, team_b], team_b) is team_a


def test_bust_is_checked_before_the_win_condition():
    # The busting team's opponent wins regardless of its own score, and
    # the bidding team's tie-break never gets a say.
    team_a, team_b = make_teams(1200, GAME_LOSE_SCORE)
    assert determine_winner([team_a, team_b], team_b) is team_a

    # And the surviving team wins on any score at all, including a bad
    # one - "regardless of that team's own score" is the rule's wording.
    team_a, team_b = make_teams(-800, GAME_LOSE_SCORE)
    assert determine_winner([team_a, team_b], team_a) is team_a


if __name__ == "__main__":
    for name, fn in sorted(list(globals().items())):
        if name.startswith("test_"):
            fn()
            print(f"{name} passed")

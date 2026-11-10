"""
A team must take a trick to save its meld (pinochle_rules.md, "Contract
Check"). A team that takes none of the 12 tricks scores 0 meld, so its round
total is 0. One trick is enough - including a trick worth 0 points - because
the test is tricks taken, not trick points.

These drive `Round._score_round` directly over hand-set team state, so each
case states exactly the tricks and points it is about rather than hunting for a
seed that happens to sweep. `test_play_tricks_counts_tricks_won` covers the
other half: that the trick loop records the count scoring reads.
"""

from pinochle_engine import Card, Player, Round, Suit, Team
from pinochle_rules_engine import PlayTracker, play_tricks


def _round(bid=300):
    players = [Player(f"P{i}", None) for i in range(4)]
    team_a = Team("A", [players[0], players[2]])
    team_b = Team("B", [players[1], players[3]])
    for p in (players[0], players[2]):
        p.team = team_a
    for p in (players[1], players[3]):
        p.team = team_b
    round_ = Round.__new__(Round)
    round_.players = players
    round_.teams = [team_a, team_b]
    round_.bid_winner = players[0]
    round_.current_bid = bid
    return round_, team_a, team_b


def _score(round_, team_a, team_b, *, meld, points, tricks):
    team_a.meld_points, team_b.meld_points = meld
    team_a.tricks_taken, team_b.tricks_taken = tricks
    return round_._score_round({team_a: points[0], team_b: points[1]})


def test_a_sweep_by_the_bidders_wipes_out_the_defenders_meld():
    # The worked example: both meld 100, bidders take all 12 tricks.
    round_, a, b = _round(bid=300)
    scores = _score(round_, a, b, meld=(100, 100), points=(250, 0), tricks=(12, 0))
    assert scores[a] == 350
    assert scores[b] == 0


def test_one_pointless_trick_saves_the_meld():
    # Defenders win a single trick of Queens/Jacks/9s: 0 points, meld stands.
    round_, a, b = _round(bid=300)
    scores = _score(round_, a, b, meld=(100, 100), points=(250, 0), tricks=(11, 1))
    assert scores[b] == 100


def test_a_bidding_team_with_no_trick_is_set_either_way():
    round_, a, b = _round(bid=250)
    scores = _score(round_, a, b, meld=(400, 60), points=(0, 250), tricks=(0, 12))
    assert scores[a] == -250
    assert scores[b] == 310


def test_an_ordinary_hand_is_unchanged():
    round_, a, b = _round(bid=300)
    scores = _score(round_, a, b, meld=(120, 80), points=(190, 60), tricks=(8, 4))
    assert scores[a] == 310
    assert scores[b] == 140


def test_a_conceded_hand_keeps_the_defenders_meld():
    # No trick is played on a concede, so the defenders' meld is not lost for
    # want of one.
    round_, a, b = _round(bid=300)
    a.meld_points, b.meld_points = 100, 100
    scores = round_._score_conceded_round()
    assert scores[a] == -300
    assert scores[b] == 100
    assert a.tricks_taken == 0 and b.tricks_taken == 0


def test_play_tricks_counts_tricks_won():
    # One trick, seat 0 leads the trump Ace and wins it.
    players = [Player(f"P{i}", None) for i in range(4)]
    team_a = Team("A", [players[0], players[2]])
    team_b = Team("B", [players[1], players[3]])
    for p in (players[0], players[2]):
        p.team = team_a
    for p in (players[1], players[3]):
        p.team = team_b
    players[0].hand = [Card(Suit.SPADES, "A", 1)]
    players[1].hand = [Card(Suit.SPADES, "9", 1)]
    players[2].hand = [Card(Suit.SPADES, "J", 1)]
    players[3].hand = [Card(Suit.SPADES, "Q", 1)]
    tricks_won = {}
    play_tricks(players, Suit.SPADES, 0, PlayTracker(), num_tricks=1, tricks_won=tricks_won)
    assert tricks_won == {team_a: 1}

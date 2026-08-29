"""
Standalone local play - run this directly:  python3 play_local.py

No chat, no pickle, no resume-across-processes hack. This is one
continuous Python process using input() to block for your answer,
which is the whole reason human_play.py's pickle/resume machinery
existed in the first place (working around a chat session's inability
to pause mid-script) - a normal terminal doesn't have that problem.
"""

import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from human_play import HumanPlayer, InteractiveRound, NeedsHumanInput, hand_grouped
from pinochle_engine import Player, Team, GAME_LOSE_SCORE, determine_winner
from pinochle_rollout import MAX_TRICK_POINTS

SUIT_NAME = {"S": "Spades", "H": "Hearts", "D": "Diamonds", "C": "Clubs"}
SUIT_ORDER = ["S", "H", "D", "C"]


def print_grouped(grouped):
    for suit in SUIT_ORDER:
        if suit in grouped and grouped[suit]:
            print(f"    {SUIT_NAME[suit]:9s}: {' '.join(f'{r}{suit}' for r in grouped[suit])}")


def prompt_and_get_answer(kind, data):
    print()
    if kind == "bid":
        print(f"Score - {list(data['scores'].items())[0][0]}: {list(data['scores'].items())[0][1]}"
              f"   {list(data['scores'].items())[1][0]}: {list(data['scores'].items())[1][1]}")
        print("Bidding so far:")
        for line in data.get("players_clockwise", []):
            print(f"  {line}")
        print("Your hand:")
        print_grouped(data["hand_grouped"])
        print(f"Current bid: {data['current_bid']}   Min legal bid: {data['min_legal_bid']}")
        while True:
            raw = input("Enter a bid amount, or 'pass': ").strip().lower()
            if raw in ("pass", "p", ""):
                return None
            try:
                return int(raw)
            except ValueError:
                print("  Not a number - try again.")

    if kind == "trump":
        print("Your hand:")
        print(data["hand"])
        while True:
            raw = input("Choose trump - S/D/C/H: ").strip().upper()
            if raw and raw[0] in "SDCH":
                return raw[0]
            print("  Enter S, D, C, or H.")

    if kind == "pass":
        print(f"Pass {data['count']} cards to your {data['role']}. Trump: {data['trump']}")
        print("Your hand:")
        print(data["hand"])
        while True:
            raw = input(f"Enter {data['count']} cards separated by spaces (e.g. QS JD 9C): ").strip().upper()
            tokens = raw.split()
            if len(tokens) == data["count"]:
                return tokens
            print(f"  Need exactly {data['count']} cards - try again.")

    if kind == "card":
        scores = data["scores"]
        print(f"Score - {list(scores.items())[0][0]}: {list(scores.items())[0][1]}"
              f"   {list(scores.items())[1][0]}: {list(scores.items())[1][1]}" if len(scores) > 1
              else f"Score - {list(scores.items())[0][0]}: {list(scores.items())[0][1]}")
        for line in data.get("table_clockwise", []):
            print(f"  {line}")
        print("Your hand:")
        print_grouped(data["hand_grouped"])
        if data.get("hand_played_grouped"):
            print("Your hand played:")
            print_grouped(data["hand_played_grouped"])
        print(f"Legal moves: {' '.join(data['legal_moves'])}")
        while True:
            raw = input("Play a card: ").strip().upper()
            if raw in data["legal_moves"]:
                return raw
            print("  Not a legal move - try again.")

    if kind == "misdeal":
        print(data["message"])
        while True:
            raw = input("Reshuffle? (y/n): ").strip().lower()
            if raw.startswith("y"):
                return True
            if raw.startswith("n"):
                return False


def play_game():
    import random
    from names import NAME_POOL
    ai_names = random.sample(NAME_POOL, 3)
    p0 = HumanPlayer("You")
    p1 = Player(ai_names[0], None)
    p2 = Player(ai_names[1], None)
    p3 = Player(ai_names[2], None)
    team_a = Team("Your Team", [p0, p2])
    team_b = Team("Opponents", [p1, p3])
    p0.team = p2.team = team_a
    p1.team = p3.team = team_b
    players = [p0, p1, p2, p3]

    print("=== NEW GAME === (playing to 1000, first to -1000 loses)\n")
    dealer_index = 0

    while True:
        round_ = InteractiveRound(players, [team_a, team_b], dealer_index)
        while True:
            try:
                result = round_.run()
                break
            except NeedsHumanInput as e:
                answer = prompt_and_get_answer(e.kind, e.prompt_data)
                p0.pending_answer = answer

        print("\n=== ROUND COMPLETE ===")
        print(f"Bid winner: {round_.bid_winner.name} at {round_.current_bid}, trump {round_.trump_suit.name}")
        if round_.auto_set:
            # Say why no tricks were played (issue #178). A round that ends
            # straight after meld reads as a crash unless the arithmetic is
            # spelled out, and this is the CLI's only chance to spell it out.
            bidding_team = round_.bid_winner.team
            ceiling = bidding_team.meld_points + MAX_TRICK_POINTS
            print(
                f"AUTO-SET: {bidding_team.name} melded {bidding_team.meld_points}, and every "
                f"trick point in a round is {MAX_TRICK_POINTS}, so the most they could reach was "
                f"{ceiling} - short of {round_.current_bid}. The contract could not be made, so "
                f"no tricks were played."
            )
        for team, score in result.items():
            team.score += score
            print(f"{team.name}: {'+' if score >= 0 else ''}{score} -> total {team.score}")

        winner = determine_winner([team_a, team_b], round_.bid_winner.team)
        if winner is not None:
            # The rule itself lives in determine_winner; all that's left
            # here is picking which of the two endings to announce.
            if any(t.score <= GAME_LOSE_SCORE for t in (team_a, team_b)):
                print(f"\n{winner.name} WINS! (opponent dropped to {GAME_LOSE_SCORE} or below)")
            else:
                print(f"\n{winner.name} WINS!")
            break

        dealer_index = (dealer_index + 1) % 4
        input("\nPress enter for the next round...")


if __name__ == "__main__":
    play_game()

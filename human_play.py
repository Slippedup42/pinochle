"""
Interactive play layer for the pinochle engine.

Core problem this solves: a chat session can't "pause mid-script and wait
for a keystroke" the way a terminal program can - every message is a fresh
script execution. So the pattern here is:

  1. Run the round until a HumanPlayer needs to decide something.
  2. That decision point raises NeedsHumanInput with everything needed to
     display a prompt (hand, legal options, context).
  3. The driver script catches it, pickles the whole game state to disk,
     and prints the prompt.
  4. Next invocation loads the pickled state, feeds in the human's answer
     via player.pending_answer, and resumes - the resumable loops below
     store their position in instance attributes (not local variables) so
     they pick up exactly where they left off.
"""

import pickle
import os
import sys
import random

sys.path.insert(0, os.path.dirname(__file__))
from names import NAME_POOL
from pinochle_engine import (
    Player, Team, Round, Trick, Suit, RANKS, RANK_VALUE,
    OPENING_BID, FORCED_BID, MIN_BID_INCREMENT, PASS_COUNT,
)

STATE_PATH = os.path.join(os.path.dirname(__file__), "game_state.pkl")


_NO_ANSWER = "__NO_ANSWER__"  # string, not object() - survives pickling with correct equality


class NeedsHumanInput(Exception):
    """Raised by HumanPlayer when a decision point is reached with no
    pending_answer available yet. Carries everything needed to prompt."""
    def __init__(self, kind, prompt_data):
        self.kind = kind
        self.prompt_data = prompt_data
        super().__init__(f"Needs human input: {kind}")


def off_grid_bid_message(bid):
    """The single wording both human seats use to turn away a bid off the
    multiple-of-10 grid (issue #297). Shared rather than copied because both
    seats reject on the same rule and read from the same constant; each caller
    supplies its own indent."""
    return f"{bid} is off the {MIN_BID_INCREMENT}-point bid grid - try again."


def card_str(card):
    return f"{card.rank}{card.suit.value}"


def hand_str(hand):
    order = {r: i for i, r in enumerate(["9", "J", "Q", "K", "10", "A"])}
    s = sorted(hand, key=lambda c: (c.suit.value, order[c.rank]))
    return " ".join(card_str(c) for c in s)


def find_card(hand, token):
    """Match a typed token like 'QS' or '10H' back to an actual Card object."""
    for c in hand:
        if card_str(c) == token:
            return c
    return None


def hand_grouped(hand):
    """Returns dict suit -> list of rank strings, high to low, for the
    'Your hand' / 'Your hand played' column display."""
    order = {r: i for i, r in enumerate(["9", "J", "Q", "K", "10", "A"])}
    grouped = {s: [] for s in Suit}
    for c in hand:
        grouped[c.suit].append(c.rank)
    for s in grouped:
        grouped[s].sort(key=lambda r: -order[r])
    return {s.value: ranks for s, ranks in grouped.items() if ranks}


class HumanPlayer(Player):
    def __init__(self, name, team=None):
        super().__init__(name, team)
        self.pending_answer = _NO_ANSWER
        self.played_cards = []

    def choose_bid(self, current_bid, min_increment, context=None):
        rejected = None
        if self.pending_answer != _NO_ANSWER:
            ans = self.pending_answer
            self.pending_answer = _NO_ANSWER
            if ans is None or ans % MIN_BID_INCREMENT == 0:
                return ans
            # Off the multiple-of-10 grid that pinochle_rules.md states without
            # qualification (issue #297). Both bidding loops would take it -
            # they only compare a bid against the minimum - and every raise
            # after it is +MIN_BID_INCREMENT from whatever was accepted, so a
            # single 305 puts the rest of the ladder on 315, 325, 335. The
            # answer is dropped and this decision point re-raised, which is the
            # ordinary resume path rather than a special case: no auction state
            # moved before the check, so the next call prompts from the
            # identical position. The check lives on the human seat and not in
            # either loop deliberately - the AI raises by MIN_BID_INCREMENT
            # from a grid-aligned opener and is already correct, so it should
            # not be exposed to a new rejection - and putting it on the player
            # means it holds for `Round` and `InteractiveRound` alike.
            rejected = ans
        prompt = {
            "hand": hand_str(self.hand),
            "hand_grouped": hand_grouped(self.hand),
            "current_bid": current_bid,
            "min_increment": min_increment,
            "min_legal_bid": OPENING_BID if (context is None or not context["ever_bid"]) else current_bid + min_increment,
        }
        if context is not None:
            prompt["scores"] = {t.name: t.score for t in context["teams"]}
            last_action = {}
            for p, amt in context["bid_history"]:
                last_action[p.name] = f"bid {amt}"
            players = context.get("players")
            if players:
                start = players.index(self)
                clockwise = players[start:] + players[:start]
                prompt["players_clockwise"] = [
                    f"{p.name}{' (you)' if p is self else ''}: {last_action.get(p.name, '(no action yet)')}"
                    for p in clockwise
                ]
        if rejected is not None:
            prompt["error"] = off_grid_bid_message(rejected)
        raise NeedsHumanInput("bid", prompt)

    def choose_trump(self):
        if self.pending_answer != _NO_ANSWER:
            ans = self.pending_answer
            self.pending_answer = _NO_ANSWER
            return {"S": Suit.SPADES, "D": Suit.DIAMONDS, "C": Suit.CLUBS, "H": Suit.HEARTS}[ans]
        raise NeedsHumanInput("trump", {"hand": hand_str(self.hand)})

    def choose_pass_cards(self, count, trump_suit=None, is_bid_winner=None):
        if self.pending_answer != _NO_ANSWER:
            tokens = self.pending_answer
            self.pending_answer = _NO_ANSWER
            cards = []
            pool = list(self.hand)
            for tok in tokens:
                c = find_card(pool, tok)
                if c is None:
                    raise ValueError(f"'{tok}' not found in hand")
                cards.append(c)
                pool.remove(c)
            return cards
        raise NeedsHumanInput("pass", {
            "hand": hand_str(self.hand),
            "count": count,
            "trump": trump_suit.name if trump_suit else None,
            "role": "bidder" if is_bid_winner else "partner",
        })

    def choose_card(self, legal_moves, trick=None, trump=None, tracker=None, my_team_players=None,
                    is_bidder_first_lead=False):
        if self.pending_answer != _NO_ANSWER:
            tok = self.pending_answer
            self.pending_answer = _NO_ANSWER
            c = find_card(legal_moves, tok)
            if c is None:
                raise ValueError(f"'{tok}' is not a legal move")
            return c
        prompt = {
            "hand": hand_str(self.hand),
            "hand_grouped": hand_grouped(self.hand),
            "hand_played_grouped": hand_grouped(self.played_cards),
            "legal_moves": [card_str(c) for c in legal_moves],
        }
        if trick is not None:
            plays_by_name = {p.name: card_str(c) for p, c in trick.plays}
            if hasattr(self, "_all_players_ref") and self._all_players_ref:
                players = self._all_players_ref
                start = players.index(self)
                clockwise = players[start:] + players[:start]
                prompt["table_clockwise"] = [
                    f"{p.name}{' (you)' if p is self else ''}: {plays_by_name.get(p.name, '(not played yet this trick)')}"
                    for p in clockwise
                ]
            else:
                prompt["trick_so_far"] = [(p.name, card_str(c)) for p, c in trick.plays]
        if hasattr(self, "_teams_ref"):
            prompt["scores"] = {t.name: t.score for t in self._teams_ref}
        elif self.team is not None:
            prompt["scores"] = {"your team": self.team.score}
        raise NeedsHumanInput("card", prompt)


class InteractiveRound(Round):
    """Same rules as Round, but every phase is resumable: state lives in
    instance attributes instead of local variables, so a NeedsHumanInput
    exception can propagate all the way out (through run()) without
    losing progress, then pick back up on the next call to run().

    That makes this a hand-maintained mirror of Round: only the phases
    holding a human decision point are overridden here, so a rules change
    in one of them has to be repeated on this side or the interactive
    path silently plays a different game from the AI-only path, with
    nothing at runtime comparing the two. `_check_misdeal` is where the
    two have already diverged - deliberately, and frozen that way (issue
    #128) - so read it as the example of the drift, not as the exception
    to it."""

    def _check_misdeal(self):
        """House rule: 5+ nines in a single hand qualifies for a reshuffle.
        AI players always take the reshuffle if they qualify (a hand that
        heavy in the lowest-value rank is close to strictly bad). Human
        players are asked."""
        def nine_count(hand):
            return sum(1 for c in hand if c.rank == "9")

        for player in self.players:
            if nine_count(player.hand) >= 5:
                if isinstance(player, HumanPlayer):
                    if player.pending_answer != _NO_ANSWER:
                        wants_reshuffle = player.pending_answer
                        player.pending_answer = _NO_ANSWER
                    else:
                        raise NeedsHumanInput("misdeal", {
                            "hand": hand_str(player.hand),
                            "nine_count": nine_count(player.hand),
                            "message": "You have 5+ nines - house rule lets you request a reshuffle. Reshuffle? (true/false)",
                        })
                    if not wants_reshuffle:
                        continue  # this player declined, check the rest
                # reshuffle: redeal and re-check from scratch
                self._deal()
                return self._check_misdeal()

    def run(self):
        if not hasattr(self, "_phase"):
            self._phase = "deal"

        if self._phase == "deal":
            if not hasattr(self, "_dealt"):
                self._deal()
                self._dealt = True
            self._check_misdeal()
            self._phase = "bidding"

        if self._phase == "bidding":
            self._bidding_loop()
            if self.bid_winner is None:
                self.bid_winner = self.players[self.dealer_index]
                self.current_bid = FORCED_BID
            self._phase = "trump"

        if self._phase == "trump":
            self.trump_suit = self.bid_winner.choose_trump()
            self._stamp_team_round_context()
            self._phase = "passing"

        if self._phase == "passing":
            self._passing_phase()
            self._phase = "meld"

        if self._phase == "meld":
            self._meld_phase()
            self._phase = "auto-set"

        if self._phase == "auto-set":
            # Auto-SET (issue #178). `InteractiveRound` had skipped `Round`'s
            # concede window entirely, which was harmless while conceding was a
            # choice the CLI never offered - but auto-SET is not a choice, and
            # leaving it out would put the CLI on different rules from `Round`,
            # the exact drift CODING_STANDARDS warns this duplication invites.
            #
            # `Round._concede_phase` is called whole rather than re-testing the
            # inequality here, so there is still one implementation. Its second
            # half (`decide_fold`) is a no-op for every player the CLI seats -
            # `HumanPlayer` does not override it and `Player` never folds - so
            # this adds the arithmetic rule without quietly adding AI folding.
            # It is not a decision point, so nothing here can raise
            # `NeedsHumanInput` and the phase needs no resume bookkeeping.
            if self._concede_phase():
                self._discard_hands()
                return self._score_conceded_round()
            self._phase = "tricks"

        if self._phase == "tricks":
            trick_points = self._trick_taking_loop()
            self._trick_points_final = trick_points
            self._phase = "scoring"

        if self._phase == "scoring":
            return self._score_round(self._trick_points_final)

    def _bidding_loop(self):
        if not hasattr(self, "_bid_active"):
            self._bid_active = [True, True, True, True]
            self._bid_idx = self._left_of_dealer()
            self._bid_current = 0
            self._bid_ever = False
            self._bid_passes = 0
            self._bid_passes_so_far = 0
            self._bid_history = []
            self._bid_dealer = self.players[self.dealer_index]

        while self._bid_passes < 3:
            if self._bid_active[self._bid_idx]:
                player = self.players[self._bid_idx]
                min_bid = OPENING_BID if not self._bid_ever else self._bid_current + MIN_BID_INCREMENT
                context = {
                    "ever_bid": self._bid_ever,
                    "passes_so_far": self._bid_passes_so_far,
                    "bid_history": self._bid_history,
                    "dealer": self._bid_dealer,
                    "teams": self.teams,
                    "players": self.players,
                }
                bid = player.choose_bid(
                    self._bid_current if self._bid_ever else OPENING_BID - MIN_BID_INCREMENT,
                    MIN_BID_INCREMENT,
                    context,
                )
                if bid is not None and bid >= min_bid:
                    self._bid_current = bid
                    self._bid_ever = True
                    self.bid_winner = player
                    self._bid_history.append((player, bid))
                else:
                    self._bid_active[self._bid_idx] = False
                    self._bid_passes += 1
                    self._bid_passes_so_far += 1
                    if sum(self._bid_active) == 1 and self._bid_ever:
                        break
            self._bid_idx = (self._bid_idx + 1) % 4

        if self._bid_ever:
            self.current_bid = self._bid_current
        else:
            self.bid_winner = None

    def _passing_phase(self):
        if not hasattr(self, "_pass_stage"):
            self._pass_stage = 0
            self._pass_partner = next(p for p in self.bid_winner.team.players if p is not self.bid_winner)
            self._pass_to_bidder = None
            self._pass_to_partner = None

        partner = self._pass_partner

        if self._pass_stage == 0:
            if self._pass_to_bidder is None:
                self._pass_to_bidder = partner.choose_pass_cards(
                    PASS_COUNT, self.trump_suit, is_bid_winner=False)
            if self._pass_to_partner is None:
                self._pass_to_partner = self.bid_winner.choose_pass_cards(
                    PASS_COUNT, self.trump_suit, is_bid_winner=True)

            # Both choices obtained; exchange atomically (#80).
            for c in self._pass_to_bidder:
                partner.hand.remove(c)
            self.bid_winner.hand.extend(self._pass_to_bidder)
            for c in self._pass_to_partner:
                self.bid_winner.hand.remove(c)
            partner.hand.extend(self._pass_to_partner)
            self._pass_stage = 2

    def _trick_taking_loop(self):
        if not hasattr(self, "_tt_trick_num"):
            self._tt_trick_num = 0
            self._tt_leader_index = self.players.index(self.bid_winner)
            self._tt_points = {team: 0 for team in self.teams}
            self._tt_trick = None
            self._tt_seat_offset = 0

        while self._tt_trick_num < 12:
            if self._tt_trick is None:
                self._tt_trick = Trick(self.trump_suit)
                self._tt_seat_offset = 0

            while self._tt_seat_offset < 4:
                idx = (self._tt_leader_index + self._tt_seat_offset) % 4
                player = self.players[idx]
                legal = self._tt_trick.legal_moves(player.hand)
                card = player.choose_card(
                    legal, trick=self._tt_trick, trump=self.trump_suit,
                    tracker=self.tracker, my_team_players=set(player.team.players),
                )
                player.hand.remove(card)
                if hasattr(player, "played_cards"):
                    player.played_cards.append(card)
                self._tt_trick.play(player, card)
                self.tracker.record(card)
                self._tt_seat_offset += 1

            winner = self._tt_trick.winner()
            points = self._tt_trick.points()
            if self._tt_trick_num == 11:
                points += 10
            self._tt_points[winner.team] += points
            self._tt_leader_index = self.players.index(winner)
            self._tt_trick = None
            self._tt_trick_num += 1

        for team in self.teams:
            team.trick_points = self._tt_points[team]
        return self._tt_points


def save_state(round_):
    with open(STATE_PATH, "wb") as f:
        pickle.dump(round_, f)


def load_state():
    if not os.path.exists(STATE_PATH):
        return None
    with open(STATE_PATH, "rb") as f:
        return pickle.load(f)


def new_round(human_name="You"):
    ai_names = random.sample(NAME_POOL, 3)
    p0 = HumanPlayer(human_name)
    p1 = Player(ai_names[0], None)
    p2 = Player(ai_names[1], None)
    p3 = Player(ai_names[2], None)
    team_a = Team("Your Team", [p0, p2])
    team_b = Team("Opponents", [p1, p3])
    p0.team = p2.team = team_a
    p1.team = p3.team = team_b
    players = [p0, p1, p2, p3]
    p0._all_players_ref = players
    p0._teams_ref = [team_a, team_b]
    return InteractiveRound(players, [team_a, team_b], dealer_index=0)

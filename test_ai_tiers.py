"""
Focused tests for issue #53 - EasyPlayer AI tier and Game.from_players().
Not a full pytest suite (that's separately deferred, Phase 2) - just plain
assert-based, pytest-discoverable tests covering:

  1. EasyPlayer only ever produces *legal* moves at each decision point
     (bid, trump, pass, trick-play), across varied hands.
  2. Several full Game.play() runs complete cleanly with mixed tiers
     across the 4 seats.

Note: this file used to also cover RandomPlayer (issue #53/PR #55), which
made uniformly-random legal moves at every decision point. It was removed
in issue #58 per changed product direction - no tier should ever make a
literal random move. A "Random" tier will return once GeneralStrategy
exists (see #57/#63), as a random draw over its skill levels rather than
its own strategy class, at which point it'll get its own coverage here.

Run directly (`python test_ai_tiers.py`) or via pytest.
"""

import random

from pinochle_engine import (
    Deck, Player, EasyPlayer, Team, Game, Trick,
    Suit, OPENING_BID, GAME_WIN_SCORE, GAME_LOSE_SCORE,
    PASS_COUNT,
)


def _fresh_hands():
    """Shuffle and deal a fresh 4x12 deck, return list of 4 hands (lists
    of Card)."""
    deck = Deck()
    deck.shuffle()
    cards = deck.cards
    return [cards[i * 12:(i + 1) * 12] for i in range(4)]


def _make_player(cls, name, hand):
    p = cls(name, None)
    p.receive_cards(hand)
    return p


# ---------------------------------------------------------------------------
# 1. Legal-move checks, EasyPlayer, across many hands/contexts.
# ---------------------------------------------------------------------------

def test_choose_trump_always_returns_a_suit():
    for cls in (EasyPlayer,):
        for hand in _fresh_hands() * 5:  # reuse a few shuffles' worth of hands
            p = _make_player(cls, "T", hand)
            trump = p.choose_trump()
            assert isinstance(trump, Suit), (cls, trump)


def test_choose_pass_cards_always_legal():
    """Returned cards must be exactly `count`, all distinct objects
    actually present in the player's hand at the time of the call."""
    for cls in (EasyPlayer,):
        for _ in range(20):
            hands = _fresh_hands()
            for trump in Suit:
                for is_bidder in (True, False):
                    hand = list(random.choice(hands))
                    p = _make_player(cls, "T", hand)
                    chosen = p.choose_pass_cards(PASS_COUNT, trump, is_bidder)
                    assert len(chosen) == PASS_COUNT, (cls, chosen)
                    assert len(set(id(c) for c in chosen)) == PASS_COUNT, "duplicate card object returned"
                    for c in chosen:
                        assert c in p.hand, (cls, c, p.hand)


def test_choose_pass_cards_isolated_fallback():
    """trump_suit/is_bid_winner omitted -> falls back to a legal random
    sample, same contract as Player's own fallback."""
    for cls in (EasyPlayer,):
        hand = _fresh_hands()[0]
        p = _make_player(cls, "T", hand)
        chosen = p.choose_pass_cards(PASS_COUNT)
        assert len(chosen) == PASS_COUNT
        for c in chosen:
            assert c in p.hand


def test_choose_card_leading_and_following_always_legal():
    for cls in (EasyPlayer,):
        for _ in range(30):
            hands = _fresh_hands()
            trump = random.choice(list(Suit))
            hand = list(random.choice(hands))
            p = _make_player(cls, "T", hand)

            # Leading: legal_moves is the whole hand.
            trick = Trick(trump)
            legal = trick.legal_moves(p.hand)
            card = p.choose_card(legal, trick=trick, trump=trump)
            assert card in legal, (cls, "lead", card, legal)

            # Following: build a trick with 1-3 prior plays from other
            # simulated hands, then confirm the chosen card is one of the
            # rules-filtered legal_moves for this hand.
            other_hand = list(random.choice(hands))
            n_prior = random.randint(1, 3)
            trick2 = Trick(trump)
            fake_players = []
            for i in range(n_prior):
                if not other_hand:
                    break
                c = other_hand.pop()
                fake_players.append(object())
                trick2.play(fake_players[-1], c)
            legal2 = trick2.legal_moves(p.hand)
            if legal2:
                card2 = p.choose_card(legal2, trick=trick2, trump=trump)
                assert card2 in legal2, (cls, "follow", card2, legal2)


def test_choose_card_isolated_fallback():
    """trick/trump omitted: EasyPlayer falls back to legal_moves[0], same
    contract as Player's own fallback."""
    hand = _fresh_hands()[0]

    easy = _make_player(EasyPlayer, "T", hand)
    legal = list(hand)
    assert easy.choose_card(legal) == legal[0]


def test_choose_bid_always_legal_or_none():
    """Across a spread of synthetic bidding contexts, the returned bid is
    either None (pass) or exactly current_bid + min_increment - the only
    legal raise EasyPlayer ever makes."""
    for cls in (EasyPlayer,):
        for _ in range(40):
            hand = random.choice(_fresh_hands())
            p = _make_player(cls, "T", hand)
            partner = _make_player(Player, "Partner", random.choice(_fresh_hands()))
            opp1 = _make_player(Player, "Opp1", random.choice(_fresh_hands()))
            opp2 = _make_player(Player, "Opp2", random.choice(_fresh_hands()))
            team_a = Team("A", [p, partner])
            team_b = Team("B", [opp1, opp2])
            p.team = partner.team = team_a
            opp1.team = opp2.team = team_b
            teams = [team_a, team_b]

            ever_bid = random.choice([True, False])
            min_increment = 10
            if ever_bid:
                current_bid_running = random.choice([300, 310, 320, 350])
                current_bid_arg = current_bid_running
                bid_history = [(opp1, current_bid_running)]
            else:
                current_bid_arg = OPENING_BID - min_increment
                bid_history = []

            context = {
                "ever_bid": ever_bid,
                "passes_so_far": random.choice([0, 1, 2]),
                "bid_history": bid_history,
                "dealer": random.choice([p, partner, opp1, opp2]),
                "teams": teams,
            }

            bid = p.choose_bid(current_bid_arg, min_increment, context)
            if bid is not None:
                expected_next = current_bid_arg + min_increment
                # Opening bid is the one special case EasyPlayer uses (fixed
                # OPENING_BID, not current_bid_arg + increment, since
                # current_bid_arg is OPENING_BID - increment before anyone
                # has bid - these are numerically identical anyway).
                assert bid == expected_next or bid == OPENING_BID, (cls, bid, expected_next)
                assert bid % 10 == 0


def test_choose_bid_isolated_fallback():
    """context=None -> falls back to a legal coin-flip shape, same
    contract as Player's own fallback."""
    for cls in (EasyPlayer,):
        hand = _fresh_hands()[0]
        p = _make_player(cls, "T", hand)
        for _ in range(20):
            bid = p.choose_bid(300, 10)
            assert bid is None or bid == 310


# ---------------------------------------------------------------------------
# 2. Full Game.play() runs with mixed tiers across all 4 seats.
# ---------------------------------------------------------------------------

TIER_MIXES = [
    (EasyPlayer, EasyPlayer, EasyPlayer, EasyPlayer),
    (Player, Player, Player, Player),
    (EasyPlayer, Player, EasyPlayer, Player),          # Easy team vs Proficient team
    (Player, EasyPlayer, EasyPlayer, Player),           # fully mixed, no team symmetry
]


def test_full_games_with_mixed_tiers():
    names = ["N", "E", "S", "W"]
    for classes in TIER_MIXES:
        for _ in range(3):  # a few runs each, since bidding/dealing is randomized
            players = [cls(name, None) for cls, name in zip(classes, names)]
            game = Game.from_players(players)
            winner = game.play()
            loser = next(t for t in game.teams if t is not winner)
            assert winner.score >= GAME_WIN_SCORE or loser.score <= GAME_LOSE_SCORE


def test_game_from_players_matches_init_team_wiring():
    """Game.from_players() wires seats 0&2 / 1&3 into teams exactly like
    Game(player_names) does, and doesn't disturb Game(player_names) itself."""
    by_name = Game(["N", "E", "S", "W"])
    assert by_name.players[0].team is by_name.players[2].team
    assert by_name.players[1].team is by_name.players[3].team
    assert by_name.players[0].team is not by_name.players[1].team

    players = [EasyPlayer("N", None), Player("E", None), EasyPlayer("S", None), Player("W", None)]
    by_players = Game.from_players(players)
    assert by_players.players[0].team is by_players.players[2].team
    assert by_players.players[1].team is by_players.players[3].team
    assert by_players.players[0].team is not by_players.players[1].team
    # from_players should use the caller's actual objects, not copies.
    assert by_players.players[0] is players[0]


if __name__ == "__main__":
    tests = [
        test_choose_trump_always_returns_a_suit,
        test_choose_pass_cards_always_legal,
        test_choose_pass_cards_isolated_fallback,
        test_choose_card_leading_and_following_always_legal,
        test_choose_card_isolated_fallback,
        test_choose_bid_always_legal_or_none,
        test_choose_bid_isolated_fallback,
        test_full_games_with_mixed_tiers,
        test_game_from_players_matches_init_team_wiring,
    ]
    for t in tests:
        t()
        print(f"{t.__name__} passed")
    print(f"\n{len(tests)}/{len(tests)} test_ai_tiers.py checks passed.")

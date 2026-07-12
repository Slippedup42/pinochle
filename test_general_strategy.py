"""
Tests for issue #63 - GeneralStrategy: wires the Expert-tier machinery from
#59 (pinochle_rollout.py's determinization+rollout sampler), #60 (bid-time
EV), #61 (forward/return-pass logic) and #62 (trick-play lead/follow logic)
into one `Player` subclass parameterized by a skill level 1-5, plus the
"Random" tier (deferred from #58) as a thin wrapper that draws a random
skill level at creation time. Plain assert-based, pytest-discoverable,
matching test_ai_tiers.py's (#53) pattern.

Covers:
  1. GeneralStrategy at every skill level 1-5 only ever produces *legal*
     moves at each decision point (bid, trump, pass, trick-play), across
     varied hands/contexts - including dedicated cases that actually
     exercise the rollout-compare code paths (skill 4-5's
     rollout_evaluator/deception_evaluator callbacks), not just the
     static-mode fallback.
  2. A handful of full Game.play() runs complete cleanly with
     GeneralStrategy at various skill levels mixed with Player/
     EasyPlayer/HumanPlayer across the 4 seats.
  3. RandomStrategy produces a GeneralStrategy instance at a skill level
     within 1-5 (range assertion, not exact - the level draw itself is
     supposed to be random).

Run directly (`python test_general_strategy.py`) or via pytest.
"""

import random

from pinochle_engine import (
    Card, Deck, Player, EasyPlayer, GeneralStrategy, RandomStrategy,
    Team, Game, Round, Trick, PlayTracker,
    Suit, OPENING_BID, GAME_WIN_SCORE, GAME_LOSE_SCORE, PASS_COUNT,
)
from human_play import HumanPlayer, card_str, find_card

SKILL_LEVELS = (1, 2, 3, 4, 5)


def _fresh_hands():
    deck = Deck()
    deck.shuffle()
    cards = deck.cards
    return [cards[i * 12:(i + 1) * 12] for i in range(4)]


def _make_gs(name, hand, skill_level, team=None, rng=None):
    p = GeneralStrategy(name, team, skill_level=skill_level, rng=rng)
    p.receive_cards(hand)
    return p


def _wire_two_teams(hands):
    """4 GeneralStrategy players (one per skill level, cycling) wired into
    2 teams, for tests that need a live Team/opponent relationship."""
    players = [_make_gs(n, h, lvl, rng=random.Random(lvl))
               for n, h, lvl in zip("NESW", hands, [1, 4, 2, 5])]
    team_a = Team("A", [players[0], players[2]])
    team_b = Team("B", [players[1], players[3]])
    players[0].team = players[2].team = team_a
    players[1].team = players[3].team = team_b
    return players, team_a, team_b


# ---------------------------------------------------------------------------
# 1. Legal-move checks across skill levels 1-5.
# ---------------------------------------------------------------------------

def test_choose_trump_always_returns_a_suit():
    for lvl in SKILL_LEVELS:
        for hand in _fresh_hands() * 3:
            p = _make_gs("T", hand, lvl)
            trump = p.choose_trump()
            assert isinstance(trump, Suit), (lvl, trump)


def test_choose_bid_always_legal_or_none():
    for lvl in SKILL_LEVELS:
        for _ in range(12):
            hand = random.choice(_fresh_hands())
            p = _make_gs("T", hand, lvl)
            partner = Player("Partner", None)
            partner.receive_cards(random.choice(_fresh_hands()))
            opp1 = Player("Opp1", None)
            opp1.receive_cards(random.choice(_fresh_hands()))
            opp2 = Player("Opp2", None)
            opp2.receive_cards(random.choice(_fresh_hands()))
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
                assert bid == expected_next or bid == OPENING_BID, (lvl, bid, expected_next)
                assert bid % 10 == 0


def test_choose_bid_isolated_fallback():
    for lvl in SKILL_LEVELS:
        hand = _fresh_hands()[0]
        p = _make_gs("T", hand, lvl)
        for _ in range(10):
            bid = p.choose_bid(300, 10)
            assert bid is None or bid == 310


def test_choose_pass_cards_always_legal():
    for lvl in SKILL_LEVELS:
        for _ in range(10):
            hands = _fresh_hands()
            for trump in Suit:
                for is_bidder in (True, False):
                    hand = list(random.choice(hands))
                    p = _make_gs("T", hand, lvl)
                    chosen = p.choose_pass_cards(PASS_COUNT, trump, is_bidder)
                    assert len(chosen) == PASS_COUNT, (lvl, chosen)
                    assert len(set(id(c) for c in chosen)) == PASS_COUNT, "duplicate card object returned"
                    for c in chosen:
                        assert c in p.hand, (lvl, c, p.hand)


def test_choose_pass_cards_isolated_fallback():
    for lvl in SKILL_LEVELS:
        hand = _fresh_hands()[0]
        p = _make_gs("T", hand, lvl)
        chosen = p.choose_pass_cards(PASS_COUNT)
        assert len(chosen) == PASS_COUNT
        for c in chosen:
            assert c in p.hand


def test_forward_pass_rollout_mode_actually_exercised_and_legal():
    """Skill 4-5's forward-pass rollout_evaluator (built on #59's sampler)
    is only wired up when self.team.round_bid is known - construct that
    context explicitly (rather than relying on a full Round) so the
    rollout-compare code path itself runs, not just the static fallback."""
    for lvl in (4, 5):
        hands = _fresh_hands()
        partner_hand = list(hands[0])
        p = _make_gs("Partner", partner_hand, lvl, rng=random.Random(42))
        bidder = Player("Bidder", None)
        team_a = Team("A", [bidder, p])
        team_b = Team("B", [Player("O1", None), Player("O2", None)])
        p.team = bidder.team = team_a
        team_a.round_bid = 300
        team_a.is_bidding_team = True

        for trump in list(Suit)[:2]:  # keep the sample count down across the loop
            chosen = p.choose_pass_cards(PASS_COUNT, trump, is_bid_winner=False)
            assert len(chosen) == PASS_COUNT
            for c in chosen:
                assert c in p.hand


def test_choose_card_leading_and_following_always_legal():
    for lvl in SKILL_LEVELS:
        for _ in range(10):
            hands = _fresh_hands()
            trump = random.choice(list(Suit))
            hand = list(random.choice(hands))
            p = _make_gs("T", hand, lvl)
            p.team = Team("Solo", [p, Player("Ghost", None)])

            trick = Trick(trump)
            legal = trick.legal_moves(p.hand)
            card = p.choose_card(legal, trick=trick, trump=trump)
            assert card in legal, (lvl, "lead", card, legal)

            other_hand = list(random.choice(hands))
            n_prior = random.randint(1, 3)
            trick2 = Trick(trump)
            fake_team = Team("Fakes", [])
            for i in range(n_prior):
                if not other_hand:
                    break
                c = other_hand.pop()
                fake_player = Player(f"Fake{i}", fake_team)
                trick2.play(fake_player, c)
            legal2 = trick2.legal_moves(p.hand)
            if legal2:
                card2 = p.choose_card(legal2, trick=trick2, trump=trump)
                assert card2 in legal2, (lvl, "follow", card2, legal2)


def test_choose_card_isolated_fallback():
    for lvl in SKILL_LEVELS:
        hand = _fresh_hands()[0]
        p = _make_gs("T", hand, lvl)
        legal = list(hand)
        assert p.choose_card(legal) == legal[0]


def test_defender_lead_rollout_mode_actually_exercised_and_legal():
    """Skill 4-5's defender trump-lead rollout_evaluator (#62's
    _defender_lead, evaluator built on #59's sampler + play_tricks'
    forced_lead_card) only fires when is_bidding_team is False and
    team.opponent/round_bid are known - construct that context explicitly
    (mid-round: some tricks already played) so the rollout-compare path
    itself runs, not just the static fallback."""
    for lvl in (4, 5):
        hands = _fresh_hands()
        # Trim to a mid-round hand size (e.g. 8 cards each, 4 tricks
        # played) so the evaluator's mini-rollout is cheap.
        hand = list(hands[0])[:8]
        p = _make_gs("Defender", hand, lvl, rng=random.Random(7))
        partner = Player("Partner", None)
        team_def = Team("Defense", [p, partner])
        team_off = Team("Offense", [Player("O1", None), Player("O2", None)])
        team_def.opponent = team_off
        team_off.opponent = team_def
        team_def.is_bidding_team = False
        team_off.is_bidding_team = True
        team_def.round_bid = team_off.round_bid = 300
        team_def.meld_points = 20
        team_off.meld_points = 40

        trump = list(hand)[0].suit if hand else Suit.SPADES
        tracker = PlayTracker()
        # Fabricate a plausible played-so-far state consistent with 8
        # cards remaining in every hand (4 tricks already played).
        for suit in Suit:
            for rank in ["9", "J"]:
                if any(c.suit == suit and c.rank == rank for c in hand):
                    continue
                tracker.record(Card(suit, rank, 1))

        trick = Trick(trump)
        legal = trick.legal_moves(p.hand)
        card = p.choose_card(legal, trick=trick, trump=trump, tracker=tracker,
                              my_team_players={p, partner})
        assert card in legal, (lvl, card, legal)


def test_deception_evaluator_always_returns_legal_move():
    """Skill 5's deception_evaluator (choose_expert_follow_card) never
    returns anything outside legal_moves, across randomized follow
    situations."""
    p = _make_gs("T", _fresh_hands()[0], 5)
    p.team = Team("Solo", [p, Player("Ghost", None)])
    tracker = PlayTracker()

    for _ in range(15):
        hands = _fresh_hands()
        trump = random.choice(list(Suit))
        p.hand = list(hands[0])
        other_hand = list(hands[1])
        trick = Trick(trump)
        fake_team = Team("Fakes", [])
        for i in range(random.randint(1, 3)):
            if not other_hand:
                break
            c = other_hand.pop()
            trick.play(Player(f"Fake{i}", fake_team), c)
            tracker.record(c)
        legal = trick.legal_moves(p.hand)
        if not legal:
            continue
        card = p.choose_card(legal, trick=trick, trump=trump, tracker=tracker,
                              my_team_players={p})
        assert card in legal


def test_skill_level_validation():
    for bad in (0, 6, -1, "5", None):
        try:
            GeneralStrategy("T", None, skill_level=bad)
            assert False, f"expected ValueError for skill_level={bad!r}"
        except ValueError:
            pass


# ---------------------------------------------------------------------------
# 2. Full Game.play() runs with mixed tiers, including GeneralStrategy at
#    every skill level and a scripted HumanPlayer.
# ---------------------------------------------------------------------------

class _ScriptedHumanPlayer(HumanPlayer):
    """Test-only stand-in: answers every decision immediately through the
    real HumanPlayer.pending_answer mechanism (token parsing, find_card,
    etc. - the actual HumanPlayer code paths) instead of raising
    NeedsHumanInput, so an unattended Game.play() run can include a
    HumanPlayer-shaped seat without a live terminal."""

    def choose_bid(self, current_bid, min_increment, context=None):
        if context is None or not context["ever_bid"]:
            self.pending_answer = None if random.random() < 0.4 else OPENING_BID
        else:
            self.pending_answer = None if random.random() < 0.7 else current_bid + min_increment
        return super().choose_bid(current_bid, min_increment, context)

    def choose_trump(self):
        self.pending_answer = random.choice(["S", "D", "C", "H"])
        return super().choose_trump()

    def choose_pass_cards(self, count, trump_suit=None, is_bid_winner=None):
        cards = random.sample(self.hand, count)
        self.pending_answer = [card_str(c) for c in cards]
        return super().choose_pass_cards(count, trump_suit, is_bid_winner)

    def choose_card(self, legal_moves, trick=None, trump=None, tracker=None, my_team_players=None):
        self.pending_answer = card_str(random.choice(legal_moves))
        return super().choose_card(legal_moves, trick, trump, tracker, my_team_players)


def _gs(name, lvl):
    return GeneralStrategy(name, None, skill_level=lvl, rng=random.Random(lvl))


TIER_MIXES = [
    (_gs("N", 1), _gs("E", 5), _gs("S", 1), _gs("W", 5)),
    (_gs("N", 4), Player("E", None), _gs("S", 4), EasyPlayer("W", None)),
    (Player("N", None), _gs("E", 2), EasyPlayer("S", None), _gs("W", 3)),
    (_gs("N", 5), _ScriptedHumanPlayer("E"), _gs("S", 5), Player("W", None)),
    (RandomStrategy("N", None, rng=random.Random(1)), EasyPlayer("E", None),
     RandomStrategy("S", None, rng=random.Random(2)), Player("W", None)),
]


def test_full_games_with_mixed_tiers():
    for players in TIER_MIXES:
        game = Game.from_players(list(players))
        winner = game.play()
        loser = next(t for t in game.teams if t is not winner)
        assert winner.score >= GAME_WIN_SCORE or loser.score <= GAME_LOSE_SCORE


# ---------------------------------------------------------------------------
# 3. RandomStrategy - draws a skill level within 1-5, instantiates
#    GeneralStrategy at that level.
# ---------------------------------------------------------------------------

def test_random_strategy_produces_general_strategy_in_range():
    seen_levels = set()
    for i in range(30):
        p = RandomStrategy(f"R{i}", None, rng=random.Random(i))
        assert isinstance(p, GeneralStrategy)
        assert 1 <= p.skill_level <= 5
        seen_levels.add(p.skill_level)
    # Over 30 draws, expect more than just one level to have come up -
    # asserting the draw is actually random, not asserting any exact value.
    assert len(seen_levels) > 1, seen_levels


def test_random_strategy_default_rng_stays_in_range():
    for _ in range(20):
        p = RandomStrategy("R", None)
        assert isinstance(p, GeneralStrategy)
        assert 1 <= p.skill_level <= 5


if __name__ == "__main__":
    tests = [
        test_choose_trump_always_returns_a_suit,
        test_choose_bid_always_legal_or_none,
        test_choose_bid_isolated_fallback,
        test_choose_pass_cards_always_legal,
        test_choose_pass_cards_isolated_fallback,
        test_forward_pass_rollout_mode_actually_exercised_and_legal,
        test_choose_card_leading_and_following_always_legal,
        test_choose_card_isolated_fallback,
        test_defender_lead_rollout_mode_actually_exercised_and_legal,
        test_deception_evaluator_always_returns_legal_move,
        test_skill_level_validation,
        test_full_games_with_mixed_tiers,
        test_random_strategy_produces_general_strategy_in_range,
        test_random_strategy_default_rng_stays_in_range,
    ]
    for t in tests:
        t()
        print(f"{t.__name__} passed")
    print(f"\n{len(tests)}/{len(tests)} test_general_strategy.py checks passed.")

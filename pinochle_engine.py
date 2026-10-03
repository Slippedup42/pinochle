"""
Pinochle engine - a re-export shim (#250, epic #214). Defines nothing.

The Python engine is two real modules, split along #213's authority line:

  - `pinochle_rules_engine.py` - the rules and the bid-valuation chain.
    Python-authoritative: a rules constant there is right, and a TypeScript
    port that disagrees has drifted.
  - `pinochle_ai.py` - the strategy layer (the players, bidding thresholds,
    pass selection, trick play). Not authoritative: TypeScript's
    `web/src/engine/bidding.ts` owns the measured strategy constants.

This file re-exports every name either of them defines, as the very same
object, so the ~30 callers that `from pinochle_engine import ...` - the
parity exporters among them - did not change an import. Migrating them off
the shim is a separate decision ("delete the shim later if ever", #214).
New code should import from the real module the name belongs to.

Patching: mutating a re-exported object (a class attribute, an entry in
GENERAL_STRATEGY_SKILL_PARAMS) is seen everywhere, because it is the same
object. Rebinding a name on this module is not - each real module reads its
own globals. Patch rules names on `pinochle_rules_engine` and strategy
names on `pinochle_ai`.

Pickles: classes now pickle under their defining module. State saved
before the split as `pinochle_engine.X` still loads, through these names.

`python pinochle_engine.py` still runs the meld and full-game sanity demo
below. It lives here rather than in either real module because it needs
both - the default `Player` and `EasyPlayer` from the AI side, `Game` and
`score_melds` from the rules side - and because this file is the one that
can run as `__main__` safely: it defines nothing, so running it as a script
does not create a second copy of `Suit` beside the importable one.
"""

from pinochle_rules_engine import (  # noqa: F401
    ACE_VALUE,
    AROUND_DOUBLE_MULTIPLIER,
    AROUND_VALUES,
    COMMON_MARRIAGE_VALUE,
    DIX_VALUE,
    DOUBLE_RUN_VALUE,
    EXTRA_TRUMP_VALUE,
    FORCED_BID,
    GAME_LOSE_SCORE,
    GAME_WIN_SCORE,
    LOOSE_KING_VALUE,
    LOOSE_KQ_PASSED_VALUE,
    LOOSE_KQ_PASS_ONLY,
    LOOSE_QUEEN_VALUE,
    MIN_BID_INCREMENT,
    NEAR_DOUBLE_PINOCHLE_VALUE,
    NEAR_RUN_VALUE,
    OPENING_BID,
    PARTNER_ESTIMATE_RANGE,
    PASS_COUNT,
    PINOCHLE_DOUBLE_VALUE,
    PINOCHLE_NO_KING_OF_SPADES_BONUS,
    PINOCHLE_SINGLE_VALUE,
    POINT_RANKS,
    PROTECTED_TEN_VALUE,
    RANKS,
    RANK_VALUE,
    ROYAL_MARRIAGE_VALUE,
    RUN_RANKS,
    RUN_VALUE,
    TOTAL_TRUMP_COPIES,
    TRUMP_ACE_VALUE,
    TRUMP_LENGTH_BASELINE,
    Card,
    Deck,
    Game,
    PlayTracker,
    Round,
    Suit,
    Team,
    Trick,
    _hand_count,
    _is_protected_ten,
    _n_of,
    _suit_length,
    best_base_bid,
    compute_base_bid,
    compute_competitive_adjustment,
    compute_max_bid,
    compute_trick_potential,
    determine_winner,
    play_tricks,
    run_forward_pass,
    run_return_pass,
    run_simultaneous_pass,
    score_melds,
)

from pinochle_ai import (  # noqa: F401
    ANCHOR_CAP,
    ANCHOR_INTERCEPT,
    ANCHOR_SLOPE,
    COMPETITIVE_CEILING_FLOOR,
    DEFENSIVE_PUSH_FLOOR,
    EASY_BID_NOISE,
    EASY_FLAT_TRICK_ESTIMATE,
    ENDGAME_OPP_SCORE_CAP,
    ENDGAME_RESCUE_CEILING,
    ENDGAME_SCORE_FLOOR,
    GENERAL_STRATEGY_SKILL_PARAMS,
    MELD_ONLY_TRICK_ESTIMATE,
    OPENER_THRESHOLD,
    PARTNER_RAISE_FLOOR,
    THIRD_BIDDER_FLOOR,
    _PARTNER_FILLER_LAST,
    _PARTNER_FILLER_ORDER,
    _PROTECTED_RUN_SHED_ORDER,
    _TRUMP_RUN_ORDER,
    EasyPlayer,
    GeneralStrategy,
    Player,
    RandomStrategy,
    _bidder_pass_selection,
    _breaks_around,
    _breaks_marriage,
    _current_winner,
    _defender_lead,
    _easy_card_worth,
    _expert_follow_card_honest,
    _feed_ahead,
    _feed_partner,
    _find_void_opportunity,
    _first_n_of,
    _in_protected_ten_run,
    _knapsack_lock_return_pass_melds,
    _lead_safe_cascade,
    _offense_trump_lead,
    _pad_pass_selection,
    _partner_pass_selection,
    _protects_a_ten,
    _return_pass_meld_groups,
    _return_pass_pool_priority,
    _score_deception_candidate,
    _sluff_card,
    _take,
    _take_spread,
    _tier0_forward_pass_candidates,
    _tier1_forward_pass_candidates,
    _trick_has_points,
    _trump_fully_accounted,
    choose_expert_follow_card,
    choose_expert_lead_card,
    choose_follow_card,
    choose_forward_pass_cards,
    choose_lead_card,
    choose_return_pass_cards,
    endgame_protection_applies,
    endgame_protection_bid,
    generate_fake_void_candidates,
    generate_false_card_candidates,
    is_safe,
    is_unsecured_ace,
    opening_level_for,
)


__all__ = [
    'Suit',
    'RANKS',
    'RANK_VALUE',
    'GAME_WIN_SCORE',
    'GAME_LOSE_SCORE',
    'OPENING_BID',
    'FORCED_BID',
    'MIN_BID_INCREMENT',
    'Card',
    'Deck',
    'RUN_VALUE',
    'DOUBLE_RUN_VALUE',
    'ROYAL_MARRIAGE_VALUE',
    'COMMON_MARRIAGE_VALUE',
    'DIX_VALUE',
    'PINOCHLE_SINGLE_VALUE',
    'PINOCHLE_DOUBLE_VALUE',
    'AROUND_VALUES',
    'AROUND_DOUBLE_MULTIPLIER',
    'score_melds',
    '_is_protected_ten',
    'RUN_RANKS',
    'NEAR_RUN_VALUE',
    'NEAR_DOUBLE_PINOCHLE_VALUE',
    'PINOCHLE_NO_KING_OF_SPADES_BONUS',
    'ACE_VALUE',
    'TRUMP_ACE_VALUE',
    'TRUMP_LENGTH_BASELINE',
    'EXTRA_TRUMP_VALUE',
    'PROTECTED_TEN_VALUE',
    'LOOSE_KING_VALUE',
    'LOOSE_QUEEN_VALUE',
    'LOOSE_KQ_PASS_ONLY',
    'LOOSE_KQ_PASSED_VALUE',
    'PARTNER_ESTIMATE_RANGE',
    'compute_base_bid',
    'compute_trick_potential',
    'compute_competitive_adjustment',
    'compute_max_bid',
    'best_base_bid',
    'POINT_RANKS',
    'TOTAL_TRUMP_COPIES',
    'PlayTracker',
    '_hand_count',
    '_suit_length',
    '_n_of',
    'run_forward_pass',
    'run_return_pass',
    'run_simultaneous_pass',
    'play_tricks',
    'Trick',
    'Team',
    'PASS_COUNT',
    'Round',
    'determine_winner',
    'Game',
    'OPENER_THRESHOLD',
    'ANCHOR_INTERCEPT',
    'ANCHOR_SLOPE',
    'ANCHOR_CAP',
    'opening_level_for',
    'DEFENSIVE_PUSH_FLOOR',
    'ENDGAME_SCORE_FLOOR',
    'ENDGAME_OPP_SCORE_CAP',
    'ENDGAME_RESCUE_CEILING',
    'THIRD_BIDDER_FLOOR',
    'PARTNER_RAISE_FLOOR',
    'COMPETITIVE_CEILING_FLOOR',
    'endgame_protection_applies',
    'endgame_protection_bid',
    'is_safe',
    'is_unsecured_ace',
    '_lead_safe_cascade',
    'choose_lead_card',
    '_current_winner',
    '_feed_partner',
    '_feed_ahead',
    '_sluff_card',
    'choose_follow_card',
    '_breaks_marriage',
    '_breaks_around',
    '_protects_a_ten',
    '_in_protected_ten_run',
    '_PROTECTED_RUN_SHED_ORDER',
    '_take',
    '_TRUMP_RUN_ORDER',
    '_take_spread',
    '_PARTNER_FILLER_ORDER',
    '_PARTNER_FILLER_LAST',
    '_partner_pass_selection',
    '_find_void_opportunity',
    '_bidder_pass_selection',
    '_pad_pass_selection',
    '_tier0_forward_pass_candidates',
    '_tier1_forward_pass_candidates',
    'choose_forward_pass_cards',
    '_first_n_of',
    '_return_pass_meld_groups',
    '_knapsack_lock_return_pass_melds',
    '_return_pass_pool_priority',
    'choose_return_pass_cards',
    '_trick_has_points',
    '_trump_fully_accounted',
    '_offense_trump_lead',
    '_defender_lead',
    'choose_expert_lead_card',
    'generate_false_card_candidates',
    'generate_fake_void_candidates',
    '_expert_follow_card_honest',
    'choose_expert_follow_card',
    'Player',
    'EASY_FLAT_TRICK_ESTIMATE',
    'EASY_BID_NOISE',
    '_easy_card_worth',
    'EasyPlayer',
    'GENERAL_STRATEGY_SKILL_PARAMS',
    'MELD_ONLY_TRICK_ESTIMATE',
    '_score_deception_candidate',
    'GeneralStrategy',
    'RandomStrategy',
]


if __name__ == "__main__":
    # Sanity checks: meld scoring (including Double Run) and a few full games.
    from itertools import product

    # Double Run check
    trump = Suit.SPADES
    hand = [Card(trump, r, c) for r in ("A", "10", "K", "Q", "J") for c in (1, 2)]
    total, breakdown = score_melds(hand, trump)
    assert breakdown.get("Double Run") == 1500, breakdown
    assert "Run" not in breakdown
    print("Double Run check passed:", breakdown)

    # Single run should NOT get the double value
    hand2 = [Card(trump, r, 1) for r in ("A", "10", "K", "Q", "J")]
    total2, breakdown2 = score_melds(hand2, trump)
    assert breakdown2.get("Run") == 150, breakdown2
    assert "Double Run" not in breakdown2
    print("Single Run check passed:", breakdown2)

    # Full games
    for i in range(10):
        game = Game(["N", "E", "S", "W"])
        winner = game.play()
        loser = next(t for t in game.teams if t is not winner)
        assert winner.score >= GAME_WIN_SCORE or loser.score <= GAME_LOSE_SCORE
    print("10/10 full games completed cleanly with Double Run scoring active.")

    # AI tier sanity checks (issue #53) - EasyPlayer only ever produces
    # legal moves, and Game.from_players() supports mixed tiers across the
    # 4 seats. See test_ai_tiers.py for the full test suite.
    tier_mixes = [
        [EasyPlayer, EasyPlayer, EasyPlayer, EasyPlayer],
        [EasyPlayer, Player, EasyPlayer, Player],
        [Player, EasyPlayer, Player, EasyPlayer],
    ]
    for i, classes in enumerate(tier_mixes):
        names = ["N", "E", "S", "W"]
        players = [cls(name, None) for cls, name in zip(classes, names)]
        game = Game.from_players(players)
        winner = game.play()
        loser = next(t for t in game.teams if t is not winner)
        assert winner.score >= GAME_WIN_SCORE or loser.score <= GAME_LOSE_SCORE
    print(f"{len(tier_mixes)}/{len(tier_mixes)} mixed-tier games (Easy/Proficient) completed cleanly via Game.from_players().")

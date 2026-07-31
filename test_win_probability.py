"""
Tests for issue #102 (epic #106) - making the rollout objective the
probability of winning the game instead of points or score differential.
Plain assert-based, pytest-discoverable, matching test_defence_ev.py /
test_fold_ev.py's convention. Covers:

  1. The measured table's structural guarantees. Its *values* come from
     self-play and would change on regeneration, so the assertions here are
     about the properties the construction is supposed to guarantee
     (antisymmetry, a 0.5 diagonal, direction) rather than about any
     particular number - a test pinned to a generated float would fail on
     every regeneration for no reason.
  2. End-of-game resolution, which is arithmetic and must be exact rather
     than estimated. The endgame is the whole reason this objective exists,
     so this is the part that cannot be a little bit wrong: bust is checked
     before the 1000 target, and a round that carries both sides over goes to
     the bidding team.
  3. The prior's shape - the same lead being worth more with fewer rounds
     left is what makes it a usable fallback for cells self-play never
     reaches, rather than a constant with a plausible story attached.
  4. The per-sample objective helpers, against synthetic samples where the
     right answer is arithmetic rather than a simulation result.
  5. The acceptance criterion from the issue: the same hand at the same bid
     decides differently at 200-180 and at 890-950, with no score branch
     anywhere in the code - and the differential objective it replaces does
     not, because the score is not an input to it at all.
  6. The fold decision under the new objective, including that the auto-set
     dominance shortcut survives the change.
  7. Nothing is enabled by default, and the flag reaches the decision.

Real pass and trick-play logic are deterministic given the dealt hands, so a
seeded `random.Random` makes the rollout-backed cases reproducible at modest
sample counts.
"""

import random

from pinochle_engine import Card, Suit
from pinochle_rollout import (
    _win_prob_when_they_bid,
    _win_prob_when_we_bid,
    bid_ev_win_probability,
    choose_bid_by_win_probability,
    choose_bid_vs_defence,
    defend_ev_win_probability,
    fold_ev_win_probability,
    should_fold,
)
from win_probability import (
    BUCKET_COUNT,
    GAME_LOSE_SCORE,
    GAME_WIN_SCORE,
    WIN_PROBABILITY_TABLE,
    bucket_midpoint,
    generate_table,
    prior_win_probability,
    resolve_game_winner,
    score_bucket,
    table_win_probability,
    win_probability,
)


def _marginal_hand():
    """
    The same borderline hand test_defence_ev.py uses: one weak trump suit, a
    scattering of side-suit strength, no meld to speak of. Deliberately not a
    powerhouse - a hand that is obviously worth bidding would take the
    contract at every score, and could not show that the *score* moved the
    decision.
    """
    return [
        Card(Suit.CLUBS, "A", 1), Card(Suit.CLUBS, "K", 1), Card(Suit.CLUBS, "Q", 1),
        Card(Suit.CLUBS, "9", 1), Card(Suit.SPADES, "A", 1), Card(Suit.SPADES, "K", 1),
        Card(Suit.DIAMONDS, "K", 1), Card(Suit.DIAMONDS, "J", 1), Card(Suit.HEARTS, "10", 1),
        Card(Suit.HEARTS, "J", 1), Card(Suit.HEARTS, "9", 1), Card(Suit.SPADES, "9", 1),
    ]


def _powerhouse_hand():
    trump = Suit.CLUBS
    return [
        Card(trump, "A", 1), Card(trump, "A", 2), Card(trump, "10", 1), Card(trump, "10", 2),
        Card(trump, "K", 1), Card(trump, "Q", 1), Card(trump, "J", 1),
        Card(Suit.SPADES, "A", 1), Card(Suit.SPADES, "A", 2),
        Card(Suit.DIAMONDS, "A", 1), Card(Suit.DIAMONDS, "A", 2), Card(Suit.HEARTS, "A", 1),
    ], trump


# ---------------------------------------------------------------------------
# 1. The table's structural guarantees.
# ---------------------------------------------------------------------------

def test_table_covers_the_whole_score_range():
    assert len(WIN_PROBABILITY_TABLE) == BUCKET_COUNT
    assert all(len(row) == BUCKET_COUNT for row in WIN_PROBABILITY_TABLE)
    assert all(0.0 <= v <= 1.0 for row in WIN_PROBABILITY_TABLE for v in row)


def test_buckets_span_the_playable_range_without_gaps():
    """Every legal in-progress score has to land in a cell - a lookup that can
    raise IndexError on a real game state would be a crash mid-decision."""
    for score in range(GAME_LOSE_SCORE, GAME_WIN_SCORE, 25):
        assert 0 <= score_bucket(score) < BUCKET_COUNT
    # Out-of-range scores clamp rather than raise; `win_probability` resolves
    # them exactly before ever reaching the table anyway.
    assert score_bucket(-5000) == 0
    assert score_bucket(5000) == BUCKET_COUNT - 1


def test_the_table_is_antisymmetric():
    """
    P(a beats b) + P(b beats a) must be 1: the same game, read from the two
    sides. This is guaranteed by entering every self-play observation twice
    (once mirrored) rather than hoped for, and it matters because a
    bid-vs-defend comparison reads cells on opposite sides of the diagonal -
    cells that disagreed would make the comparison partly an artifact of which
    side of the table got more games.
    """
    for i in range(BUCKET_COUNT):
        for j in range(BUCKET_COUNT):
            pair = WIN_PROBABILITY_TABLE[i][j] + WIN_PROBABILITY_TABLE[j][i]
            assert abs(pair - 1.0) < 0.005, (i, j, pair)  # 0.005 covers 3-dp rounding


def test_a_tied_score_is_a_coin_flip():
    for i in range(BUCKET_COUNT):
        assert WIN_PROBABILITY_TABLE[i][i] == 0.5


def test_a_large_lead_beats_a_large_deficit():
    """
    Direction, checked across wide gaps rather than between adjacent cells.
    Adjacent cells differ by less than the sampling noise in the cells that
    were only visited a few hundred times, so asserting strict cell-by-cell
    monotonicity would be asserting that the noise happens to be small - a
    test that fails on regeneration without anything being wrong.
    """
    assert table_win_probability(700, 100) > 0.75
    assert table_win_probability(100, 700) < 0.25
    assert table_win_probability(500, 100) > table_win_probability(300, 100)
    assert table_win_probability(300, 100) > table_win_probability(300, 500)


# ---------------------------------------------------------------------------
# 2. End-of-game resolution - exact, not estimated.
# ---------------------------------------------------------------------------

def test_an_undecided_game_is_left_to_the_table():
    assert resolve_game_winner(400, 300, we_bid=True) is None
    assert win_probability(400, 300) == table_win_probability(400, 300)


def test_reaching_the_target_wins_outright():
    assert win_probability(1000, 400) == 1.0
    assert win_probability(400, 1010) == 0.0


def test_busting_is_checked_before_the_target():
    """
    `Game.play` tests the -1000 bust before the +1000 target, so a team that
    busts loses even against a side nowhere near winning. Getting this
    backwards would make the objective *reward* a catastrophic set in a game
    the opponents were also losing.
    """
    assert win_probability(-500, GAME_LOSE_SCORE) == 1.0
    assert win_probability(GAME_LOSE_SCORE - 50, 200) == 0.0


def test_a_round_that_carries_both_sides_over_goes_to_the_bidder():
    """
    The rule that makes bidding correct at 890-950 rather than merely
    defensible: if the round puts both teams past 1000, the bidding team wins
    it. An objective that split this 50/50, or handed it to the higher score,
    would miss the single most important endgame decision in the game.
    """
    assert win_probability(1100, 1200, we_bid=True) == 1.0
    assert win_probability(1200, 1100, we_bid=False) == 0.0


def test_defenders_still_score_which_is_why_950_is_nearly_decisive():
    """
    Records a rules consequence the issue's motivating example gets backwards.
    Defenders keep meld + trick points whether or not the contract is made, so
    a side sitting at 950 crosses 1000 in *any* round it defends. Trailing far
    behind them, taking the contract cannot help - we would go over only if we
    were within one round of 1000 ourselves.
    """
    # We take the contract at 300 and make it handsomely; they defend and pick
    # up a modest 60 of meld. They still cross first from 950.
    made_well = {"made": True, "bidding_total": 400, "defending_total": 60}
    assert _win_prob_when_we_bid(made_well, 300, our_score=300, their_score=950) == 0.0
    # From 890 the same round carries us over too - and the tie goes to us.
    assert _win_prob_when_we_bid(made_well, 300, our_score=890, their_score=950) == 1.0


# ---------------------------------------------------------------------------
# 3. The prior's shape.
# ---------------------------------------------------------------------------

def test_the_same_lead_is_worth_more_later_in_the_game():
    """
    The one property the prior exists to supply, and the reason a flat
    logistic on score difference would not do: a 60-point lead is nearly
    meaningless with six rounds left and close to decisive with one, because
    what changes is how much variance is still to come.
    """
    early = prior_win_probability(200, 140)
    late = prior_win_probability(950, 890)
    assert late > early
    assert early < 0.6  # early on, 60 points is barely a nudge


def test_the_prior_is_symmetric():
    for ours, theirs in [(0, 0), (300, 100), (900, 400), (-200, 500)]:
        assert abs(prior_win_probability(ours, theirs)
                   + prior_win_probability(theirs, ours) - 1.0) < 1e-9


def test_a_dead_even_score_is_a_coin_flip_under_the_prior():
    for score in (-500, 0, 400, 900):
        assert abs(prior_win_probability(score, score) - 0.5) < 1e-9


# ---------------------------------------------------------------------------
# 4. Per-sample objective helpers - arithmetic, not simulation.
# ---------------------------------------------------------------------------

def test_a_failed_contract_scores_minus_bid_not_the_total_it_reached():
    """
    Same no-partial-credit rule the differential helpers encode, resolved into
    a probability instead. A sample that reached 310 against a 320 contract
    must move the score by -320, not by +310 - and from 900 that is the
    difference between winning the game and dropping to 580.
    """
    missed = {"made": False, "bidding_total": 310, "defending_total": 100}
    assert _win_prob_when_we_bid(missed, 320, our_score=900, their_score=100) == \
        win_probability(900 - 320, 100 + 100, we_bid=True)


def test_setting_them_is_read_from_our_side_of_the_table():
    """`estimate_defence`'s "bidding" side is the opponents, so the sample's
    defending_total is ours. A sign error here would have the AI treating a
    set it inflicted as a set it suffered."""
    they_failed = {"made": False, "bidding_total": 300, "defending_total": 150}
    assert _win_prob_when_they_bid(they_failed, 320, our_score=400, their_score=400) == \
        win_probability(400 + 150, 400 - 320, we_bid=False)


def test_the_objective_is_a_probability():
    hand = _marginal_hand()
    p, diagnostics = bid_ev_win_probability(
        hand, Suit.CLUBS, 300, 400, 400, num_samples=8, rng=random.Random(1),
    )
    assert 0.0 <= p <= 1.0
    assert diagnostics["p_win_bid"] == p
    assert len(diagnostics["samples"]) == 8


def test_defending_from_a_hopeless_deficit_still_beats_bidding_into_it():
    """
    At 300-950 the opponents cross 1000 in any round they merely defend, so
    taking a small contract cannot win the game however well it goes - the
    only live path is that they bid and we set them. The objective finds that
    without a rule, and this is the case the issue's own worked example gets
    backwards (see the rules note above).
    """
    hand = _marginal_hand()
    bidding, _ = bid_ev_win_probability(
        hand, Suit.CLUBS, 300, 300, 950, num_samples=10, rng=random.Random(2),
    )
    defending, _ = defend_ev_win_probability(
        hand, 300, 300, 950, num_samples=10, rng=random.Random(2),
    )
    assert bidding == 0.0
    assert defending > bidding


# ---------------------------------------------------------------------------
# 5. The acceptance criterion: the score moves the decision.
# ---------------------------------------------------------------------------

def test_the_same_hand_and_bid_decide_differently_at_different_scores():
    """
    The issue's headline acceptance criterion: one hand, one contract level,
    one rollout budget, one seed - only the game score differs, and the verdict
    flips. Nothing in the code path branches on the score; it reaches the
    decision by changing what each rolled-out round is worth.

    Two late-game states rather than the issue's 200-180 / 890-950 pair,
    because those two differ *reliably in preference but not always in verdict*
    for a marginal hand (see the next test) - and a criterion demonstrated on a
    coin-flip is not demonstrated. These two are decided by the rules rather
    than by sampling luck:

      950-300 - we cross 1000 on defensive meld alone in any round we defend,
      so taking a contract we might be set on is a pure downside. Protecting a
      lead, with no rule saying so.

      890-950 - defending hands them the round that ends the game, and only
      the *bidding* team wins a round that carries both sides over. Bidding is
      the only path, on a hand whose points-EV says otherwise.
    """
    hand = _marginal_hand()
    ahead, _ev_ahead, _all_ahead = choose_bid_by_win_probability(
        hand, Suit.CLUBS, [None, 300], 950, 300, num_samples=20, rng=random.Random(3),
    )
    behind, _ev_behind, _all_behind = choose_bid_by_win_probability(
        hand, Suit.CLUBS, [None, 300], 890, 950, num_samples=20, rng=random.Random(3),
    )
    assert ahead is None       # sit on the lead
    assert behind == 300       # take the contract or lose


def test_bidding_gets_more_attractive_as_the_endgame_closes_in():
    """
    The issue's own 200-180 vs 890-950 example, asserted as the effect that is
    actually there rather than as a guaranteed flip of the verdict. On a hand
    this marginal the two options sit within a couple of points of each other
    at 200-180, so which one wins the argmax is decided by rollout noise - but
    the *size and sign* of the preference for bidding moves the same way on
    every seed tried, which is the claim the issue is really making.
    """
    hand = _marginal_hand()
    for seed in (0, 3):
        _b, _e, early = choose_bid_by_win_probability(
            hand, Suit.CLUBS, [None, 300], 200, 180, num_samples=20, rng=random.Random(seed),
        )
        _b2, _e2, late = choose_bid_by_win_probability(
            hand, Suit.CLUBS, [None, 300], 890, 950, num_samples=20, rng=random.Random(seed),
        )
        assert late[300] - late[None] > early[300] - early[None], seed


def test_the_differential_objective_cannot_tell_those_apart():
    """
    The other half of the same claim, and the reason this issue exists: the
    function being replaced has no score parameter at all, so it necessarily
    returns the same verdict in both situations. Asserting the *old* behaviour
    is what stops the test above from being a tautology about a function that
    happens to take two extra arguments.
    """
    hand = _marginal_hand()
    verdict, _ev, _all = choose_bid_vs_defence(
        hand, Suit.CLUBS, [None, 300], num_samples=15, rng=random.Random(3),
    )
    assert verdict is None    # one answer, for every score state there is


def test_the_chooser_keeps_the_existing_return_shape():
    """Swapping objectives has to be a function swap at the call site, not a
    rewrite of it - so the triple must match `choose_bid_vs_defence`'s."""
    hand = _marginal_hand()
    best, ev, all_evs = choose_bid_by_win_probability(
        hand, Suit.CLUBS, [None, 300], 400, 400, num_samples=6, rng=random.Random(4),
    )
    assert set(all_evs) == {None, 300}
    assert all_evs[best] == ev
    assert all(0.0 <= v <= 1.0 for v in all_evs.values())


def test_empty_candidates_still_raises():
    try:
        choose_bid_by_win_probability(
            _marginal_hand(), Suit.CLUBS, [], 0, 0, num_samples=4, rng=random.Random(5),
        )
    except ValueError:
        return
    raise AssertionError("expected ValueError for empty candidate_bids")


# ---------------------------------------------------------------------------
# 6. Folding under the new objective.
# ---------------------------------------------------------------------------

def test_fold_returns_two_probabilities():
    hand, trump = _powerhouse_hand()
    p_play_on, p_fold, diagnostics = fold_ev_win_probability(
        hand, trump, 300, 100, 40, 400, 400, num_samples=8, rng=random.Random(6),
    )
    assert 0.0 <= p_play_on <= 1.0
    assert 0.0 <= p_fold <= 1.0
    assert diagnostics["auto_set_shortcut"] is False
    assert diagnostics["p_play_on"] == p_play_on
    assert diagnostics["p_fold"] == p_fold


def test_the_auto_set_shortcut_survives_the_change_of_objective():
    """
    A contract that cannot be reached even taking all 250 trick points still
    folds by dominance: we score -bid either way, and playing on can only add
    to the opponents' total, which win probability is non-increasing in. The
    shortcut is re-justified rather than inherited - a change of objective is
    exactly what invalidates a shortcut argued under the old one.
    """
    hand, trump = _powerhouse_hand()
    p_play_on, p_fold, diagnostics = fold_ev_win_probability(
        hand, trump, 5000, 40, 40, 400, 400, num_samples=8, rng=random.Random(7),
    )
    assert diagnostics["auto_set_shortcut"] is True
    assert diagnostics["samples"] == []          # no 12-trick rollout was run
    assert p_play_on == p_fold                   # dominance, not a strict EV gap

    folds, _ = should_fold(hand, trump, 5000, 40, 40, num_samples=8,
                            rng=random.Random(7), our_score=400, their_score=400)
    assert folds is True


def test_conceding_is_evaluated_against_the_actual_game_score():
    """
    Folding gives the opponents `defending_meld` and gives us -bid. Whether
    that is survivable is a question about the score, and under the old
    differential objective it could not be asked at all. Near the bust floor
    the same concede is far more costly than it is at 0-0.
    """
    hand, trump = _powerhouse_hand()
    _play_on_safe, fold_safe, _d = fold_ev_win_probability(
        hand, trump, 300, 100, 40, 0, 0, num_samples=4, rng=random.Random(8),
    )
    _play_on_edge, fold_edge, _d2 = fold_ev_win_probability(
        hand, trump, 300, 100, 40, -800, 400, num_samples=4, rng=random.Random(8),
    )
    assert fold_edge < fold_safe


def test_should_fold_keeps_the_differential_path_when_no_score_is_given():
    """
    CODING_STANDARDS' widening convention: omitting the new optional arguments
    has to preserve the old behaviour exactly, because every existing caller
    and every skill level with the flag off still goes down that path.
    """
    hand, trump = _powerhouse_hand()
    _folds, diagnostics = should_fold(
        hand, trump, 300, 100, 40, num_samples=6, rng=random.Random(9),
    )
    assert "p_fold" not in diagnostics          # the differential path ran
    assert diagnostics["ev_fold"] == -300 - 40  # ...and its exact fold value


# ---------------------------------------------------------------------------
# 7. Nothing changes unless asked.
# ---------------------------------------------------------------------------

def test_the_win_probability_objective_is_off_at_every_skill_level():
    """
    Shipped disabled, following #101's precedent: over 120 paired deals at
    skill 5 it neither won more games (122-118, p=0.86) nor gained margin
    (-92 per deal, 95% CI -170 to -13). See the flag's comment in
    GENERAL_STRATEGY_SKILL_PARAMS for the full numbers and the measured
    explanation - this test exists so that turning it on is a deliberate edit
    with a measurement behind it, not something that drifts in.
    """
    from pinochle_engine import GENERAL_STRATEGY_SKILL_PARAMS

    for skill in (1, 2, 3, 4, 5):
        assert GENERAL_STRATEGY_SKILL_PARAMS[skill]["use_win_probability"] is False


def test_the_flag_needs_a_defence_budget_to_mean_anything():
    """The objective compares two futures, so it needs the rollout budget that
    scores a pass. A level with the flag on and no defence samples would
    silently fall through to the flat-zero path."""
    from pinochle_engine import GENERAL_STRATEGY_SKILL_PARAMS

    for skill, params in GENERAL_STRATEGY_SKILL_PARAMS.items():
        if params["use_win_probability"]:
            assert params["defence_samples"] > 0, skill


def test_the_flag_reaches_the_bidding_decision():
    """
    The flag has to change which chooser runs, not just sit in a dict. Flipped
    on for one constructed decision and checked by capturing the call, rather
    than by inferring it from a bid that could have come out the same way by
    chance.

    Uses the powerhouse hand deliberately. `_rollout_ev_bid` prunes any hand
    whose static `best_base_bid` ceiling is below FORCED_BID (250) *before*
    reaching any rollout, so the marginal hand never gets this far - which is
    itself worth knowing: that surviving threshold caps how aggressive the
    win-probability objective can be when behind late, and #106 has not
    removed it yet.
    """
    import pinochle_engine as engine
    import pinochle_rollout as rollout

    calls = []
    original = rollout.choose_bid_by_win_probability

    def recording(hand, trump, candidates, our_score, their_score, **kwargs):
        calls.append((our_score, their_score))
        return original(hand, trump, candidates, our_score, their_score, **kwargs)

    original_params = dict(engine.GENERAL_STRATEGY_SKILL_PARAMS[5])
    rollout.choose_bid_by_win_probability = recording
    engine.GENERAL_STRATEGY_SKILL_PARAMS[5] = dict(original_params, use_win_probability=True,
                                                    defence_samples=4)
    try:
        ai = engine.GeneralStrategy("me", None, skill_level=5, rng=random.Random(1))
        partner = engine.Player("partner", None)
        opp_a, opp_b = engine.Player("oppA", None), engine.Player("oppB", None)
        mine = engine.Team("A", [ai, partner])
        theirs = engine.Team("B", [opp_a, opp_b])
        ai.team = partner.team = mine
        opp_a.team = opp_b.team = theirs
        mine.score, theirs.score = 890, 950
        ai.hand, _trump = _powerhouse_hand()
        ai.choose_bid(0, 10, {
            "ever_bid": False, "passes_so_far": 0, "bid_history": [],
            "pass_history": [], "passed_players": [], "dealer": ai,
            "teams": [mine, theirs],
        })
    finally:
        rollout.choose_bid_by_win_probability = original
        engine.GENERAL_STRATEGY_SKILL_PARAMS[5] = original_params

    assert calls == [(890, 950)]


# ---------------------------------------------------------------------------
# 8. The generator itself.
# ---------------------------------------------------------------------------

def test_generation_mirrors_every_observation():
    """
    The mirroring is what makes antisymmetry exact rather than approximate, so
    it is checked on a freshly generated (tiny, deliberately under-powered)
    table rather than only on the baked-in one - the baked table would keep
    passing the antisymmetry test above even if the generator stopped
    mirroring, since it was built when the generator still did.
    """
    table, stats = generate_table(6, seed=11)
    assert stats["n_mirrored"] == 2 * stats["n_observations"]
    for i in range(BUCKET_COUNT):
        for j in range(BUCKET_COUNT):
            assert abs(table[i][j] + table[j][i] - 1.0) < 0.005, (i, j)


def test_generation_measures_its_own_prior_constants():
    """The prior's round-gain/spread are measured from the same run that
    builds the table, not carried over from whatever the module currently has
    baked in - otherwise a regeneration would shrink new data toward a stale
    model of the game."""
    _table, stats = generate_table(6, seed=12)
    assert stats["round_gain"] > 0
    assert stats["round_spread"] > 0
    assert stats["populated_cells"] > 0


def test_bucket_midpoints_land_inside_their_bucket():
    for index in range(BUCKET_COUNT):
        assert score_bucket(bucket_midpoint(index)) == index

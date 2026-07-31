"""
Tests for issue #112 (epic #104) - the labelled rollout training dataset.
Plain assert-based, pytest-discoverable. Covers:

  1. The cheap features, against hands where the right answer is countable by
     hand rather than being whatever the function happened to return.
  2. Hand encode/decode round-trips, since the CSV's `hand` column is what
     makes a row auditable without re-running the generator.
  3. Capture is pure observation - a recorded game plays out identically to an
     unrecorded one on the same seeds, and the situations it records are the
     ones the auction actually presented.
  4. Reproducibility from a seed, which is the acceptance criterion. Both
     phases, plus the stronger prefix property a per-row seed buys.
  5. Labels come from the LIVE configuration, not an assumed one - the flags
     that are off stay off, and the objective that ships is the one measured.
  6. Labels are sane and on the documented scales.
"""

import random

from pinochle_engine import Card, GENERAL_STRATEGY_SKILL_PARAMS, Game, GeneralStrategy, Suit
from generate_rollout_dataset import (
    BID_DECISION,
    COLUMNS,
    DEFAULT_SKILL_LEVEL,
    FEATURE_COLUMNS,
    FOLD_DECISION,
    LABEL_COLUMNS,
    RecordingStrategy,
    collect_situations,
    decode_hand,
    describe_live_configuration,
    encode_hand,
    extract_features,
    generate_dataset,
    label_situation,
    label_situations,
    live_label_settings,
    spot_check,
    write_dataset,
)


def _run_hand():
    """A-10-K-Q-J of clubs plus three off-suit aces: a Run, four aces, and a
    5-card trump suit - every presence flag except pinochle."""
    trump = Suit.CLUBS
    return [
        Card(trump, "A", 1), Card(trump, "10", 1), Card(trump, "K", 1),
        Card(trump, "Q", 1), Card(trump, "J", 1), Card(trump, "9", 1),
        Card(Suit.SPADES, "A", 1), Card(Suit.SPADES, "9", 1), Card(Suit.SPADES, "J", 1),
        Card(Suit.DIAMONDS, "A", 1), Card(Suit.DIAMONDS, "9", 1),
        Card(Suit.HEARTS, "A", 1),
    ], trump


def _junk_hand():
    """
    One ace and, called in clubs, no meld at all - the hopeless end of the
    range the spot-check leans on. Note there is no 9 of clubs: a trump 9 is a
    Dix and would put 10 points on the board, which is exactly the kind of
    quiet non-zero these tests exist to catch.
    """
    return [
        Card(Suit.CLUBS, "J", 1), Card(Suit.CLUBS, "J", 2), Card(Suit.CLUBS, "10", 1),
        Card(Suit.SPADES, "9", 1), Card(Suit.SPADES, "9", 2), Card(Suit.SPADES, "J", 1),
        Card(Suit.DIAMONDS, "9", 1), Card(Suit.DIAMONDS, "9", 2), Card(Suit.DIAMONDS, "Q", 1),
        Card(Suit.HEARTS, "9", 1), Card(Suit.HEARTS, "J", 1), Card(Suit.HEARTS, "A", 1),
    ]


def _pinochle_hand():
    """Q of spades + J of diamonds is the pinochle; nothing else lines up."""
    return [
        Card(Suit.SPADES, "Q", 1), Card(Suit.DIAMONDS, "J", 1),
        Card(Suit.CLUBS, "9", 1), Card(Suit.CLUBS, "J", 1), Card(Suit.CLUBS, "10", 1),
        Card(Suit.SPADES, "9", 1), Card(Suit.SPADES, "J", 1), Card(Suit.SPADES, "10", 1),
        Card(Suit.DIAMONDS, "9", 1), Card(Suit.DIAMONDS, "10", 1),
        Card(Suit.HEARTS, "9", 1), Card(Suit.HEARTS, "J", 1),
    ]


# ---------------------------------------------------------------------------
# 1. Features — countable by hand.
# ---------------------------------------------------------------------------

def test_features_count_what_they_say_they_count():
    hand, trump = _run_hand()
    f = extract_features(hand, trump, 320, score_diff=-40,
                         partner_has_bid=True, partner_has_passed=False)
    assert f["ace_count"] == 4
    assert f["trump_length"] == 6          # A 10 K Q J 9 of clubs
    assert f["longest_side_suit"] == 3     # spades, vs 2 diamonds and 1 heart
    assert f["bid"] == 320
    assert f["score_diff"] == -40
    assert f["partner_has_bid"] == 1
    assert f["partner_has_passed"] == 0


def test_presence_flags_follow_the_scoring_rules_not_a_second_definition():
    """
    The flags are read off `score_melds`' breakdown so that "has a run" means
    exactly what the rules mean by it. A hand-rolled "do I hold A-10-K-Q-J"
    check would be a second definition free to drift from the first.
    """
    run_hand, trump = _run_hand()
    run_features = extract_features(run_hand, trump, 300, 0, False, False)
    assert run_features["has_run"] == 1
    assert run_features["has_around"] == 1      # four aces = Aces Around
    assert run_features["has_pinochle"] == 0

    pin_features = extract_features(_pinochle_hand(), Suit.CLUBS, 300, 0, False, False)
    assert pin_features["has_pinochle"] == 1
    assert pin_features["has_run"] == 0

    junk_features = extract_features(_junk_hand(), Suit.CLUBS, 300, 0, False, False)
    assert junk_features["meld_total"] == 0
    assert (junk_features["has_run"], junk_features["has_pinochle"],
            junk_features["has_around"]) == (0, 0, 0)


def test_trump_length_and_side_suit_move_with_the_named_trump():
    """The same 12 cards, called under a different trump, are a different
    shape - which is the whole reason the candidate trump is recorded."""
    hand, _ = _run_hand()
    as_clubs = extract_features(hand, Suit.CLUBS, 300, 0, False, False)
    as_spades = extract_features(hand, Suit.SPADES, 300, 0, False, False)
    assert as_clubs["trump_length"] == 6 and as_spades["trump_length"] == 3
    assert as_clubs["longest_side_suit"] == 3 and as_spades["longest_side_suit"] == 6


def test_every_feature_column_is_produced():
    hand, trump = _run_hand()
    assert set(extract_features(hand, trump, 300, 0, False, False)) == set(FEATURE_COLUMNS)


# ---------------------------------------------------------------------------
# 2. The hand column round-trips.
# ---------------------------------------------------------------------------

def test_hand_encoding_round_trips():
    """A row has to be re-derivable from the CSV alone; if the hand column does
    not survive the trip, nothing downstream can audit a label."""
    hand, _ = _run_hand()
    assert sorted(decode_hand(encode_hand(hand)), key=repr) == sorted(hand, key=repr)


def test_hand_encoding_is_order_independent():
    """Sorted output, so two datasets differing only in deal order produce
    identical text and a diff shows real changes rather than shuffling."""
    hand, _ = _run_hand()
    shuffled = list(reversed(hand))
    assert encode_hand(shuffled) == encode_hand(hand)


def test_decoding_rejects_a_bad_token():
    try:
        decode_hand("XX_1")
    except ValueError:
        return
    raise AssertionError("expected ValueError for an unparseable card token")


# ---------------------------------------------------------------------------
# 3. Capture is pure observation, from real auctions.
# ---------------------------------------------------------------------------

def _play_one(cls, seed, **kwargs):
    random.seed(seed)
    players = [
        cls(f"P{i}", None, skill_level=DEFAULT_SKILL_LEVEL,
            rng=random.Random(seed + i), **kwargs)
        for i in range(4)
    ]
    game = Game.from_players(players)
    game.play(deal_seed=seed * 3 + 1)
    return [team.score for team in game.teams]


def test_recording_does_not_change_how_the_game_is_played():
    """
    The recorder must draw no random values. The tiers share the global RNG
    stream, so one stray `random` call inside the capture would shift every
    later decision and the recorded games would silently stop being the games
    the seed describes - the distribution this dataset exists to match.
    """
    assert _play_one(RecordingStrategy, 5, sink=[]) == _play_one(GeneralStrategy, 5)


def test_situations_come_from_real_auctions():
    """
    Not a uniform sample over hands: every row is a decision the engine
    actually put to a player, so bid levels above the opening bid and
    non-zero game scores both appear - neither of which a uniform sampler
    would ever generate.
    """
    situations = collect_situations(4, seed=112)
    assert situations
    assert {s["decision_point"] for s in situations} == {BID_DECISION, FOLD_DECISION}
    assert all(len(s["hand"]) == 12 for s in situations)

    bid_rows = [s for s in situations if s["decision_point"] == BID_DECISION]
    assert any(s["bid"] > 300 for s in bid_rows), "contested auctions should appear"
    assert any(s["our_score"] != 0 or s["their_score"] != 0 for s in situations), \
        "later rounds carry a real score into the decision"
    assert any(s["partner_has_bid"] or s["partner_has_passed"] for s in bid_rows)


def test_fold_situations_carry_the_declared_meld():
    """
    A fold decision happens after meld is face-up, so both melds are known
    exactly and must reach the row - `should_fold` needs them, and unlike at
    bid time they are not something to re-estimate.
    """
    folds = [s for s in collect_situations(6, seed=3)
             if s["decision_point"] == FOLD_DECISION]
    assert folds
    for situation in folds:
        assert situation["bidding_meld"] is not None
        assert situation["defending_meld"] is not None
        assert situation["trump"] is not None


def test_max_situations_trims_before_any_rollout_is_paid_for():
    """Capping the dataset must cut the situation list, not the labelled rows -
    labelling is the expensive half and a cap that ran after it would buy
    nothing."""
    assert len(collect_situations(20, seed=8, max_situations=5)) == 5


# ---------------------------------------------------------------------------
# 4. Reproducible from a seed. This is the acceptance criterion.
# ---------------------------------------------------------------------------

def test_capture_is_reproducible_from_the_seed():
    """
    Seeding the deal is not enough - the tiers draw from the global `random`
    module, the same trap `ab_harness._build_seated_player` documents. The
    disturbance below is what an unseeded generator would look like from the
    inside; the second run must be unaffected by it.
    """
    first = collect_situations(2, seed=77)
    random.seed(0)
    [random.random() for _ in range(500)]
    second = collect_situations(2, seed=77)

    def digest(situations):
        return [(s["decision_point"], encode_hand(s["hand"]), s["bid"],
                 s["our_score"], s["their_score"]) for s in situations]

    assert digest(first) == digest(second)


def test_labelling_is_reproducible_from_the_seed():
    situations = collect_situations(2, seed=77)[:6]
    first = label_situations(situations, num_samples=6, seed=77)
    random.seed(1)
    [random.random() for _ in range(500)]
    second = label_situations(situations, num_samples=6, seed=77)
    assert first == second


def test_a_short_run_is_a_prefix_of_a_long_one():
    """
    Rows are seeded from (seed, index) rather than from a stream carried across
    rows, so row N's labels do not depend on how many rows preceded it. That
    makes a cheap 4-row run a real check on a 5000-row one rather than merely a
    similar-looking one.
    """
    situations = collect_situations(2, seed=77)[:6]
    long_run = label_situations(situations, num_samples=6, seed=77)
    short_run = label_situations(situations[:3], num_samples=6, seed=77)
    assert short_run == long_run[:3]


def test_generate_dataset_is_reproducible_end_to_end():
    first = generate_dataset(1, num_samples=4, seed=21, max_rows=4)
    second = generate_dataset(1, num_samples=4, seed=21, max_rows=4)
    assert first == second
    assert len(first) == 4


# ---------------------------------------------------------------------------
# 5. Labelled against what is actually live.
# ---------------------------------------------------------------------------

def test_the_labelled_configuration_is_read_not_assumed():
    """
    The two flags that are deliberately off after being measured (#101 null
    twice, #102 negative) must reach the labelling functions from the live
    table. If someone turns one on in `pinochle_engine.py`, the labels have to
    follow rather than describe a configuration nobody runs.
    """
    params = GENERAL_STRATEGY_SKILL_PARAMS[DEFAULT_SKILL_LEVEL]
    assert live_label_settings(DEFAULT_SKILL_LEVEL) == (
        params["use_auction_evidence"], params["use_win_probability"],
    )


def test_the_live_configuration_report_reflects_the_live_table():
    """The report is what the PR quotes as "which configuration did you label
    against", so it has to be derived, not typed out."""
    params = GENERAL_STRATEGY_SKILL_PARAMS[DEFAULT_SKILL_LEVEL]
    text = describe_live_configuration(DEFAULT_SKILL_LEVEL)
    assert f"use_auction_evidence {params['use_auction_evidence']}" in text
    assert f"use_win_probability  {params['use_win_probability']}" in text
    if params["defence_samples"] > 0 and not params["use_win_probability"]:
        # The live bid path is #103's two-futures comparison on the score
        # differential scale, not #60's own-points bid_ev.
        assert "choose_bid_vs_defence" in text


def test_bid_labels_are_the_differential_comparison_the_live_path_makes():
    """
    `verdict_bid` must equal what `choose_bid_vs_defence` would return for the
    same situation: taking the contract beats defending it. Asserted against
    the recorded EVs rather than by calling the chooser again, since a second
    call would draw different samples and prove nothing about this row.
    """
    situations = [s for s in collect_situations(2, seed=31)
                  if s["decision_point"] == BID_DECISION][:4]
    for index, situation in enumerate(situations):
        row = label_situation(situation, index, num_samples=6, seed=31)
        assert row["verdict_bid"] == int(row["ev_take"] > row["ev_defend"])
        assert row["ev_play_on"] is None and row["ev_fold"] is None


def test_fold_labels_use_the_score_differential_objective_while_102_is_off():
    """
    Under the differential objective EV(fold) is exact and known in closed
    form: -bid - their meld. If the scores had leaked in, `should_fold` would
    have switched to win probability and `ev_fold` would be a probability in
    [0, 1] instead.
    """
    _evidence, use_win_probability = live_label_settings()
    if use_win_probability:
        return  # the closed form below describes the objective that is off

    situations = [s for s in collect_situations(6, seed=31)
                  if s["decision_point"] == FOLD_DECISION][:3]
    assert situations
    for index, situation in enumerate(situations):
        row = label_situation(situation, index, num_samples=6, seed=31)
        assert row["ev_fold"] == float(-situation["bid"] - situation["defending_meld"])
        assert row["verdict_fold"] == int(row["ev_play_on"] < row["ev_fold"]
                                          or row["p_make"] == 0.0 and row["ev_play_on"] == row["ev_fold"])
        assert row["ev_take"] is None and row["ev_defend"] is None


# ---------------------------------------------------------------------------
# 6. Labels are sane and on the documented scales.
# ---------------------------------------------------------------------------

def test_p_make_is_a_probability_and_evs_are_point_differentials():
    rows = generate_dataset(1, num_samples=6, seed=44, max_rows=8)
    for row in rows:
        assert 0.0 <= row["p_make"] <= 1.0
        for key in ("ev_take", "ev_defend", "ev_play_on", "ev_fold"):
            if row[key] is not None:
                # Score differentials, not probabilities: a round swings
                # hundreds of points, so anything inside [0, 1] for every row
                # would mean the win-probability objective had leaked in.
                assert -2000 < row[key] < 2000


def test_a_strong_hand_labels_higher_than_a_hopeless_one():
    """
    The acceptance criterion, stated directly rather than left to the batch
    spot-check: a Run plus four aces must measure as far more makeable than a
    hand holding no meld at all, or the labels carry no signal for #113 to fit.
    """
    strong_hand, _trump = _run_hand()
    common = {
        "decision_point": BID_DECISION, "bid": 300, "our_score": 0, "their_score": 0,
        "partner_has_bid": False, "partner_has_passed": False,
        "trump": None, "bidding_meld": None, "defending_meld": None,
    }
    strong = label_situation({**common, "hand": strong_hand}, 0, num_samples=25, seed=2)
    hopeless = label_situation({**common, "hand": _junk_hand()}, 0, num_samples=25, seed=2)
    assert strong["p_make"] > 0.5
    assert hopeless["p_make"] < 0.2
    assert strong["ev_take"] > hopeless["ev_take"]


def test_columns_cover_features_and_labels_without_overlap():
    assert set(FEATURE_COLUMNS) <= set(COLUMNS)
    assert set(LABEL_COLUMNS) <= set(COLUMNS)
    assert not set(FEATURE_COLUMNS) & set(LABEL_COLUMNS)
    assert len(COLUMNS) == len(set(COLUMNS))


def test_csv_is_written_with_blanks_for_the_inapplicable_labels(tmp_path):
    """
    Bid rows and fold rows share one table, so the labels that do not apply to
    a row are blank rather than zero - a zero EV is a real, meaningful value
    and #113 must not read one where no measurement was taken.
    """
    rows = generate_dataset(2, num_samples=4, seed=9, max_rows=30)
    path = tmp_path / "dataset.csv"
    write_dataset(rows, path)

    import csv
    with open(path, newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        assert reader.fieldnames == COLUMNS
        written = list(reader)

    assert len(written) == len(rows)
    for row in written:
        if row["decision_point"] == BID_DECISION:
            assert row["ev_take"] != "" and row["ev_play_on"] == ""
            assert row["verdict_fold"] == ""
        else:
            assert row["ev_play_on"] != "" and row["ev_take"] == ""
            assert row["verdict_bid"] == ""
        assert len(decode_hand(row["hand"])) == 12


def test_spot_check_separates_the_two_ends_of_the_range():
    rows = generate_dataset(3, num_samples=8, seed=13, max_rows=40)
    check = spot_check(rows)
    assert check["bid_rows"] + check["fold_rows"] == len(rows)
    assert check["top_quartile_n"] > 0 and check["bottom_quartile_n"] > 0
    assert check["top_quartile_p_make"] > check["bottom_quartile_p_make"]

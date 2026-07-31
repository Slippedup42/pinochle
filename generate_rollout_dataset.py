"""
Labelled rollout training data (issue #112, epic #104).

Epic #104's plan is to do the expensive thinking offline and ship the
conclusion: run the Monte Carlo rollouts in Python, record *cheap* features
against the *measured* outcome, fit a small predictor to that (#113), and have
`bidding.ts` consult the predictor instead of `OPENER_THRESHOLD` (#114). This
module is the first step and only the first step - it generates and stores the
labelled examples. No modelling happens here, and no strategy is added: every
label is produced by `pinochle_rollout.py` exactly as the live AI calls it.

Two properties do the work:

  Situations come from real auctions, not from uniformly random hands. A
  uniform sample over 12-card hands is not the distribution the AI faces: it
  never sees a hand *after three opponents have already passed at 320*, and it
  sees weak hands far more often than a bid decision ever reaches. Real games
  are played (`Game.play`) with a recording subclass of `GeneralStrategy` that
  snapshots every `choose_bid` and every `decide_fold` it is asked, then hands
  the decision straight to `super()`. Recording is pure observation - it
  consumes no randomness and changes no behaviour, so the games play out
  exactly as an unrecorded run of the same seed would.

  Labels come from the configuration that is actually LIVE. `GENERAL_STRATEGY_
  SKILL_PARAMS` in `pinochle_engine.py` is read at runtime, not copied here, so
  this cannot silently drift from what the AI does. As of writing, that means
  `defence_samples`/`fold_samples` ON and `use_auction_evidence` (#101,
  measured null twice) / `use_win_probability` (#102, measured negative) OFF -
  see `describe_live_configuration()`, which prints what it found rather than
  what anyone assumed. Distilling a behaviour that is not switched on would
  waste the whole of #104.

  In particular, the live bid path (`GeneralStrategy._rollout_ev_bid`) with
  `defence_samples > 0` calls `choose_bid_vs_defence`, which is
  `bid_ev_differential` vs `defend_ev` on the *score differential* scale. #60's
  own-points `bid_ev` is not on the live path at any skill level, so it is not
  what gets labelled here.

  The one thing deliberately NOT matched to live is the sample count. Live runs
  20 samples per rollout because it is thinking at the table; labelling runs
  `--samples` (150 by default) because this is offline and, per #112, label
  accuracy matters more than throughput. That is a difference in how precisely
  the same quantity is measured, not a difference in which quantity - the
  objective, the flags and the determinization are identical either way.

Reproducibility. Seeding the deal is not enough - the AI tiers draw from the
global `random` module in several places and `GeneralStrategy.rng` defaults to
that module, the same trap `ab_harness._build_seated_player` documents. So both
phases seed the global module *and* hand each player its own `random.Random`.
Labelling seeds per row rather than per run, which additionally makes a row's
labels independent of how many rows preceded it: a truncated run and a full run
agree on every row they share.

Output is CSV - plain, diffable, regenerated rather than hand-edited. The 12
cards are written out too, so a row can be re-derived and audited without
re-running anything.

    python generate_rollout_dataset.py --games 200 --samples 150 --seed 112 \
        --out rollout_dataset.csv
    python generate_rollout_dataset.py --config      # print the live config and exit
"""

import argparse
import csv
import random
import time

from pinochle_engine import (
    Card,
    GENERAL_STRATEGY_SKILL_PARAMS,
    Game,
    GeneralStrategy,
    OPENING_BID,
    RANKS,
    Suit,
    best_base_bid,
    score_melds,
)
from pinochle_rollout import bid_ev_differential, defend_ev, should_fold


# ---------------------------------------------------------------------------
# The live configuration — read, never assumed.
#
# Every label below is only worth generating if it describes behaviour that is
# actually switched on. Several epic #106 flags are deliberately off after being
# measured, so this section reads the skill-params table at runtime and reports
# what it found, rather than restating a snapshot that can rot.
# ---------------------------------------------------------------------------

# The skill level labelled by default. 5 is the strongest configuration that
# ships, and the one #104 wants distilled - skills 1-3 run no rollouts at all,
# so there is nothing there to distil.
DEFAULT_SKILL_LEVEL = 5


def describe_live_configuration(skill_level=DEFAULT_SKILL_LEVEL):
    """
    A human-readable account of the configuration the labels describe, derived
    from `GENERAL_STRATEGY_SKILL_PARAMS` at call time.

    Printed by the CLI and quoted in the PR body on purpose: "which
    configuration did you label against" is the question that decides whether
    this dataset is useful or actively misleading, and it should be answerable
    from the run's own output rather than from someone's memory of the flags.
    """
    params = GENERAL_STRATEGY_SKILL_PARAMS[skill_level]
    bid_path = (
        "choose_bid_vs_defence (bid_ev_differential vs defend_ev, "
        f"{params['defence_samples']} samples)"
        if params["defence_samples"] > 0 and not params["use_win_probability"]
        else "choose_bid_by_win_probability"
        if params["defence_samples"] > 0
        else f"choose_bid_by_ev ({params['bid_samples']} samples, own-points scale)"
    )
    lines = [
        f"GeneralStrategy skill {skill_level}, as configured in pinochle_engine.py:",
        f"  hand_valuation       {params['hand_valuation']}",
        f"  bid_samples          {params['bid_samples']}",
        f"  defence_samples      {params['defence_samples']}",
        f"  fold_samples         {params['fold_samples']}",
        f"  use_auction_evidence {params['use_auction_evidence']}",
        f"  use_win_probability  {params['use_win_probability']}",
        f"  live bid path        {bid_path}",
        f"  live fold path       should_fold "
        f"({'win probability' if params['use_win_probability'] else 'score differential'})",
    ]
    return "\n".join(lines)


def live_label_settings(skill_level=DEFAULT_SKILL_LEVEL):
    """
    The two switches the labelling functions here have to honour, pulled from
    the live table so a flag flipping in `pinochle_engine.py` changes what gets
    labelled instead of quietly disagreeing with it.

    Returns (use_auction_evidence, use_win_probability).
    """
    params = GENERAL_STRATEGY_SKILL_PARAMS[skill_level]
    return params["use_auction_evidence"], params["use_win_probability"]


# ---------------------------------------------------------------------------
# Cheap features — the whole point of the exercise.
#
# Every feature here must be computable in a browser in microseconds from the
# hand and the visible table state, because #114 evaluates them inside a React
# render loop on a phone. Anything that needs a rollout is a label, not a
# feature. `score_melds` is the one non-trivial call and it is a single pass
# over 12 cards, which `bidding.ts` already does.
# ---------------------------------------------------------------------------

FEATURE_COLUMNS = [
    "meld_total",        # score_melds(hand, trump) — guaranteed meld, not the padded Base Bid
    "ace_count",
    "trump_length",
    "longest_side_suit",
    "has_run",
    "has_pinochle",
    "has_around",
    "bid",               # the bid under consideration (not the current bid)
    "score_diff",        # our cumulative game score minus theirs
    "partner_has_bid",
    "partner_has_passed",
]


def _longest_side_suit(hand, trump):
    return max(
        (sum(1 for c in hand if c.suit == suit) for suit in Suit if suit != trump),
        default=0,
    )


def extract_features(hand, trump, bid, score_diff, partner_has_bid, partner_has_passed):
    """
    The cheap feature vector, in `FEATURE_COLUMNS` order.

    Presence flags come from `score_melds`' breakdown rather than being
    re-derived by counting cards, so "has a run" here means exactly what the
    scoring rules mean by it (including the double variants, which replace the
    single value rather than stacking) instead of a second, subtly different
    definition drifting alongside the first.
    """
    meld_total, breakdown = score_melds(hand, trump)
    return {
        "meld_total": meld_total,
        "ace_count": sum(1 for c in hand if c.rank == "A"),
        "trump_length": sum(1 for c in hand if c.suit == trump),
        "longest_side_suit": _longest_side_suit(hand, trump),
        "has_run": int("Run" in breakdown or "Double Run" in breakdown),
        "has_pinochle": int("Pinochle" in breakdown or "Double Pinochle" in breakdown),
        "has_around": int(any("Around" in name for name in breakdown)),
        "bid": bid,
        "score_diff": score_diff,
        "partner_has_bid": int(partner_has_bid),
        "partner_has_passed": int(partner_has_passed),
    }


# ---------------------------------------------------------------------------
# Hand serialisation — so a row is auditable without re-running the generator.
# ---------------------------------------------------------------------------

def encode_hand(hand):
    """`Card.__repr__`'s form, space-separated and sorted, so the same 12 cards
    always produce the same string and a diff of two datasets is readable."""
    return " ".join(sorted(repr(card) for card in hand))


def decode_hand(text):
    """Inverse of `encode_hand`. Exists so tests and #113 can round-trip a row
    back into real `Card` objects instead of trusting the feature columns."""
    cards = []
    for token in text.split():
        body, copy_id = token.rsplit("_", 1)
        rank, suit_letter = body[:-1], body[-1]
        if rank not in RANKS:
            raise ValueError(f"unknown rank in card token {token!r}")
        cards.append(Card(Suit(suit_letter), rank, int(copy_id)))
    return cards


# ---------------------------------------------------------------------------
# Situation capture — real auctions, via a recording subclass.
#
# `Game.play`'s `on_round` hook fires after a round is scored, by which point
# the twelve hands have been played out and the auction is gone. The decision
# points themselves are only visible from inside the player, so this subclass
# snapshots them and delegates untouched.
# ---------------------------------------------------------------------------

BID_DECISION = "bid"
FOLD_DECISION = "fold"


class RecordingStrategy(GeneralStrategy):
    """
    `GeneralStrategy` that appends every bid and fold decision point it reaches
    to a shared `sink` list, then answers exactly as `GeneralStrategy` would.

    Capture is deliberately inert: it copies the hand and reads integers off
    the context, draws no random values, and calls no valuation function. That
    matters more than it looks - the AI tiers share the global RNG stream, so a
    single `random` call inside the recorder would shift every later decision
    in the game and the recorded games would no longer be the games the seed
    describes.

    What is captured is the raw *situation* (hand, contract level, auction
    state, scores). Features and labels are both derived later, in the
    labelling phase, so neither is baked into the capture.
    """

    def __init__(self, name, team=None, skill_level=DEFAULT_SKILL_LEVEL, rng=None, sink=None):
        super().__init__(name, team, skill_level=skill_level, rng=rng)
        self.sink = sink if sink is not None else []

    def _scores(self, teams=None):
        """
        Our cumulative game score and the opponents'.

        `teams` is the auction context's list when there is one. At the fold
        point there is no context, so the opponent comes from the round
        bookkeeping `Round._stamp_team_round_context` leaves on the team - read
        with `getattr`, because a hand-built `Team` in a test has no `opponent`
        attribute at all and a capture must never be the thing that raises.
        """
        our = self.team.score if self.team is not None else 0
        if teams is not None:
            opponent = next((t for t in teams if t is not self.team), None)
        else:
            opponent = getattr(self.team, "opponent", None)
        return our, opponent.score if opponent is not None else 0

    def choose_bid(self, current_bid, min_increment, context=None):
        if context is not None and self.team is not None:
            partner = next((p for p in self.team.players if p is not self), None)
            our_score, their_score = self._scores(context["teams"])
            # The level under consideration, derived exactly as
            # `_rollout_ev_bid` derives it: the opening bid if nobody has bid
            # yet, otherwise one increment above the standing bid.
            bid = OPENING_BID if not context["ever_bid"] else current_bid + min_increment
            self.sink.append({
                "decision_point": BID_DECISION,
                "hand": list(self.hand),
                "bid": bid,
                "our_score": our_score,
                "their_score": their_score,
                "partner_has_bid": any(p is partner for p, _ in context["bid_history"]),
                "partner_has_passed": any(p is partner for p, _ in context["pass_history"]),
                "trump": None,          # filled in at labelling time
                "bidding_meld": None,   # bid time — meld is not declared yet
                "defending_meld": None,
                # Which row of the skill table this decision came from, so
                # labelling honours the same flags this seat was playing under
                # rather than whichever level happens to be the default.
                "skill_level": self.skill_level,
            })
        return super().choose_bid(current_bid, min_increment, context)

    def decide_fold(self, trump, bid, bidding_meld, defending_meld):
        if self.team is not None:
            our_score, their_score = self._scores()
            self.sink.append({
                "decision_point": FOLD_DECISION,
                # Post-pass, post-meld: 12 cards again, but not the 12 dealt.
                "hand": list(self.hand),
                "bid": bid,
                "our_score": our_score,
                "their_score": their_score,
                # Nobody is still bidding at the fold point; the auction is
                # over and these columns describe the auction.
                "partner_has_bid": False,
                "partner_has_passed": False,
                "trump": trump,
                "bidding_meld": bidding_meld,
                "defending_meld": defending_meld,
                "skill_level": self.skill_level,
            })
        return super().decide_fold(trump, bid, bidding_meld, defending_meld)


def collect_situations(n_games, seed, skill_level=DEFAULT_SKILL_LEVEL, max_situations=None):
    """
    Play `n_games` full games with all four seats recording, and return every
    decision point reached, in play order.

    Seats the same skill level in all four seats on purpose. The distribution
    #114 has to serve is the one a strong AI meets at the table, and mixing in
    weaker seats would populate it with auctions the strong AI would never have
    produced.

    Both the deals and the players are seeded, for the reason
    `ab_harness._build_seated_player` records: the tiers reach for the global
    `random` module, so seeding only `deal_seed` leaves the run
    irreproducible.
    """
    seed_source = random.Random(seed)
    situations = []

    for _ in range(n_games):
        if max_situations is not None and len(situations) >= max_situations:
            break
        deal_seed = seed_source.randrange(2 ** 63)
        play_seed = seed_source.randrange(2 ** 63)

        random.seed(play_seed)  # covers the tiers that reach for the global RNG
        players = [
            RecordingStrategy(
                f"P{seat}", None, skill_level=skill_level,
                rng=random.Random(play_seed + seat), sink=situations,
            )
            for seat in range(4)
        ]
        Game.from_players(players).play(deal_seed=deal_seed)

    if max_situations is not None:
        del situations[max_situations:]
    return situations


# ---------------------------------------------------------------------------
# Labelling — the expensive half, measured by the existing rollout machinery.
#
# Nothing is reimplemented here. `bid_ev_differential`, `defend_ev` and
# `should_fold` are called with the same arguments and the same objective the
# live path uses, so a label is by construction the number the AI would have
# acted on, only computed with a larger sample budget.
# ---------------------------------------------------------------------------

LABEL_COLUMNS = [
    "p_make",        # P(the contract is made) — bid rows: by us; fold rows: by us if we play on
    "ev_take",       # score differential from taking the contract (bid rows)
    "ev_defend",     # score differential from passing and defending it (bid rows)
    "ev_play_on",    # score differential from playing the contract out (fold rows)
    "ev_fold",       # score differential from conceding — exact, not sampled (fold rows)
    "verdict_bid",   # 1 when taking beats defending, i.e. what choose_bid_vs_defence returns
    "verdict_fold",  # 1 when should_fold says concede
]

CONTEXT_COLUMNS = [
    "decision_point",
    "trump",
    "our_score",
    "their_score",
    "bidding_meld",
    "defending_meld",
    "hand",
]

COLUMNS = CONTEXT_COLUMNS + FEATURE_COLUMNS + LABEL_COLUMNS


def label_bid_situation(situation, num_samples, rng):
    """
    Measure a bid decision: what taking the contract is worth, what defending
    it is worth, and how often we make it.

    The candidate trump is `best_base_bid`'s pick under the current score -
    the same call `_rollout_ev_bid` makes - rather than a search over all four
    suits. Labelling a suit the AI would never name would describe a contract
    that is never played.

    `evidence` stays None while `use_auction_evidence` is off, so the labels
    match the uniform determinization the live path actually uses.
    """
    hand = situation["hand"]
    trump, _ceiling, _breakdown = best_base_bid(
        hand, situation["our_score"], situation["their_score"],
    )
    bid = situation["bid"]

    ev_take, diagnostics = bid_ev_differential(hand, trump, bid, num_samples=num_samples, rng=rng)
    ev_defend, _ = defend_ev(hand, bid, num_samples=num_samples, rng=rng)

    return trump, {
        "p_make": diagnostics["p_make"],
        "ev_take": ev_take,
        "ev_defend": ev_defend,
        "ev_play_on": None,
        "ev_fold": None,
        "verdict_bid": int(ev_take > ev_defend),
        "verdict_fold": None,
    }


def label_fold_situation(situation, num_samples, rng):
    """
    Measure a concede decision via `should_fold`, which needs no separate
    EV(fold) rollout - the rules fix a conceded round's score exactly.

    Scores are withheld (`our_score`/`their_score` left as None) while
    `use_win_probability` is off, because supplying them is precisely what
    switches `should_fold` to the win-probability objective. Passing them
    "for completeness" would label a different objective than the one that
    ships.
    """
    _use_evidence, use_win_probability = live_label_settings(
        situation.get("skill_level", DEFAULT_SKILL_LEVEL),
    )
    hand = situation["hand"]
    trump = situation["trump"]

    fold, diagnostics = should_fold(
        hand, trump, situation["bid"],
        situation["bidding_meld"], situation["defending_meld"],
        num_samples=num_samples, rng=rng,
        our_score=situation["our_score"] if use_win_probability else None,
        their_score=situation["their_score"] if use_win_probability else None,
    )

    return trump, {
        "p_make": diagnostics["p_make"],
        "ev_take": None,
        "ev_defend": None,
        "ev_play_on": diagnostics["ev_play_on"],
        "ev_fold": diagnostics["ev_fold"],
        "verdict_bid": None,
        "verdict_fold": int(fold),
    }


def label_situation(situation, index, num_samples, seed):
    """
    Turn one captured situation into a finished row.

    The RNG is derived from `(seed, index)` rather than carried across rows, so
    a row's labels do not depend on how many rows were labelled before it - a
    100-row run and the first 100 rows of a 5000-row run come out identical,
    which makes a short run a real check on a long one instead of merely a
    similar-looking one. The global module is seeded too, since the plain
    `Player` objects inside a rollout reach for it directly.
    """
    row_seed = (seed * 1_000_003 + index) % (2 ** 63)
    random.seed(row_seed)
    rng = random.Random(row_seed)

    if situation["decision_point"] == BID_DECISION:
        trump, labels = label_bid_situation(situation, num_samples, rng)
    else:
        trump, labels = label_fold_situation(situation, num_samples, rng)

    features = extract_features(
        situation["hand"], trump, situation["bid"],
        situation["our_score"] - situation["their_score"],
        situation["partner_has_bid"], situation["partner_has_passed"],
    )

    row = {
        "decision_point": situation["decision_point"],
        "trump": trump.value,
        "our_score": situation["our_score"],
        "their_score": situation["their_score"],
        "bidding_meld": situation["bidding_meld"],
        "defending_meld": situation["defending_meld"],
        "hand": encode_hand(situation["hand"]),
    }
    row.update(features)
    row.update(labels)
    return row


def label_situations(situations, num_samples, seed, progress_every=0):
    """Label every situation, in order. Returns the finished rows."""
    rows = []
    for index, situation in enumerate(situations):
        rows.append(label_situation(situation, index, num_samples, seed))
        if progress_every and (index + 1) % progress_every == 0:
            print(f"  labelled {index + 1}/{len(situations)}", flush=True)
    return rows


def generate_dataset(n_games, num_samples, seed, skill_level=DEFAULT_SKILL_LEVEL,
                     max_rows=None, progress_every=0):
    """
    The whole pipeline: play games, capture decision points, label them.

    Collection and labelling are separate passes rather than one interleaved
    one, so the expensive labelling never perturbs the games it is describing,
    and `max_rows` can trim the situation list before any rollout is paid for.
    """
    situations = collect_situations(
        n_games, seed, skill_level=skill_level, max_situations=max_rows,
    )
    return label_situations(situations, num_samples, seed, progress_every=progress_every)


def write_dataset(rows, path):
    """CSV, one header row, `COLUMNS` order. Floats are rounded to 4 places:
    a rollout label carries nowhere near 17 significant digits of information,
    and full repr noise makes the file churn on every regeneration for reasons
    that have nothing to do with the AI changing."""
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS)
        writer.writeheader()
        for row in rows:
            writer.writerow({
                key: ("" if row[key] is None
                      else round(row[key], 4) if isinstance(row[key], float)
                      else row[key])
                for key in COLUMNS
            })


# ---------------------------------------------------------------------------
# Spot-check — the acceptance criterion, computed rather than eyeballed.
# ---------------------------------------------------------------------------

# A hand with this much guaranteed meld plus this many aces is not a marginal
# call; if such hands do not show a clearly higher make rate than hands with
# neither, the labels are wrong and no amount of model fitting in #113 will
# recover from it.
STRONG_MELD = 120
STRONG_ACES = 4


def hand_strength_proxy(row):
    """
    A crude ordering of hands, using only feature columns.

    Meld plus flat ace value is the same pairing `compute_base_bid` builds its
    valuation from (`ACE_VALUE` is 20 there), reused here only to rank rows for
    the spot-check. It is not a label, not a prediction, and not something #113
    should fit to - it exists so the check has a population that is always
    filled, unlike the deliberately extreme absolute buckets below.
    """
    return row["meld_total"] + 20 * row["ace_count"]


def spot_check(rows):
    """
    Compare mean `p_make` on hands that are obviously strong against hands that
    are obviously hopeless, plus the overall range.

    Deliberately a comparison of two populations rather than a threshold on
    one: "p_make > 0.6 for strong hands" would have to be re-tuned every time
    the AI changes, while "strong hands beat hopeless hands" is the property
    that actually has to hold for the dataset to carry any signal at all.

    Two pairs of populations, because the absolute one is the honest statement
    of the acceptance criterion but is thin (a bid decision is only rarely
    reached holding literally nothing - about 0.5% of captured bid rows), while
    the strength quartiles are always populated and so are the pair a small run
    can actually be judged on.
    """
    bid_rows = [r for r in rows if r["decision_point"] == BID_DECISION]
    strong = [r for r in bid_rows
              if r["meld_total"] >= STRONG_MELD and r["ace_count"] >= STRONG_ACES]
    hopeless = [r for r in bid_rows if r["meld_total"] == 0 and r["ace_count"] <= 1]

    ranked = sorted(bid_rows, key=hand_strength_proxy)
    quartile = len(ranked) // 4
    bottom, top = ranked[:quartile], ranked[len(ranked) - quartile:]

    def mean(sample, key):
        return sum(r[key] for r in sample) / len(sample) if sample else float("nan")

    return {
        "bid_rows": len(bid_rows),
        "fold_rows": len(rows) - len(bid_rows),
        "strong_n": len(strong),
        "strong_p_make": mean(strong, "p_make"),
        "hopeless_n": len(hopeless),
        "hopeless_p_make": mean(hopeless, "p_make"),
        "top_quartile_n": len(top),
        "top_quartile_p_make": mean(top, "p_make"),
        "bottom_quartile_n": len(bottom),
        "bottom_quartile_p_make": mean(bottom, "p_make"),
        "p_make_min": min((r["p_make"] for r in rows), default=float("nan")),
        "p_make_max": max((r["p_make"] for r in rows), default=float("nan")),
        "bid_verdict_rate": mean(bid_rows, "verdict_bid"),
        "fold_verdict_rate": mean(
            [r for r in rows if r["decision_point"] == FOLD_DECISION], "verdict_fold",
        ),
    }


def format_spot_check(check):
    return "\n".join([
        f"  bid rows {check['bid_rows']}, fold rows {check['fold_rows']}",
        f"  strong hands (meld >= {STRONG_MELD}, aces >= {STRONG_ACES}):  "
        f"n={check['strong_n']:<5d} mean p_make {check['strong_p_make']:.3f}",
        f"  hopeless hands (no meld, <= 1 ace):              "
        f"n={check['hopeless_n']:<5d} mean p_make {check['hopeless_p_make']:.3f}",
        f"  top quartile by meld + 20/ace:                   "
        f"n={check['top_quartile_n']:<5d} mean p_make {check['top_quartile_p_make']:.3f}",
        f"  bottom quartile by meld + 20/ace:                "
        f"n={check['bottom_quartile_n']:<5d} mean p_make {check['bottom_quartile_p_make']:.3f}",
        f"  p_make range {check['p_make_min']:.3f} - {check['p_make_max']:.3f}",
        f"  bid preferred over defending in {check['bid_verdict_rate']:.1%} of bid rows",
        f"  concede preferred in {check['fold_verdict_rate']:.1%} of fold rows",
    ])


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Generate labelled rollout training data (#112, epic #104)",
    )
    parser.add_argument("--games", type=int, default=200,
                        help="full games to play for situation capture (default: 200)")
    parser.add_argument("--samples", type=int, default=150,
                        help="Monte Carlo samples per label; label accuracy matters more "
                             "than throughput here, since this runs offline once (default: 150)")
    parser.add_argument("--seed", type=int, default=112,
                        help="seeds deals, players and labelling (default: 112)")
    parser.add_argument("--skill", type=int, default=DEFAULT_SKILL_LEVEL,
                        help=f"GeneralStrategy skill level to seat (default: {DEFAULT_SKILL_LEVEL})")
    parser.add_argument("--max-rows", type=int, default=None,
                        help="cap the dataset, trimming situations before any rollout is paid for")
    parser.add_argument("--out", default="rollout_dataset.csv", help="output CSV path")
    parser.add_argument("--config", action="store_true",
                        help="print the live configuration the labels would describe, and exit")
    args = parser.parse_args()

    print(describe_live_configuration(args.skill))
    if args.config:
        return

    start = time.perf_counter()
    rows = generate_dataset(
        args.games, args.samples, args.seed, skill_level=args.skill,
        max_rows=args.max_rows, progress_every=100,
    )
    elapsed = time.perf_counter() - start

    write_dataset(rows, args.out)
    print(f"\n{len(rows)} rows -> {args.out} in {elapsed:.1f}s "
          f"({elapsed / len(rows) * 1000:.0f} ms/row, {args.samples} samples/label)")
    print("Spot-check:")
    print(format_spot_check(spot_check(rows)))


if __name__ == "__main__":
    main()

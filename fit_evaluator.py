"""
A cheap evaluator fitted to the rollout data (issue #113, epic #104).

#112 measured what the skill-5 rollout AI decides in 2000 real decision points
and wrote them to `rollout_dataset.csv`. This module fits a small predictor to
those rows and reports how often it reaches the *same decision*, so #114 can
replace `bidding.ts`'s `OPENER_THRESHOLD = 320` with something fitted to
measured outcomes instead of guessed.

Two models, not one. `decision_point` splits the dataset into `bid` rows (1655)
and `fold` rows (345), and they are not the same problem wearing two hats:

  * A bid row asks "does taking this contract beat defending it", from a
    12-card hand with both melds unknown and an auction still running.
  * A fold row asks "does playing this contract out beat conceding it", from a
    *different* 12-card hand - post-pass - with both melds face up and the
    auction over.

The fold row's extra columns (`bidding_meld`, `defending_meld`) are blank on a
bid row because no such measurement exists there, not because they are zero.
One model over the union would have to invent values for them.

Why logistic regression and nothing heavier. The decision each model has to
reproduce is a threshold on a difference of two EVs, and the numbers below say a
linear model in log-odds already sits within noise of a 150-tree gradient-boosted
ensemble on the same features (86.3% vs 86.7% five-fold, against a fold-to-fold
spread of +-1.6%). A weight vector is inspectable, exports to TypeScript as a dot
product and a comparison, and costs microseconds in a React render; an ensemble
buys none of that back for four tenths of a point. `--compare` prints the
baselines that argument rests on rather than asking anyone to take it on trust.

Two features are not read from the CSV. `base_bid_ceiling` is recomputed here
from the row's `hand` column via `compute_max_bid`/`capped_bid`, and since #273
`meld_total` is recomputed through `score_melds` for the reason its own
docstring gives. That is not a
label leak and not expensive: it is exactly the quantity `bidding.ts` already
computes as `bestBaseBid` and compares against `OPENER_THRESHOLD`, so #114 gets
it for free. It carries the non-linear part of the valuation - run and marriage
values, the competitive adjustment, the 400-cap - that no linear combination of
`meld_total`, `ace_count` and `trump_length` can express, and it is worth about
eight points of decision agreement on its own.

Everything is stdlib. numpy is installed on this machine but nothing here needs
it, the rest of the repo does not import it, and a fitted model that only a
machine with numpy can reproduce is a worse artefact than one any Python can.

    python fit_evaluator.py                       # fit, evaluate, write the model
    python fit_evaluator.py --compare             # + baselines the "simple is enough" claim rests on
    python fit_evaluator.py --disagreements       # + where the model and the rollout part company
"""

import argparse
import csv
import json
import math

from pinochle_engine import (
    OPENER_THRESHOLD,
    Suit,
    capped_bid,
    compute_max_bid,
    score_melds,
)
from generate_rollout_dataset import (
    BID_DECISION,
    FOLD_DECISION,
    decode_hand,
    describe_live_configuration,
)


# ---------------------------------------------------------------------------
# Features — the CSV columns, plus the one valuation `bidding.ts` already has.
# ---------------------------------------------------------------------------

# The default output. Committed alongside this module so #114 has an artefact to
# export and #115 has something to measure, without re-running the fit.
DEFAULT_MODEL_PATH = "rollout_evaluator.json"
DEFAULT_DATASET_PATH = "rollout_dataset.csv"

BID_FEATURES = [
    "meld_total",
    "ace_count",
    "trump_length",
    "longest_side_suit",
    "has_run",
    "has_pinochle",
    "has_around",
    "bid",
    "score_diff",
    "partner_has_bid",
    "partner_has_passed",
    "base_bid_ceiling",     # compute_max_bid + the cap rule — `bestBaseBid` in bidding.ts
    "ceiling_minus_bid",    # how far the valuation clears the level under consideration
]

# `ceiling_minus_bid` is exactly `base_bid_ceiling - bid`, so those three columns
# are collinear and the ridge penalty splits one effect across them: read the
# fitted weights as the sums (+0.025 per point of ceiling, -0.026 per point of
# bid), not individually. Dropping either redundant column moves five-fold
# agreement by under 0.2% - well inside the +-1.9% fold spread - so all three are
# kept for readability rather than because the third earns its place.

# Deliberately *not* `score_diff`, and deliberately not the auction columns.
#
# `should_fold` was called with `our_score`/`their_score` withheld while
# `use_win_probability` is off (see `label_fold_situation`), so `verdict_fold` is
# mathematically independent of the game score - any weight fitted on it would be
# fitting noise, and five-fold agreement does drop (93.6% -> 92.8%) when it is
# included. `partner_has_bid`/`partner_has_passed` are constant False on every
# fold row: the auction is over by then, so they carry no information at all.
FOLD_FEATURES = [
    "meld_total",
    "ace_count",
    "trump_length",
    "longest_side_suit",
    "has_run",
    "has_pinochle",
    "has_around",
    "bid",
    "bidding_meld",
    "defending_meld",
    "base_bid_ceiling",
    "ceiling_minus_bid",
    "tricks_needed",        # bid - bidding_meld: points still to be won in tricks
    "fold_cost",            # bid + defending_meld: exactly what conceding costs
]

# Ridge strengths, chosen by the five-fold sweep `--compare` reproduces. The fold
# model is regularised harder relative to its size because 345 rows and 14
# features is a thin fit and the fold-to-fold spread is three times the bid
# model's.
BID_L2 = 0.01
FOLD_L2 = 0.003


def base_bid_ceiling(hand, trump, our_score=0, their_score=0):
    """
    The Base Bid valuation of `hand` in `trump`, after the competitive
    adjustment and the 400-cap rule — i.e. the number `OPENER_THRESHOLD` is
    compared against.

    Named trump rather than searched, because by the time a row exists the trump
    is already decided: on a bid row it is `best_base_bid`'s pick recorded in the
    `trump` column, and on a fold row it is the suit that was actually declared.
    Re-searching would value a contract nobody is playing.
    """
    total, _breakdown = compute_max_bid(hand, trump, our_score, their_score)
    return capped_bid(hand, trump, total)


def meld_total(hand, trump):
    """`score_melds` of `hand` in `trump`, recomputed rather than read.

    The dataset stores a `meld_total` column, and until #273 reading it was the
    same thing as computing it. #273 corrected the scorer - a Run absorbs the
    Royal Marriage it contains - so every stored value on a row whose hand holds
    a run is 40 too high, while `evaluator.ts` computes the corrected number
    live from the same 12 cards. A model fitted on one definition and applied to
    the other is precisely the silent failure `evaluatorParity.test.ts` exists to
    catch, so this recomputes, the same way and for the same reason
    `base_bid_ceiling` does.

    Regenerating the dataset would fix it at the source and is the better answer;
    that is #226, it is deferred, and the labels have other reasons to be stale
    (see #225). This keeps the fitted features and the live features the same
    quantity in the meantime, which is the part that cannot wait.
    """
    total, _breakdown = score_melds(hand, trump)
    return float(total)


def _number(text):
    """CSV cell -> float, or None for a blank. Blank means "not measured here"
    and must never silently become 0.0 — `ev_fold` of zero is a real value."""
    return None if text == "" else float(text)


def read_dataset(path=DEFAULT_DATASET_PATH):
    """The CSV as dicts with numeric cells parsed and blanks kept as None."""
    with open(path, newline="", encoding="utf-8") as handle:
        rows = []
        for raw in csv.DictReader(handle):
            row = dict(raw)
            for key, value in raw.items():
                if key not in ("decision_point", "trump", "hand"):
                    row[key] = _number(value)
            rows.append(row)
    return rows


def bid_rows(rows):
    return [r for r in rows if r["decision_point"] == BID_DECISION]


def fold_rows(rows):
    return [r for r in rows if r["decision_point"] == FOLD_DECISION]


def bid_features(row):
    """`BID_FEATURES` for one bid row, ceiling included.

    The ceiling is computed at the row's live scores because the bid label is:
    `label_bid_situation` picks trump with `best_base_bid(hand, our_score,
    their_score)`, so the score is already inside the label through the trump
    it selected.
    """
    hand = decode_hand(row["hand"])
    ceiling = base_bid_ceiling(
        hand, Suit(row["trump"]), int(row["our_score"]), int(row["their_score"]),
    )
    features = {name: row[name] for name in BID_FEATURES
                if name not in ("base_bid_ceiling", "ceiling_minus_bid",
                                "meld_total")}
    features["meld_total"] = meld_total(hand, Suit(row["trump"]))
    features["base_bid_ceiling"] = float(ceiling)
    features["ceiling_minus_bid"] = float(ceiling) - row["bid"]
    return features


def fold_features(row):
    """
    `FOLD_FEATURES` for one fold row.

    Scores are passed as 0/0 on purpose. The fold label was measured with the
    scores withheld, so a ceiling carrying a competitive adjustment would be the
    one place a score could leak back into a model of a score-independent
    quantity. (It happens to make no difference to five-fold agreement on this
    dataset — the adjustment is small next to the cap — but "happens not to
    matter here" is not a reason to ship the coupling.)
    """
    hand = decode_hand(row["hand"])
    ceiling = float(base_bid_ceiling(hand, Suit(row["trump"])))
    features = {name: row[name] for name in FOLD_FEATURES
                if name not in ("base_bid_ceiling", "ceiling_minus_bid",
                                "tricks_needed", "fold_cost", "meld_total")}
    features["meld_total"] = meld_total(hand, Suit(row["trump"]))
    features["base_bid_ceiling"] = ceiling
    features["ceiling_minus_bid"] = ceiling - row["bid"]
    features["tricks_needed"] = row["bid"] - row["bidding_meld"]
    features["fold_cost"] = row["bid"] + row["defending_meld"]
    return features


# The two decision problems, as one table, so evaluation and export can loop
# over them instead of hard-coding "bid" and "fold" in six places.
PROBLEMS = {
    BID_DECISION: {
        "rows": bid_rows,
        "features": BID_FEATURES,
        "extract": bid_features,
        "label": "verdict_bid",
        "l2": BID_L2,
        "decision": "1 = bid (taking the contract beats defending it)",
    },
    FOLD_DECISION: {
        "rows": fold_rows,
        "features": FOLD_FEATURES,
        "extract": fold_features,
        "label": "verdict_fold",
        "l2": FOLD_L2,
        "decision": "1 = concede (playing the contract out is worse than folding)",
    },
}


def design_matrix(rows, problem):
    """(X, y) for one problem: X in `problem["features"]` order, y the verdict."""
    extract, names = problem["extract"], problem["features"]
    X = [[float(extract(row)[name]) for name in names] for row in rows]
    y = [int(row[problem["label"]]) for row in rows]
    return X, y


# ---------------------------------------------------------------------------
# Logistic regression — pure Python, IRLS.
#
# IRLS rather than gradient descent because it converges in under ten iterations
# on a problem this small and needs no learning rate to tune. With 14 features
# the Newton system is a 15x15 solve, which is nothing; the cost is entirely the
# O(n*d^2) Hessian, and a full fit on 1655 rows takes a couple of seconds.
#
# Fitting happens on standardised columns (an unscaled `meld_total` of 510 next
# to a 0/1 flag makes the Hessian badly conditioned), but the exported weights
# are folded back into RAW feature units. #114 should not have to ship a mean
# and a standard deviation alongside the model to use it.
# ---------------------------------------------------------------------------

MAX_IRLS_ITERATIONS = 40
IRLS_TOLERANCE = 1e-9


def _solve(matrix, vector):
    """Gaussian elimination with partial pivoting. Raises on a singular system
    rather than returning a plausible-looking wrong answer."""
    size = len(vector)
    augmented = [list(row) + [vector[i]] for i, row in enumerate(matrix)]
    for col in range(size):
        pivot = max(range(col, size), key=lambda r: abs(augmented[r][col]))
        if abs(augmented[pivot][col]) < 1e-12:
            raise ValueError("singular system in logistic fit")
        augmented[col], augmented[pivot] = augmented[pivot], augmented[col]
        pivot_row = augmented[col]
        for row_index in range(col + 1, size):
            row = augmented[row_index]
            factor = row[col] / pivot_row[col]
            if factor:
                for k in range(col, size + 1):
                    row[k] -= factor * pivot_row[k]
    solution = [0.0] * size
    for col in reversed(range(size)):
        row = augmented[col]
        total = row[size] - sum(row[k] * solution[k] for k in range(col + 1, size))
        solution[col] = total / row[col]
    return solution


def _column_stats(X):
    """Per-column mean and standard deviation, with zero-variance columns given
    a scale of 1 so a constant feature cannot divide by zero."""
    n, d = len(X), len(X[0])
    means = [sum(row[j] for row in X) / n for j in range(d)]
    scales = []
    for j in range(d):
        variance = sum((row[j] - means[j]) ** 2 for row in X) / n
        scales.append(math.sqrt(variance) if variance > 1e-12 else 1.0)
    return means, scales


def _sigmoid(z):
    return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, z))))


class LogisticModel:
    """
    A fitted linear-in-log-odds classifier in raw feature units.

    `weights` and `intercept` are what #114 exports: the decision is
    `sum(w[i] * x[i]) + intercept >= 0`, with no scaling step in between, which
    is the whole reason the standardisation is unwound at the end of `fit`.
    `threshold` is carried explicitly rather than assumed to be 0.5 so a later
    issue can trade false bids against false passes without refitting.
    """

    def __init__(self, features, weights, intercept, threshold=0.5, decision=""):
        self.features = list(features)
        self.weights = list(weights)
        self.intercept = intercept
        self.threshold = threshold
        self.decision = decision

    def logit(self, features):
        return self.intercept + sum(
            weight * features[name] for name, weight in zip(self.features, self.weights)
        )

    def probability(self, features):
        return _sigmoid(self.logit(features))

    def decide(self, features):
        """The model's decision, as a 0/1 matching the dataset's verdict column."""
        return int(self.probability(features) >= self.threshold)

    def to_dict(self):
        return {
            "kind": "logistic",
            "decision": self.decision,
            "threshold": self.threshold,
            "intercept": self.intercept,
            "features": self.features,
            "weights": self.weights,
        }

    @classmethod
    def from_dict(cls, payload):
        if payload.get("kind") != "logistic":
            raise ValueError(f"unsupported model kind {payload.get('kind')!r}")
        return cls(payload["features"], payload["weights"], payload["intercept"],
                   payload.get("threshold", 0.5), payload.get("decision", ""))


def fit_logistic(X, y, feature_names, l2=0.01, decision=""):
    """
    Ridge-penalised logistic regression by IRLS, returned in raw feature units.

    The penalty is on the weights only, never the intercept: penalising the
    intercept would pull the model's base rate towards 50% on a problem whose
    base rate is 17% (fold rows), which is not a prior anyone holds.
    """
    n, d = len(X), len(feature_names)
    means, scales = _column_stats(X)
    Z = [[(row[j] - means[j]) / scales[j] for j in range(d)] + [1.0] for row in X]

    beta = [0.0] * (d + 1)
    for _iteration in range(MAX_IRLS_ITERATIONS):
        probabilities = [_sigmoid(sum(b * z for b, z in zip(beta, row))) for row in Z]
        gradient = [
            sum((probabilities[i] - y[i]) * Z[i][j] for i in range(n)) / n
            + (l2 * beta[j] if j < d else 0.0)
            for j in range(d + 1)
        ]
        weights_irls = [max(p * (1.0 - p), 1e-6) for p in probabilities]
        hessian = [[0.0] * (d + 1) for _ in range(d + 1)]
        for i in range(n):
            row, w = Z[i], weights_irls[i]
            for j in range(d + 1):
                wz = w * row[j]
                if wz:
                    hessian_row = hessian[j]
                    for k in range(j, d + 1):
                        hessian_row[k] += wz * row[k]
        for j in range(d + 1):
            for k in range(j, d + 1):
                hessian[j][k] /= n
                hessian[k][j] = hessian[j][k]
            if j < d:
                hessian[j][j] += l2

        step = _solve(hessian, gradient)
        beta = [b - s for b, s in zip(beta, step)]
        if max(abs(s) for s in step) < IRLS_TOLERANCE:
            break

    # Unwind the standardisation so the exported model reads raw features.
    weights = [beta[j] / scales[j] for j in range(d)]
    intercept = beta[d] - sum(weights[j] * means[j] for j in range(d))
    return LogisticModel(feature_names, weights, intercept, decision=decision)


# ---------------------------------------------------------------------------
# Splits — grouped by capture order, not shuffled.
#
# `collect_situations` appends rows in play order, so a contiguous block is a
# contiguous run of games. That matters: one deal produces up to four bid rows
# and a fold row that share a shuffle, and a shuffled split would scatter those
# across the boundary and quietly inflate every number below. A tail split can
# straddle at most one round.
# ---------------------------------------------------------------------------

HOLDOUT_FRACTION = 0.25
DEFAULT_FOLDS = 5


def tail_split(rows, holdout=HOLDOUT_FRACTION):
    """(train, test) — the last `holdout` of the rows, in capture order."""
    cut = int(len(rows) * (1.0 - holdout))
    return rows[:cut], rows[cut:]


def contiguous_folds(count, folds=DEFAULT_FOLDS):
    """Yields (train_indices, test_indices) for `folds` contiguous blocks."""
    for index in range(folds):
        low, high = count * index // folds, count * (index + 1) // folds
        test = list(range(low, high))
        train = [i for i in range(count) if i < low or i >= high]
        yield train, test


# ---------------------------------------------------------------------------
# Evaluation — decisions, not p_make.
#
# The acceptance criterion for #113 is decision agreement: matching `p_make` to
# three decimals is worthless if the comparison it feeds flips. Everything here
# is measured against the verdict columns for that reason.
# ---------------------------------------------------------------------------

def decision_agreement(model, rows, problem):
    """Fraction of `rows` where the model reaches the rollout's decision."""
    X, y = design_matrix(rows, problem)
    names = problem["features"]
    agreed = sum(
        1 for row, target in zip(X, y)
        if model.decide(dict(zip(names, row))) == target
    )
    return agreed / len(rows)


def majority_rate(rows, problem):
    """What "always answer with the commoner verdict" scores — the floor any
    fitted model has to clear before it has said anything at all."""
    labels = [int(row[problem["label"]]) for row in rows]
    positive = sum(labels) / len(labels)
    return max(positive, 1.0 - positive)


def cross_validated_agreement(rows, problem, folds=DEFAULT_FOLDS, l2=None):
    """
    Mean and spread of decision agreement over contiguous folds.

    The spread is reported everywhere alongside the mean because the whole
    "simple is enough" argument in this module's docstring is an argument about
    a gap being smaller than the fold-to-fold noise, and a mean on its own
    cannot support or refute that.
    """
    l2 = problem["l2"] if l2 is None else l2
    X, y = design_matrix(rows, problem)
    names = problem["features"]
    scores = []
    for train, test in contiguous_folds(len(rows), folds):
        model = fit_logistic([X[i] for i in train], [y[i] for i in train], names, l2=l2)
        agreed = sum(1 for i in test if model.decide(dict(zip(names, X[i]))) == y[i])
        scores.append(agreed / len(test))
    mean = sum(scores) / len(scores)
    spread = math.sqrt(sum((s - mean) ** 2 for s in scores) / len(scores))
    return mean, spread, scores


# ---------------------------------------------------------------------------
# Where it disagrees — the part #114 and #115 actually need.
#
# "78% agreement" and "86% agreement" are the same sentence to a reader who does
# not know whether the missing rows are a hand class the model gets wrong every
# time or a scatter around a boundary the rollout itself cannot resolve. These
# are two different problems: the first is a modelling failure, the second is
# label noise that no model can fix and that costs almost nothing at the table,
# because a row where the two EVs are a coin flip apart is a row where either
# decision is worth about the same.
# ---------------------------------------------------------------------------

# Boundaries in points of score differential. `ev_take` and `ev_defend` are each
# a mean over 150 sampled rounds swinging hundreds of points, so their difference
# carries a standard error in the tens: a margin under ~50 is inside the label's
# own noise, and a margin over 200 is not.
MARGIN_EDGES = [0, 25, 50, 100, 200, 400, float("inf")]


def label_margin(row):
    """
    |EV(take) - EV(defend)| on a bid row, |EV(play on) - EV(fold)| on a fold row:
    how decisively the rollout preferred what it preferred.

    This is the axis a disagreement has to be read against. The verdict columns
    are a sign, and a sign computed from a sampled difference of 3 points is not
    the same claim as one computed from a difference of 300.
    """
    if row["decision_point"] == BID_DECISION:
        return abs(row["ev_take"] - row["ev_defend"])
    return abs(row["ev_play_on"] - row["ev_fold"])


def mean_regret(model, rows, problem):
    """
    Mean EV given up per decision by following the model instead of the rollout,
    in points of score differential.

    Agreement counts every disagreement equally; this does not. A row where the
    two futures are 4 points apart costs 4 points to get "wrong", and a
    disagreement rate that lives entirely on such rows is worth almost nothing
    at the table. This is the number that makes "the disagreements are near the
    boundary" a claim about consequences rather than about a histogram, and it
    is the number #115 should expect to see reflected in win rate.
    """
    names, extract = problem["features"], problem["extract"]
    total = 0.0
    for row in rows:
        predicted = model.decide({n: float(extract(row)[n]) for n in names})
        if predicted != int(row[problem["label"]]):
            total += label_margin(row)
    return total / len(rows)


def shipped_rule_regret(rows):
    """`mean_regret` for the rule that ships today, so the model's number has
    something on the same scale to be compared against."""
    total = 0.0
    for row in rows:
        ceiling = bid_features(row)["base_bid_ceiling"]
        if int(ceiling >= OPENER_THRESHOLD) != int(row["verdict_bid"]):
            total += label_margin(row)
    return total / len(rows)


def _buckets(rows, key, edges):
    grouped = {}
    for row in rows:
        value = key(row)
        for low, high in zip(edges, edges[1:]):
            if low <= value < high:
                grouped.setdefault((low, high), []).append(row)
                break
    return grouped


def disagreement_by(model, rows, problem, key, edges):
    """Disagreement rate per bucket of `key`, as (bucket, n, rate) tuples."""
    names = problem["features"]
    extract = problem["extract"]
    report = []
    for bucket, members in sorted(_buckets(rows, key, edges).items()):
        wrong = sum(
            1 for row in members
            if model.decide({n: float(extract(row)[n]) for n in names})
            != int(row[problem["label"]])
        )
        report.append((bucket, len(members), wrong / len(members)))
    return report


def disagreement_direction(model, rows, problem):
    """
    Splits the disagreements into the two ways they can go.

    For bid rows: `false_positive` is the model bidding a contract the rollout
    would have passed, `false_negative` is the reverse. They are not
    interchangeable at the table - one loses points to sets, the other loses
    contracts to the opponents - so #114 needs the split, not the total.
    """
    names, extract = problem["features"], problem["extract"]
    counts = {"false_positive": 0, "false_negative": 0, "agreed": 0}
    for row in rows:
        predicted = model.decide({n: float(extract(row)[n]) for n in names})
        target = int(row[problem["label"]])
        if predicted == target:
            counts["agreed"] += 1
        elif predicted == 1:
            counts["false_positive"] += 1
        else:
            counts["false_negative"] += 1
    return counts


# ---------------------------------------------------------------------------
# Baselines — what "good enough" is measured against.
#
# The bar is not 50%. #114 replaces a rule that already exists, so the honest
# comparison is against what ships today (`ceiling >= OPENER_THRESHOLD`) and
# against the cheapest possible improvement on it (the same rule with the
# constant refitted). A model that cannot beat a retuned constant does not
# justify the export format, the wiring, or the maintenance.
# ---------------------------------------------------------------------------

def shipped_rule_agreement(rows):
    """How often `bidding.ts`'s live rule agrees with the rollout on bid rows."""
    agreed = 0
    for row in rows:
        ceiling = bid_features(row)["base_bid_ceiling"]
        agreed += int(int(ceiling >= OPENER_THRESHOLD) == int(row["verdict_bid"]))
    return agreed / len(rows)


THRESHOLD_SEARCH = range(120, 525, 5)  # the observed ceiling range, in bid-level steps


def tuned_threshold_agreement(train, test):
    """
    Fit the single constant `OPENER_THRESHOLD` on `train`, score it on `test`.

    The steel-man for doing nothing. If a whole weight vector only matches this,
    #114's correct move is a one-line constant change and not an exported model.
    """
    train_ceilings = [(bid_features(r)["base_bid_ceiling"], int(r["verdict_bid"]))
                      for r in train]
    best = max(
        THRESHOLD_SEARCH,
        key=lambda t: sum(1 for c, v in train_ceilings if int(c >= t) == v),
    )
    test_ceilings = [(bid_features(r)["base_bid_ceiling"], int(r["verdict_bid"]))
                     for r in test]
    agreed = sum(1 for c, v in test_ceilings if int(c >= best) == v)
    return best, agreed / len(test)


# ---------------------------------------------------------------------------
# The fitted artefact.
#
# JSON, not a pickle: #114 has to read this from TypeScript, and a format only
# Python can open would make the export step a rewrite instead of a read. Every
# number a consumer needs is in the file, including the configuration the labels
# describe - a model fitted against a flag that has since flipped is worse than
# no model, and the file should be able to say so about itself.
# ---------------------------------------------------------------------------

MODEL_FORMAT_VERSION = 1


def fit_evaluator(rows, holdout=HOLDOUT_FRACTION, folds=DEFAULT_FOLDS):
    """
    Fit both models on the training split and measure them on the held-out one.

    Returns (models, metrics). Models are fitted on the TRAINING rows only, so
    the reported agreement describes rows the fit never saw. `refit_on_all`
    below is what produces the shipped weights, once the held-out numbers have
    been read and accepted.
    """
    models, metrics = {}, {}
    for name, problem in PROBLEMS.items():
        subset = problem["rows"](rows)
        train, test = tail_split(subset, holdout)
        model = fit_logistic(*design_matrix(train, problem)[:2],
                             feature_names=problem["features"], l2=problem["l2"],
                             decision=problem["decision"])
        mean, spread, scores = cross_validated_agreement(subset, problem, folds)
        models[name] = model
        metrics[name] = {
            "rows": len(subset),
            "train_rows": len(train),
            "test_rows": len(test),
            "train_agreement": decision_agreement(model, train, problem),
            "holdout_agreement": decision_agreement(model, test, problem),
            "holdout_majority_baseline": majority_rate(test, problem),
            "cross_validated_agreement": mean,
            "cross_validated_spread": spread,
            "cross_validated_folds": scores,
            "holdout_disagreement_direction": disagreement_direction(model, test, problem),
            "holdout_mean_regret": mean_regret(model, test, problem),
        }
    return models, metrics


def refit_on_all(rows):
    """
    The shipped weights: both models refitted on every row.

    Held-out agreement is an estimate of how a model fitted this way behaves,
    not a property of a particular 75% of the data - so once that estimate is in
    hand there is no reason to ship a model that ignores a quarter of the
    measurements. The metrics in the artefact still come from the split fit.
    """
    return {
        name: fit_logistic(*design_matrix(problem["rows"](rows), problem)[:2],
                           feature_names=problem["features"], l2=problem["l2"],
                           decision=problem["decision"])
        for name, problem in PROBLEMS.items()
    }


def build_artefact(rows, dataset_path=DEFAULT_DATASET_PATH,
                   holdout=HOLDOUT_FRACTION, folds=DEFAULT_FOLDS):
    """The full JSON payload: models, how they were measured, and against what."""
    _split_models, metrics = fit_evaluator(rows, holdout, folds)
    shipped = refit_on_all(rows)
    return {
        "format_version": MODEL_FORMAT_VERSION,
        "issue": "113",
        "generated_by": "fit_evaluator.py",
        "dataset": dataset_path,
        "dataset_rows": len(rows),
        "labelled_configuration": describe_live_configuration(),
        "holdout_fraction": holdout,
        "split": "contiguous tail in capture order (a run of whole games)",
        "models": {name: model.to_dict() for name, model in shipped.items()},
        "metrics": metrics,
    }


def write_artefact(artefact, path=DEFAULT_MODEL_PATH):
    """Pretty-printed and key-sorted, so a refit produces a readable diff rather
    than one reordered line."""
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(artefact, handle, indent=2, sort_keys=True)
        handle.write("\n")


def load_models(path=DEFAULT_MODEL_PATH):
    """The committed models, keyed by decision point. The reader #114 needs."""
    with open(path, encoding="utf-8") as handle:
        artefact = json.load(handle)
    return {name: LogisticModel.from_dict(payload)
            for name, payload in artefact["models"].items()}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _format_metrics(name, metrics):
    m = metrics[name]
    direction = m["holdout_disagreement_direction"]
    return "\n".join([
        f"{name} rows: {m['rows']} ({m['train_rows']} train / {m['test_rows']} held out)",
        f"  held-out decision agreement   {m['holdout_agreement']:.3f}",
        f"  majority-verdict baseline     {m['holdout_majority_baseline']:.3f}",
        f"  training agreement            {m['train_agreement']:.3f}",
        f"  5-fold agreement              {m['cross_validated_agreement']:.3f} "
        f"+-{m['cross_validated_spread']:.3f}",
        f"  held-out disagreements        {direction['false_positive']} false-positive, "
        f"{direction['false_negative']} false-negative",
        f"  held-out mean regret          {m['holdout_mean_regret']:.1f} points/decision",
    ])


def _print_comparison(rows):
    """The baselines the "logistic is enough" claim rests on."""
    problem = PROBLEMS[BID_DECISION]
    subset = problem["rows"](rows)
    train, test = tail_split(subset)
    threshold, tuned = tuned_threshold_agreement(train, test)

    without = [f for f in BID_FEATURES if f not in ("base_bid_ceiling", "ceiling_minus_bid")]
    reduced = dict(problem, features=without)
    reduced_mean, reduced_spread, _ = cross_validated_agreement(subset, reduced)
    full_mean, full_spread, _ = cross_validated_agreement(subset, problem)

    print("\nBid decision, alternatives (5-fold unless noted):")
    print(f"  always pass (majority verdict)          {majority_rate(subset, problem):.3f}")
    print(f"  shipped rule, ceiling >= {OPENER_THRESHOLD}           "
          f"{shipped_rule_agreement(subset):.3f}")
    print(f"  same rule, constant refit to {threshold} (held out)  {tuned:.3f}")
    print(f"  logistic without the ceiling feature    {reduced_mean:.3f} +-{reduced_spread:.3f}")
    print(f"  logistic as shipped                     {full_mean:.3f} +-{full_spread:.3f}")

    fitted = fit_logistic(*design_matrix(train, problem)[:2],
                          feature_names=problem["features"], l2=problem["l2"])
    print("\nMean EV given up per held-out bid decision (points of differential):")
    print(f"  shipped rule, ceiling >= {OPENER_THRESHOLD}           "
          f"{shipped_rule_regret(test):.1f}")
    print(f"  logistic as shipped                     {mean_regret(fitted, test, problem):.1f}")


def _print_disagreements(rows, models):
    for name, problem in PROBLEMS.items():
        subset = problem["rows"](rows)
        _train, test = tail_split(subset)
        model = models[name]
        print(f"\n{name} disagreements on the held-out split, "
              f"by |EV difference| the rollout measured:")
        for (low, high), count, rate in disagreement_by(
                model, test, problem, label_margin, MARGIN_EDGES):
            label = f"[{low:>5.0f}, {high:>5.0f})" if high != float("inf") else f"[{low:>5.0f},   inf)"
            print(f"  margin {label}  n={count:<5d} disagree {rate:.3f}")
        print(f"  {'bid level' if name == BID_DECISION else 'contract level'}:")
        for (low, high), count, rate in disagreement_by(
                model, test, problem, lambda r: r["bid"], [250, 300, 310, 320, 340, 1000]):
            print(f"  bid [{low:>4.0f}, {high:>4.0f})       n={count:<5d} disagree {rate:.3f}")
        print("  guaranteed meld:")
        for (low, high), count, rate in disagreement_by(
                model, test, problem, lambda r: r["meld_total"], [0, 60, 120, 200, 1000]):
            print(f"  meld [{low:>4.0f}, {high:>4.0f})      n={count:<5d} disagree {rate:.3f}")


def main():
    parser = argparse.ArgumentParser(
        description="Fit and evaluate a cheap evaluator on the rollout data (#113, epic #104)",
    )
    parser.add_argument("--dataset", default=DEFAULT_DATASET_PATH)
    parser.add_argument("--out", default=DEFAULT_MODEL_PATH)
    parser.add_argument("--holdout", type=float, default=HOLDOUT_FRACTION)
    parser.add_argument("--folds", type=int, default=DEFAULT_FOLDS)
    parser.add_argument("--compare", action="store_true",
                        help="also print the baselines the model has to beat to be worth shipping")
    parser.add_argument("--disagreements", action="store_true",
                        help="also print where the model and the rollout part company")
    parser.add_argument("--no-write", action="store_true", help="evaluate without writing the model")
    args = parser.parse_args()

    rows = read_dataset(args.dataset)
    print(describe_live_configuration())
    print(f"\n{len(rows)} rows from {args.dataset}\n")

    split_models, metrics = fit_evaluator(rows, args.holdout, args.folds)
    for name in PROBLEMS:
        print(_format_metrics(name, metrics))
        print()

    if args.compare:
        _print_comparison(rows)
    if args.disagreements:
        _print_disagreements(rows, split_models)

    if not args.no_write:
        artefact = build_artefact(rows, args.dataset, args.holdout, args.folds)
        write_artefact(artefact, args.out)
        print(f"\nmodel -> {args.out}")


if __name__ == "__main__":
    main()

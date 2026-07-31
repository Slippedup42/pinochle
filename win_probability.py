"""
P(win the game | score state) - the objective the rollout AI maximizes
(issue #102, epic #106).

Every EV in `pinochle_rollout.py` up to now has been denominated in *points*:
`bid_ev` in our own points, `defend_ev` / `bid_ev_differential` / `fold_ev` in
score differential. Points are a proxy. What a player actually wants is to
reach 1000 before the other side does, and the two come apart exactly where it
matters most - at 890-950 a cautious pass is losing, because you cannot win by
defending; at 200-180 the identical hand should play safe. A points objective
cannot tell those apart, and the score is not even an input to it.

This module supplies the missing conversion: a game state -> a probability.
Once the objective is win probability, score-awareness stops being a special
case anybody hand-codes.

Why a lookup table and not a model
----------------------------------
The issue asks for the cheapest thing that works: "a coarse lookup table is a
fine first version; it does not need to be a model." It is also the *honest*
first version - the table is measured from self-play rather than asserted, so
its errors are sampling error rather than modelling assumptions nobody checked.

The table is 100-point buckets on each side's score, 20 x 20 = 400 cells over
[-1000, 1000). It is consulted thousands of times per bid decision (once per
rollout sample), so runtime has to be a list index, not a simulation.

Three things keep it well-behaved where the data is thin:

  Mirroring. Every observed round contributes twice - once as (ours, theirs)
  and once as (theirs, ours) with the outcome flipped. That doubles the data
  and makes `P(a, b) == 1 - P(b, a)` hold by construction rather than
  approximately, which matters because the two sides of a bid-vs-defend
  comparison read cells on opposite sides of the diagonal.

  A smooth prior. Games walk up the diagonal from 0-0, so cells like
  (-900, -900) are never visited and cells far off-diagonal are visited
  rarely. Unvisited cells fall back to `prior_win_probability` below - a
  race model, not a guess: a lead is worth more when fewer rounds remain,
  because there is less variance left to overturn it.

  Shrinkage. A cell seen 3 times is not evidence; it is noise that would show
  up as a non-monotonic dent in the table. Each cell is blended toward the
  prior with weight `SHRINK_STRENGTH / (n + SHRINK_STRENGTH)`, so a
  well-observed cell is essentially its own empirical rate and a barely-seen
  one is essentially the prior.

What the measured table turned out to say
----------------------------------------
Worth recording, because it is not what the prior predicts and it explains a
lot about how much this objective can be worth. The table is nearly *flat in
game stage*: a 100-point lead is worth about 0.55-0.58 whether the score is
100-0 or 700-600, and a 300-point lead about 0.64-0.71 across the same span.
The race model expects a lead to be worth steadily more as the finish
approaches; self-play says it barely is.

The reason is the size of a Pinochle round. A scoring round is worth ~259
points on average with a ~406-point spread between the teams, so even at
700-600 there is more than a full round of variance still to come and a
100-point lead is nearly noise. Leads only become decisive once a side can
actually cross 1000 - which is the terminal case below, resolved exactly.

So the practical leverage of a win-probability objective lives in the last
round or two, not spread across the score range. That is a real result about
the game, not a defect in the table.

Terminal states are NOT looked up. `win_probability` resolves them exactly,
mirroring `Game.play`'s own end-of-game rules (bust at -1000 checked before
the 1000 target; the bidding team wins a round that carries both sides over).
An estimate there would be strictly worse than the arithmetic, and the endgame
is the whole reason this objective exists.

Regenerating the table
----------------------
    python win_probability.py --games 6000 --seed 7

prints the constants below, ready to paste. Do that after any change that
moves how rounds score, and record the run's parameters in the constant's
comment - a table generated from an AI nobody can identify later is a number
with no provenance.
"""

import argparse
import math
import random
from collections import defaultdict

from pinochle_engine import GAME_LOSE_SCORE, GAME_WIN_SCORE, Game, Player


# ---------------------------------------------------------------------------
# Bucketing - the table's resolution.
# ---------------------------------------------------------------------------

BUCKET_SIZE = 100          # points per bucket; 100 keeps 890 and 950 in different rows
BUCKET_MIN = GAME_LOSE_SCORE   # -1000, the bust floor
BUCKET_COUNT = (GAME_WIN_SCORE - GAME_LOSE_SCORE) // BUCKET_SIZE  # 20


def score_bucket(score):
    """
    Which row/column of the table a score falls in. Scores outside
    [-1000, 1000) are clamped rather than rejected: a caller that hands us an
    already-terminal score is asking the wrong question, but clamping keeps
    the lookup total and the exact answer comes from `win_probability`'s
    terminal check anyway.
    """
    index = int((score - BUCKET_MIN) // BUCKET_SIZE)
    return max(0, min(BUCKET_COUNT - 1, index))


def bucket_midpoint(index):
    """Representative score for a bucket, used when the prior needs a number
    rather than a range."""
    return BUCKET_MIN + index * BUCKET_SIZE + BUCKET_SIZE // 2


# ---------------------------------------------------------------------------
# The prior - a race model, used for unobserved cells and as the shrinkage
# target. Both constants are MEASURED by the generator below, not chosen.
# ---------------------------------------------------------------------------

# How fast the race runs. `TYPICAL_ROUND_GAIN` is the mean score a team takes
# in a round it scores at all (set rounds subtract rather than advance, so
# averaging them in would understate how quickly 1000 arrives);
# `TYPICAL_ROUND_SPREAD` is the standard deviation of the per-round score
# differential between the two teams. Both MEASURED over 6000 self-play games
# (Proficient vs Proficient, seed 7) by `generate_table`, not chosen - see the
# module docstring for how to regenerate.
TYPICAL_ROUND_GAIN = 258.6
TYPICAL_ROUND_SPREAD = 405.8

# How many observations a cell needs before it mostly speaks for itself.
# 40 is roughly "one cell's worth of a few hundred games" - large enough that
# a 3-observation cell cannot dent the table, small enough that the
# heavily-travelled cells near the diagonal are dominated by their own data.
SHRINK_STRENGTH = 40


def _normal_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def prior_win_probability(our_score, their_score,
                          round_gain=TYPICAL_ROUND_GAIN,
                          round_spread=TYPICAL_ROUND_SPREAD):
    """
    P(win) under a simple race model: both sides are climbing toward 1000, the
    per-round differential is noise with standard deviation `round_spread`,
    and roughly `min(distance to go) / round_gain` rounds remain for that
    noise to accumulate in.

    The point of the model is not its precision, it is its *shape*: the same
    60-point lead is nearly meaningless at 200-140 (many rounds left, plenty
    of variance to come) and close to decisive at 950-890 (one round left, one
    round of variance). That is the behaviour the issue is asking the AI to
    learn, and it is what makes this a usable fallback for cells self-play
    never visits.

    Symmetric by construction: `prior(a, b) == 1 - prior(b, a)`, because the
    remaining-rounds term depends only on the *smaller* distance to go.
    """
    ours_to_go = max(GAME_WIN_SCORE - our_score, 1.0)
    theirs_to_go = max(GAME_WIN_SCORE - their_score, 1.0)
    rounds_left = max(min(ours_to_go, theirs_to_go) / round_gain, 0.5)
    sigma = round_spread * math.sqrt(rounds_left)
    return _normal_cdf((our_score - their_score) / sigma)


# ---------------------------------------------------------------------------
# The measured table. Rows are OUR score bucket, columns THEIRS, both from
# -1000 (index 0) to +900 (index 19) in 100-point steps. Value is P(we win).
#
# Generated by `python win_probability.py --games 6000 --seed 7` against
# Proficient (`Player`) self-play - the AI the epic measures its changes
# against. 30,210 round-states (60,420 after mirroring) filling 356 of the 400
# cells; the 44 empty ones are deep in the both-sides-badly-negative corner
# that real play never reaches, and fall back to `prior_win_probability`.
# Every cell is shrunk toward that prior as described in the module docstring.
# ---------------------------------------------------------------------------

WIN_PROBABILITY_TABLE = [
    [0.500, 0.463, 0.425, 0.385, 0.344, 0.301, 0.259, 0.216, 0.175, 0.136, 0.097, 0.090, 0.060, 0.034, 0.033, 0.002, 0.019, 0.000, 0.000, 0.000],
    [0.537, 0.500, 0.462, 0.423, 0.381, 0.339, 0.295, 0.251, 0.202, 0.160, 0.129, 0.091, 0.048, 0.065, 0.037, 0.004, 0.001, 0.000, 0.000, 0.000],
    [0.575, 0.538, 0.500, 0.461, 0.420, 0.377, 0.325, 0.274, 0.220, 0.206, 0.157, 0.137, 0.094, 0.032, 0.050, 0.038, 0.001, 0.018, 0.016, 0.000],
    [0.615, 0.577, 0.539, 0.500, 0.460, 0.418, 0.364, 0.304, 0.287, 0.262, 0.199, 0.172, 0.173, 0.104, 0.095, 0.045, 0.035, 0.000, 0.017, 0.000],
    [0.656, 0.619, 0.580, 0.540, 0.500, 0.461, 0.395, 0.380, 0.316, 0.384, 0.224, 0.175, 0.166, 0.111, 0.053, 0.079, 0.064, 0.041, 0.034, 0.011],
    [0.699, 0.661, 0.623, 0.582, 0.539, 0.500, 0.467, 0.417, 0.379, 0.368, 0.252, 0.233, 0.194, 0.141, 0.102, 0.056, 0.026, 0.065, 0.010, 0.000],
    [0.741, 0.705, 0.675, 0.636, 0.605, 0.533, 0.500, 0.466, 0.379, 0.401, 0.346, 0.298, 0.262, 0.145, 0.157, 0.122, 0.093, 0.035, 0.012, 0.000],
    [0.784, 0.749, 0.726, 0.696, 0.620, 0.583, 0.534, 0.500, 0.471, 0.364, 0.344, 0.267, 0.244, 0.167, 0.153, 0.150, 0.148, 0.044, 0.048, 0.019],
    [0.825, 0.798, 0.780, 0.713, 0.684, 0.621, 0.621, 0.529, 0.500, 0.439, 0.392, 0.403, 0.366, 0.274, 0.207, 0.156, 0.149, 0.084, 0.064, 0.005],
    [0.864, 0.840, 0.794, 0.738, 0.616, 0.632, 0.599, 0.636, 0.561, 0.500, 0.467, 0.343, 0.355, 0.296, 0.195, 0.175, 0.201, 0.087, 0.071, 0.021],
    [0.903, 0.871, 0.843, 0.801, 0.776, 0.748, 0.654, 0.656, 0.608, 0.533, 0.500, 0.424, 0.391, 0.364, 0.286, 0.250, 0.216, 0.129, 0.061, 0.046],
    [0.910, 0.909, 0.863, 0.828, 0.825, 0.767, 0.702, 0.733, 0.597, 0.657, 0.576, 0.500, 0.453, 0.406, 0.342, 0.294, 0.245, 0.178, 0.137, 0.041],
    [0.940, 0.952, 0.906, 0.827, 0.834, 0.806, 0.738, 0.756, 0.634, 0.645, 0.609, 0.547, 0.500, 0.466, 0.378, 0.286, 0.232, 0.215, 0.113, 0.051],
    [0.966, 0.935, 0.968, 0.896, 0.889, 0.859, 0.855, 0.833, 0.726, 0.704, 0.636, 0.594, 0.534, 0.500, 0.399, 0.382, 0.295, 0.233, 0.226, 0.099],
    [0.967, 0.963, 0.950, 0.905, 0.947, 0.898, 0.843, 0.847, 0.793, 0.805, 0.714, 0.658, 0.622, 0.601, 0.500, 0.422, 0.371, 0.314, 0.190, 0.121],
    [0.998, 0.996, 0.962, 0.955, 0.921, 0.944, 0.878, 0.850, 0.844, 0.825, 0.750, 0.706, 0.714, 0.618, 0.578, 0.500, 0.440, 0.412, 0.294, 0.233],
    [0.981, 0.999, 0.999, 0.965, 0.936, 0.974, 0.907, 0.852, 0.851, 0.799, 0.784, 0.755, 0.768, 0.705, 0.629, 0.560, 0.500, 0.458, 0.357, 0.296],
    [1.000, 1.000, 0.982, 1.000, 0.959, 0.935, 0.965, 0.956, 0.916, 0.913, 0.871, 0.822, 0.785, 0.767, 0.686, 0.588, 0.542, 0.500, 0.438, 0.393],
    [1.000, 1.000, 0.984, 0.983, 0.966, 0.990, 0.988, 0.952, 0.936, 0.929, 0.939, 0.863, 0.887, 0.774, 0.810, 0.706, 0.643, 0.562, 0.500, 0.505],
    [1.000, 1.000, 1.000, 1.000, 0.989, 1.000, 1.000, 0.981, 0.995, 0.979, 0.954, 0.959, 0.949, 0.901, 0.879, 0.767, 0.704, 0.607, 0.495, 0.500],
]


def table_win_probability(our_score, their_score):
    """
    The raw table lookup, with no end-of-game handling. Public so tests and
    tuning scripts can inspect the estimate itself; game code should call
    `win_probability`, which resolves decided games exactly instead of
    estimating them.
    """
    return WIN_PROBABILITY_TABLE[score_bucket(our_score)][score_bucket(their_score)]


def resolve_game_winner(our_score, their_score, we_bid):
    """
    Who has already won, if anyone: True (us), False (them), or None if the
    game continues.

    Mirrors `Game.play`'s end conditions exactly rather than approximating
    them, because this is the half of the objective that has to be *right*:

      - Busting at -1000 is checked first and hands the game to the other
        side, even if that side is nowhere near 1000.
      - Otherwise a side at or past 1000 wins; if both crossed in the same
        round, the *bidding* team takes it. `we_bid` is which side that was.

    Only one team can bust in a given round (the defenders always score their
    meld, which is never negative), so a double bust cannot arise from real
    play; it is treated as undecided rather than given an invented winner.
    """
    we_busted = our_score <= GAME_LOSE_SCORE
    they_busted = their_score <= GAME_LOSE_SCORE
    if we_busted and they_busted:
        return None
    if we_busted:
        return False
    if they_busted:
        return True

    we_are_over = our_score >= GAME_WIN_SCORE
    they_are_over = their_score >= GAME_WIN_SCORE
    if we_are_over and they_are_over:
        return bool(we_bid)
    if we_are_over:
        return True
    if they_are_over:
        return False
    return None


def win_probability(our_score, their_score, we_bid=False):
    """
    P(we win the game) from this score state - 1.0 / 0.0 when the game is
    already over, the measured table otherwise.

    `we_bid` only matters for the one ambiguous terminal state (both sides
    past 1000 in the same round), where the rules give it to the bidding team.
    It is a keyword with a default because most callers are asking about a
    state that is plainly still in progress.
    """
    decided = resolve_game_winner(our_score, their_score, we_bid)
    if decided is not None:
        return 1.0 if decided else 0.0
    return table_win_probability(our_score, their_score)


# ---------------------------------------------------------------------------
# Generation from self-play. Dev tooling - not imported by game code.
# ---------------------------------------------------------------------------

def collect_self_play_states(n_games, seed=None, player_class=Player, player_kwargs=None):
    """
    Play `n_games` full games and record, for every round, the score state the
    round *started* from plus who eventually won.

    `Game.play`'s `on_round` hook fires after the round is scored but before
    the scores are applied, so `team.score` at that moment is exactly the
    pre-round state - which is the state a bid decision is actually made in.

    Returns `(observations, deltas)`: observations is a list of
    `(our_score, their_score, we_won)` from team A's point of view, deltas is
    the flat list of per-round (team A delta - team B delta) differentials the
    prior's spread constant is measured from.
    """
    player_kwargs = player_kwargs or {}
    rng = random.Random(seed)
    observations = []
    deltas = []
    gains = []

    for _ in range(n_games):
        game_seed = rng.randrange(2 ** 63)
        random.seed(game_seed)
        players = [player_class(f"P{i}", None, **player_kwargs) for i in range(4)]
        game = Game.from_players(players)
        team_a, team_b = game.teams

        states = []

        def on_round(round_, round_scores, states=states, team_a=team_a, team_b=team_b):
            states.append((team_a.score, team_b.score))
            deltas.append(round_scores[team_a] - round_scores[team_b])
            gains.append(round_scores[team_a])
            gains.append(round_scores[team_b])

        winner = game.play(deal_seed=game_seed, on_round=on_round)
        a_won = winner is team_a
        for our_score, their_score in states:
            observations.append((our_score, their_score, a_won))

    return observations, deltas, gains


def _mean(values):
    return sum(values) / len(values) if values else 0.0


def _stdev(values):
    if len(values) < 2:
        return 0.0
    mean = _mean(values)
    return math.sqrt(sum((v - mean) ** 2 for v in values) / (len(values) - 1))


def generate_table(n_games, seed=None, player_class=Player, player_kwargs=None,
                   shrink_strength=SHRINK_STRENGTH):
    """
    Tabulate self-play outcomes into the 20 x 20 win-probability table.

    Every observation is entered twice - once as itself and once mirrored
    across the diagonal with the outcome flipped - so the table satisfies
    `P(a, b) == 1 - P(b, a)` exactly. Without that, a bid-vs-defend comparison
    could read two cells that disagree about the same situation purely because
    one side of the diagonal happened to get more games.

    Returns `(table, stats)`. `stats` carries the measured `round_gain` /
    `round_spread` (which the prior needs, and which are re-measured here
    rather than assumed) plus the per-cell observation counts, so a
    regeneration can be sanity-checked instead of trusted.
    """
    observations, deltas, gains = collect_self_play_states(
        n_games, seed=seed, player_class=player_class, player_kwargs=player_kwargs,
    )

    round_gain = _mean([g for g in gains if g > 0]) or TYPICAL_ROUND_GAIN
    round_spread = _stdev(deltas) or TYPICAL_ROUND_SPREAD

    wins = defaultdict(float)
    counts = defaultdict(int)
    for our_score, their_score, we_won in observations:
        i, j = score_bucket(our_score), score_bucket(their_score)
        counts[(i, j)] += 1
        wins[(i, j)] += 1.0 if we_won else 0.0
        # Mirrored copy: the same round seen from the other side of the table.
        counts[(j, i)] += 1
        wins[(j, i)] += 0.0 if we_won else 1.0

    table = []
    for i in range(BUCKET_COUNT):
        row = []
        for j in range(BUCKET_COUNT):
            prior = prior_win_probability(
                bucket_midpoint(i), bucket_midpoint(j),
                round_gain=round_gain, round_spread=round_spread,
            )
            n = counts[(i, j)]
            if n:
                empirical = wins[(i, j)] / n
                value = (n * empirical + shrink_strength * prior) / (n + shrink_strength)
            else:
                value = prior
            row.append(round(value, 3))
        table.append(row)

    stats = {
        "n_games": n_games,
        "n_observations": len(observations),
        "n_mirrored": 2 * len(observations),
        "round_gain": round_gain,
        "round_spread": round_spread,
        "counts": dict(counts),
        "populated_cells": sum(1 for v in counts.values() if v > 0),
    }
    return table, stats


def format_table_literal(table):
    """Render a generated table as the Python literal to paste into this
    module - regeneration should be copy-paste, not hand transcription."""
    lines = ["WIN_PROBABILITY_TABLE = ["]
    for row in table:
        lines.append("    [" + ", ".join(f"{v:.3f}" for v in row) + "],")
    lines.append("]")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Regenerate the win-probability table from self-play (#102)",
    )
    parser.add_argument("--games", type=int, default=4000,
                        help="self-play games to tabulate (default: 4000)")
    parser.add_argument("--seed", type=int, default=7, help="seed for the self-play run")
    args = parser.parse_args()

    table, stats = generate_table(args.games, seed=args.seed)
    print(f"# {stats['n_games']} games, {stats['n_observations']} round-states "
          f"({stats['n_mirrored']} mirrored), {stats['populated_cells']}/400 cells populated")
    print(f"TYPICAL_ROUND_GAIN = {stats['round_gain']:.1f}")
    print(f"TYPICAL_ROUND_SPREAD = {stats['round_spread']:.1f}")
    print(format_table_literal(table))


if __name__ == "__main__":
    main()

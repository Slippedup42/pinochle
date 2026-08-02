"""
Head-to-head A/B harness on identical deals (issue #105, epic #106).

Every change in epic #106 replaces a tuned constant with a measured estimate.
That is only an improvement if it wins more games, and eyeballing a batch of
simulated games cannot tell you whether it did. This module is the instrument
that can.

Two properties do the heavy lifting:

  Identical deals. Both configurations play the same shuffles, via
  `Game.play(deal_seed=...)` (which derives round N's shuffle from the seed
  and N alone, so it does not drift when one config consumes more random
  values while thinking). The deal is by far the largest source of variance
  in Pinochle, and holding it fixed removes most of it for free - which is
  worth many times more than simply running more games.

  Mirrored seats. Each deal seed is played twice, swapping which side sits in
  seats 0&2. `Game` always deals to seat 0 first and starts dealer rotation
  at index 0, so any positional edge would otherwise read as a skill gap.
  Playing both orientations of the same deal cancels it, and means a deal
  that happens to favour one seat pair benefits both configs equally.

Significance is reported, not left to the reader. "A won 52 to 48" over 100
games is noise, and a harness that prints it without saying so actively
invites the wrong conclusion - which is the specific failure mode this epic
is exposed to, since a rollout AI can easily look more sophisticated while
quietly losing.

Two statistics, because they answer different questions:

  Games won, tested over *pairs* rather than games. The two games in a pair
  are the same deal mirrored, so they are strongly anti-correlated; treating
  them as independent trials would roughly halve the standard error and
  manufacture confidence. Split pairs carry no direction and are discarded,
  as in a sign test, so `decisive_pairs` is the real sample size. Exact
  two-sided binomial test, Wilson score interval.

  Score margin per deal, with a percentile-bootstrap interval. Games won is a
  coarse statistic - it discards *how* a game was won, and with tightly
  paired configs most deals split, leaving very few decisive pairs to reason
  from. Margin keeps the magnitude and will usually resolve a real difference
  long before games-won does. The fold-vs-no-fold comparison is exactly this
  case: 51-49 on games (nothing), +122 per deal with a 95% CI of +53 to +192
  on margin (a real effect).

Both are computed here rather than pulled from scipy, to keep the project
dependency-free.

Note that the run seeds the *players* as well as the deals. The AI tiers draw
from the global `random` module in several places, so seeding only the deal
leaves the result irreproducible - the same invocation produced both
"not significant" and "significant" before this was fixed.

`tournament_sim.py` (issue #64) stays as-is: it answers "how do these two
fare over many games", with independent deals and no statistics. This module
answers "is the difference real".

Run the self-test, which is also the harness's own correctness check - a
config against itself must not show a significant difference:

    python ab_harness.py
    python ab_harness.py --pairs 200
"""

import argparse
import inspect
import math
import random
import time
from dataclasses import dataclass, field

from pinochle_engine import Game, Player
from tournament_sim import PlayerConfig, team_config  # noqa: F401  (re-exported for callers)


# ---------------------------------------------------------------------------
# Statistics. Deliberately small and dependency-free.
# ---------------------------------------------------------------------------

def binomial_two_sided_p(wins, trials, p=0.5):
    """
    Exact two-sided binomial test that `wins` out of `trials` differs from
    `p`. Sums the probability of every outcome no more likely than the one
    observed, which is the standard exact construction and behaves sensibly
    for the small, symmetric case this harness cares about.

    Returns 1.0 for `trials == 0` - no evidence is not evidence of no
    difference, and 1.0 is the value that keeps callers from claiming one.
    """
    if trials <= 0:
        return 1.0

    def pmf(k):
        return math.comb(trials, k) * (p ** k) * ((1 - p) ** (trials - k))

    observed = pmf(wins)
    # Floating-point slack, so an outcome that is symmetric to the observed
    # one is not excluded by a last-bit difference.
    tolerance = observed * 1e-9
    return min(1.0, sum(pmf(k) for k in range(trials + 1) if pmf(k) <= observed + tolerance))


def bootstrap_mean_ci(values, iters=5000, alpha=0.05, rng=None):
    """
    Percentile bootstrap confidence interval for the mean of `values`.

    Games-won is a coarse statistic: it throws away *how* a game was won, so
    a real edge can easily fail to register over a few hundred games. Score
    margin keeps that magnitude, and a bootstrap puts an interval around it
    without assuming the margins are normally distributed - which they are
    not, being a mix of comfortable wins, blowouts and near-ties.

    An interval that excludes zero is evidence of a real difference in
    margin, and will usually appear well before games-won reaches
    significance on the same data.
    """
    n = len(values)
    if n == 0:
        return (0.0, 0.0)
    if n == 1:
        return (values[0], values[0])

    rng = rng if rng is not None else random.Random(0)
    means = []
    for _ in range(iters):
        total = 0.0
        for _ in range(n):
            total += values[rng.randrange(n)]
        means.append(total / n)
    means.sort()
    lo = means[int((alpha / 2) * iters)]
    hi = means[min(iters - 1, int((1 - alpha / 2) * iters))]
    return (lo, hi)


def wilson_interval(wins, trials, z=1.96):
    """
    Wilson score interval for a win rate - preferred over the normal
    approximation because it stays inside [0, 1] and behaves at the extremes
    (0 or all wins), which a small tuning run hits regularly.
    """
    if trials <= 0:
        return (0.0, 1.0)
    phat = wins / trials
    denom = 1 + z ** 2 / trials
    centre = (phat + z ** 2 / (2 * trials)) / denom
    half = z * math.sqrt(phat * (1 - phat) / trials + z ** 2 / (4 * trials ** 2)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


# ---------------------------------------------------------------------------
# Per-side accumulators
# ---------------------------------------------------------------------------

@dataclass
class SideStats:
    """Round-level behaviour for one side, aggregated across every game."""
    contracts: int = 0        # rounds this side won the auction
    made: int = 0             # ...and made it
    set_: int = 0             # ...and was set (played on and failed)
    conceded: int = 0         # ...and conceded before playing
    # ...and that concession was forced by the auto-SET rule rather than chosen
    # (issue #178). A subset of `conceded`, not a fourth outcome. Reported
    # because the frequency is the number that says whether the rule matters:
    # a hard prune that almost never fires cannot move a score much, however
    # obviously correct it is.
    auto_set: int = 0
    bids: list = field(default_factory=list)

    @property
    def set_rate(self):
        return self.set_ / self.contracts if self.contracts else 0.0

    @property
    def fold_rate(self):
        return self.conceded / self.contracts if self.contracts else 0.0

    @property
    def auto_set_rate(self):
        return self.auto_set / self.contracts if self.contracts else 0.0

    @property
    def make_rate(self):
        return self.made / self.contracts if self.contracts else 0.0

    @property
    def avg_bid(self):
        return sum(self.bids) / len(self.bids) if self.bids else 0.0


@dataclass
class AbReport:
    n_pairs: int
    label_a: str
    label_b: str
    wins_a: int = 0
    wins_b: int = 0
    margins_a: list = field(default_factory=list)
    # Per-pair result, +1 when A swept both orientations of that deal, -1 when
    # B did, 0 when they split it.
    pair_results: list = field(default_factory=list)
    stats_a: SideStats = field(default_factory=SideStats)
    stats_b: SideStats = field(default_factory=SideStats)
    elapsed_seconds: float = 0.0

    @property
    def n_games(self):
        return self.wins_a + self.wins_b

    @property
    def win_rate_a(self):
        return self.wins_a / self.n_games if self.n_games else 0.0

    @property
    def avg_margin_a(self):
        return sum(self.margins_a) / len(self.margins_a) if self.margins_a else 0.0

    # -- Paired analysis -----------------------------------------------------
    #
    # Significance is computed over *pairs*, not games. The two games in a
    # pair are the same deal with the seats mirrored, so they are strongly
    # anti-correlated by construction - treating them as independent trials
    # would roughly halve the standard error and manufacture confidence that
    # is not there. Against an identical opponent every pair splits 1-1, which
    # is exactly the "no evidence" the self-test should report; a game-level
    # test on the same data would instead see a tidy 50/50 out of N games and
    # quote a misleadingly tight interval around it.
    #
    # Split pairs carry no directional information and are discarded, as in a
    # sign test. `decisive_pairs` is therefore the real sample size.

    @property
    def pairs_a(self):
        return sum(1 for r in self.pair_results if r > 0)

    @property
    def pairs_b(self):
        return sum(1 for r in self.pair_results if r < 0)

    @property
    def pairs_split(self):
        return sum(1 for r in self.pair_results if r == 0)

    @property
    def decisive_pairs(self):
        return self.pairs_a + self.pairs_b

    @property
    def p_value(self):
        return binomial_two_sided_p(self.pairs_a, self.decisive_pairs)

    def is_significant(self, alpha=0.05):
        return self.p_value < alpha

    @property
    def pair_margins_a(self):
        """A's average score margin per deal, across both orientations of it.
        Averaging the mirrored pair cancels any seat advantage before the
        number ever reaches the statistics."""
        return [
            (self.margins_a[i] + self.margins_a[i + 1]) / 2
            for i in range(0, len(self.margins_a) - 1, 2)
        ]

    def margin_ci(self, rng=None):
        return bootstrap_mean_ci(self.pair_margins_a, rng=rng or random.Random(0))

    def margin_is_significant(self, rng=None):
        """True when the bootstrap interval on paired margin excludes zero."""
        low, high = self.margin_ci(rng=rng)
        return low > 0 or high < 0

    def summary(self):
        low, high = wilson_interval(self.pairs_a, self.decisive_pairs)
        p = self.p_value
        leader = self.label_a if self.pairs_a > self.pairs_b else self.label_b
        if self.decisive_pairs == 0:
            verdict = "NO EVIDENCE - every deal split, the two sides are indistinguishable here"
        elif p < 0.05:
            verdict = f"SIGNIFICANT at p<0.05 - {leader} is ahead"
        else:
            verdict = "NOT significant - this difference is consistent with chance"
        ms = self.elapsed_seconds / self.n_games * 1000 if self.n_games else 0.0
        col = max(12, len(self.label_a) + 2, len(self.label_b) + 2)

        pair_margins = self.pair_margins_a
        margin_mean = sum(pair_margins) / len(pair_margins) if pair_margins else 0.0
        margin_low, margin_high = self.margin_ci()
        if margin_low > 0:
            margin_verdict = f"CI excludes zero - {self.label_a} really is ahead on margin"
        elif margin_high < 0:
            margin_verdict = f"CI excludes zero - {self.label_b} really is ahead on margin"
        else:
            margin_verdict = "CI includes zero - no established difference in margin"

        lines = [
            f"A/B: {self.label_a} vs {self.label_b}",
            f"  {self.n_pairs} deals x 2 seat orientations = {self.n_games} games "
            f"({self.elapsed_seconds:.1f}s, {ms:.0f} ms/game)",
            "",
            "  Games (descriptive):",
            f"    {self.label_a}: {self.wins_a} ({self.win_rate_a:.1%})   "
            f"avg margin {self.avg_margin_a:+.0f}",
            f"    {self.label_b}: {self.wins_b} ({1 - self.win_rate_a:.1%})   "
            f"avg margin {-self.avg_margin_a:+.0f}",
            "",
            "  Paired deals (inferential - split pairs carry no information):",
            f"    {self.label_a} swept {self.pairs_a},  {self.label_b} swept {self.pairs_b},  "
            f"split {self.pairs_split}",
            f"    95% CI on {self.label_a}'s share of {self.decisive_pairs} decisive deals: "
            f"{low:.1%} - {high:.1%}",
            f"    two-sided exact binomial p = {p:.4f}",
            f"    {verdict}",
            "",
            "  Paired score margin (more sensitive than games won):",
            f"    {self.label_a} avg margin per deal {margin_mean:+.0f}   "
            f"95% CI {margin_low:+.0f} to {margin_high:+.0f}",
            f"    {margin_verdict}",
            "",
            f"  {'':22s}{self.label_a:>{col}s}{self.label_b:>{col}s}",
            f"  {'contracts won':22s}{self.stats_a.contracts:>{col}d}{self.stats_b.contracts:>{col}d}",
            f"  {'made':22s}{self.stats_a.make_rate:>{col}.1%}{self.stats_b.make_rate:>{col}.1%}",
            f"  {'set':22s}{self.stats_a.set_rate:>{col}.1%}{self.stats_b.set_rate:>{col}.1%}",
            f"  {'conceded':22s}{self.stats_a.fold_rate:>{col}.1%}{self.stats_b.fold_rate:>{col}.1%}",
            f"  {'  of which auto-set':22s}{self.stats_a.auto_set_rate:>{col}.1%}{self.stats_b.auto_set_rate:>{col}.1%}",
            f"  {'avg bid':22s}{self.stats_a.avg_bid:>{col}.0f}{self.stats_b.avg_bid:>{col}.0f}",
        ]
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def _build_seated_player(config, name, seed):
    """
    Build one seat's player, seeded where the class supports it.

    Seeding the *deal* is not enough to make a run reproducible. The AI tiers
    draw from the global `random` module in several places, and
    `GeneralStrategy.rng` defaults to that module too - so an unseeded run
    gives a different answer every time. That was not a theoretical worry:
    the same fold-vs-no-fold invocation produced both "50-50, not
    significant" and "59-41, significant" before this was fixed, which is
    exactly the kind of irreproducibility that would make this harness worse
    than useless for tuning.

    A caller who passes their own `rng` in the config keeps it.
    """
    kwargs = dict(config.kwargs)
    accepts_rng = "rng" in inspect.signature(config.player_class.__init__).parameters
    if accepts_rng and "rng" not in kwargs:
        kwargs["rng"] = random.Random(seed)
    return config.player_class(name, None, **kwargs)


def _record_round(round_, round_scores, stats_for_team):
    """Attribute one finished round to whichever side won its auction."""
    bidding_team = round_.bid_winner.team
    stats = stats_for_team.get(id(bidding_team))
    if stats is None:
        return
    stats.contracts += 1
    stats.bids.append(round_.current_bid)
    if round_.conceded:
        stats.conceded += 1
        if round_.auto_set:
            stats.auto_set += 1
    elif round_scores[bidding_team] < 0:
        stats.set_ += 1
    else:
        stats.made += 1


def run_ab(team_a, team_b, n_pairs, label_a="A", label_b="B", seed=None):
    """
    Play `n_pairs` deals, each twice with the seats mirrored, and report
    whether the difference in games won is real.

    team_a / team_b: each a list of 2 PlayerConfig (see tournament_sim's
    team_config() for the common same-tier-both-seats case).

    Total games played is 2 * n_pairs.
    """
    assert len(team_a) == 2, "team_a must have exactly 2 seat configs"
    assert len(team_b) == 2, "team_b must have exactly 2 seat configs"
    assert n_pairs > 0

    report = AbReport(n_pairs=n_pairs, label_a=label_a, label_b=label_b)
    seed_source = random.Random(seed)
    start = time.perf_counter()

    for _ in range(n_pairs):
        # One deal sequence, played in both seat orientations.
        deal_seed = seed_source.randrange(2 ** 63)
        pair_wins_a = 0

        # Both orientations of a deal share one player seed, so the two games
        # differ only by seating - the thing the mirroring exists to cancel.
        play_seed = seed_source.randrange(2 ** 63)

        for a_first in (True, False):
            if a_first:
                seat_configs = [team_a[0], team_b[0], team_a[1], team_b[1]]
            else:
                seat_configs = [team_b[0], team_a[0], team_b[1], team_a[1]]

            # Covers the tiers that reach for the global RNG directly.
            random.seed(play_seed)
            players = [
                _build_seated_player(cfg, f"P{seat}", play_seed + seat)
                for seat, cfg in enumerate(seat_configs)
            ]
            game = Game.from_players(players)

            # Game.from_players always wires teams[0] = seats (0,2) and
            # teams[1] = seats (1,3), so which object is "A" flips with the
            # orientation.
            team_a_obj = game.teams[0] if a_first else game.teams[1]
            team_b_obj = game.teams[1] if a_first else game.teams[0]
            stats_for_team = {id(team_a_obj): report.stats_a, id(team_b_obj): report.stats_b}

            winner = game.play(
                deal_seed=deal_seed,
                on_round=lambda r, s: _record_round(r, s, stats_for_team),
            )

            report.margins_a.append(team_a_obj.score - team_b_obj.score)
            if winner is team_a_obj:
                report.wins_a += 1
                pair_wins_a += 1
            else:
                report.wins_b += 1

        # +1 A swept this deal, -1 B swept it, 0 they split it.
        report.pair_results.append({2: 1, 1: 0, 0: -1}[pair_wins_a])

    report.elapsed_seconds = time.perf_counter() - start
    return report


# ---------------------------------------------------------------------------
# CLI / self-test
# ---------------------------------------------------------------------------

def self_test(n_pairs, seed=None):
    """
    A configuration against itself. Any significant result here is a bug in
    the harness, not a discovery about the AI - the two sides are the same
    strategy, so only seating, deal assignment or bookkeeping could separate
    them.
    """
    report = run_ab(
        team_config(Player), team_config(Player), n_pairs,
        label_a="Proficient A", label_b="Proficient B", seed=seed,
    )
    print(report.summary())
    return report


def main():
    parser = argparse.ArgumentParser(description="Head-to-head A/B on identical deals (#105)")
    parser.add_argument("--pairs", type=int, default=100,
                        help="deals to play; each is played twice with mirrored seats (default: 100)")
    parser.add_argument("--seed", type=int, default=None, help="seed for the deal sequence")
    args = parser.parse_args()
    self_test(args.pairs, seed=args.seed)


if __name__ == "__main__":
    main()

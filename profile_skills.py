"""
Skill-profile harness - per-skill behavioural statistics over random
mixed-skill games.

`tournament_sim.py` answers "which of these two configurations wins?".
This answers a different question: "what does each skill level actually
*do*, and are the five levels still distinguishable from each other?".
Win rate cannot answer that - two tiers can have very different win rates
while playing an identical style, and (more to the point here) two tiers
with identical parameters will look like two different tiers in a
tournament purely through noise.

Seats are assigned skill levels uniformly at random, independently, every
game - the same draw `RandomStrategy` makes, but done here so the
harness knows which level sat where and can attribute every decision to
it. Random mixing rather than fixed matchups is deliberate: a level's
numbers should describe the level, not the specific opponent it was
pinned against, and every level meets every other level in every seat
combination over enough games.

## The fold question this is built to answer

Fold rate on its own does not rank players. A strong player folds
because they counted the hand and the contract is not there; a weak
player folds because the hand looks scary. Both show up as "folds
often". What separates them is *which* hands they fold, so this harness
measures discrimination rather than frequency:

  - `needed` = bid - bidding-team meld: the trick points the contract
    still requires, known exactly at the fold decision point, out of the
    250 available. This is the number a thinking player computes, so it
    is the natural axis to test folds against.

  - Fold AUC = P(a folded contract needed more than a played one),
    computed per level over its own decisions. 0.50 means folds are
    uncorrelated with how hard the contract was - fear, or a coin flip.
    1.00 means the level folds exactly the hard ones and plays exactly
    the easy ones. This is rank-based, so it is unaffected by how *often*
    a level folds; a level that folds 5% and one that folds 40% are
    directly comparable.

  - Missed folds, for the levels that never fold at all. Conceding is
    scored at -bid for the bidding team and denies the defenders their
    trick points (`Round._score_conceded_round`), so the fold payoff is
    known exactly at decision time: margin = -bid - defending_meld. Any
    played contract whose realised margin came in below that number was
    a contract the level should have conceded. This turns "level N never
    folds" from a code observation into a points-per-round cost.

Run:

    python profile_skills.py --games 300
    python profile_skills.py --games 300 --seed 11 --json out.json
"""

import argparse
import json
import random
import statistics
import time
from collections import defaultdict
from dataclasses import dataclass, field

from pinochle_engine import (
    GENERAL_STRATEGY_SKILL_PARAMS,
    Game,
    GeneralStrategy,
    score_melds,
)

SKILL_LEVELS = sorted(GENERAL_STRATEGY_SKILL_PARAMS)
MAX_TRICK_POINTS = 250  # 240 in card points + 10 for last trick, per pinochle_rules.md


# ---------------------------------------------------------------------------
# Collection - one record per decision, aggregated at the end.
# ---------------------------------------------------------------------------

@dataclass
class ContractRecord:
    """One taken contract, filled in across two callbacks: the fold hook
    (which fires before any card is led, and so is the only place the
    pre-trick state still exists) and the round hook (which has the
    result). `folded` is the level's decision; `margin` is what the
    bidding team actually scored minus what the defenders scored."""
    winner_skill: int
    bid: int
    bidding_meld: int
    defending_meld: int
    winner_own_meld: int
    folded: bool
    margin: int = 0
    made: bool = False

    @property
    def needed(self):
        """Trick points the contract still requires. Negative means meld
        alone already covers the bid; above MAX_TRICK_POINTS means it is
        arithmetically unreachable no matter how the cards fall."""
        return self.bid - self.bidding_meld

    @property
    def fold_margin(self):
        """What conceding would have scored, exactly. Known at decision
        time - the defenders keep their meld and take no tricks."""
        return -self.bid - self.defending_meld

    @property
    def auto_set(self):
        """The contract is arithmetically unreachable: even taking every
        trick point on the table leaves the bidding team short.

        Worth separating out, because folding one of these is not a
        judgment call - it is subtraction, and `should_fold` shortcuts
        straight to True on it without consulting a rollout. A level whose
        folds are all auto-sets has not demonstrated it can read a hand;
        it has demonstrated it can subtract. The interesting question is
        how well a level folds on the contracts that are *live*."""
        return self.needed > MAX_TRICK_POINTS


@dataclass
class SkillTally:
    """Everything counted for one skill level, across all seats it
    occupied. Bid-level counters are per auction turn; contract-level
    counters are per contract won."""
    seat_games: int = 0
    auction_turns: int = 0
    bids: int = 0
    opening_turns: int = 0  # turns where nobody had bid yet
    opens: int = 0
    bid_amounts: list = field(default_factory=list)
    melds_at_meld_time: list = field(default_factory=list)
    contracts: list = field(default_factory=list)  # ContractRecord


class Collector:
    """Shared sink. One instance per run, handed to every player."""

    def __init__(self):
        self.tallies = defaultdict(SkillTally)
        self.pending = None  # ContractRecord awaiting its round result

    def record_bid(self, skill, opening, bid_amount):
        tally = self.tallies[skill]
        tally.auction_turns += 1
        if opening:
            tally.opening_turns += 1
        if bid_amount is not None:
            tally.bids += 1
            tally.bid_amounts.append(bid_amount)
            if opening:
                tally.opens += 1

    def record_meld(self, skill, meld):
        self.tallies[skill].melds_at_meld_time.append(meld)

    def record_contract(self, record):
        self.pending = record
        self.tallies[record.winner_skill].contracts.append(record)

    def close_round(self, margin, made):
        if self.pending is None:
            return
        self.pending.margin = margin
        self.pending.made = made
        self.pending = None


# ---------------------------------------------------------------------------
# Instrumented player - records, decides nothing itself.
# ---------------------------------------------------------------------------

class ProfiledStrategy(GeneralStrategy):
    """`GeneralStrategy` with the two decision points this harness reads
    wrapped. Every override calls `super()` for the actual decision and
    only observes the answer, so a run measures the shipped AI and not a
    variant of it."""

    def __init__(self, name, team=None, skill_level=3, rng=None, collector=None):
        super().__init__(name, team, skill_level=skill_level, rng=rng)
        self.collector = collector

    def choose_bid(self, current_bid, min_increment, context=None):
        decision = super().choose_bid(current_bid, min_increment, context)
        if self.collector is not None and context is not None:
            self.collector.record_bid(
                self.skill_level,
                opening=not context.get("ever_bid", False),
                bid_amount=decision,
            )
        return decision

    def decide_fold(self, trump, bid, bidding_meld, defending_meld):
        folded = bool(super().decide_fold(trump, bid, bidding_meld, defending_meld))
        if self.collector is None:
            return folded

        # Only the bid winner is asked to fold, and it happens after meld
        # and before the first lead - the one moment all four hands are
        # both scored and still intact. Reaching the other three seats
        # through the team wiring is what lets per-seat meld be attributed
        # to a skill level without patching Round._meld_phase.
        for player in self._all_players():
            self.collector.record_meld(player.skill_level, score_melds(player.hand, trump)[0])

        self.collector.record_contract(ContractRecord(
            winner_skill=self.skill_level,
            bid=bid,
            bidding_meld=bidding_meld,
            defending_meld=defending_meld,
            winner_own_meld=score_melds(self.hand, trump)[0],
            folded=folded,
        ))
        return folded

    def _all_players(self):
        seats = list(self.team.players)
        opponent = getattr(self.team, "opponent", None)
        if opponent is not None:
            seats += list(opponent.players)
        return [p for p in seats if isinstance(p, ProfiledStrategy)]


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def run_profile(n_games, seed=None, progress_every=25):
    """Play `n_games` games, each with a fresh uniform-random skill level
    per seat. Returns the populated Collector.

    Skills are redrawn per game rather than per run so that no level is
    stuck facing one particular opponent, and the deal seed is derived per
    game from the master RNG so a surprising game can be replayed."""
    rng = random.Random(seed)
    collector = Collector()
    start = time.perf_counter()

    for game_index in range(n_games):
        skills = [rng.choice(SKILL_LEVELS) for _ in range(4)]
        players = [
            ProfiledStrategy(f"S{seat}", None, skill_level=skill, rng=rng, collector=collector)
            for seat, skill in enumerate(skills)
        ]
        for skill in skills:
            collector.tallies[skill].seat_games += 1

        game = Game.from_players(players)

        def on_round(round_, round_scores, _game=game):
            bidding_team = round_.bid_winner.team
            defending_team = next(t for t in _game.teams if t is not bidding_team)
            margin = round_scores[bidding_team] - round_scores[defending_team]
            collector.close_round(margin, made=round_scores[bidding_team] > 0)

        game.play(deal_seed=rng.randrange(2 ** 31), on_round=on_round)

        if progress_every and (game_index + 1) % progress_every == 0:
            elapsed = time.perf_counter() - start
            print(f"  {game_index + 1}/{n_games} games  ({elapsed:.0f}s)", flush=True)

    return collector, time.perf_counter() - start


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------

def fold_auc(records):
    """P(a folded contract needed more trick points than a played one),
    with ties counted as half - the Mann-Whitney U statistic, which is
    what AUC is.

    Returns None unless the level both folded and played at least one
    contract, since discrimination is undefined with only one class.
    Computed on `needed` because that is the quantity available at the
    decision point; scoring it against the eventual result instead would
    reward luck."""
    folded = [r.needed for r in records if r.folded]
    played = [r.needed for r in records if not r.folded]
    if not folded or not played:
        return None
    wins = sum(
        1.0 if f > p else 0.5 if f == p else 0.0
        for f in folded
        for p in played
    )
    return wins / (len(folded) * len(played))


def missed_folds(records):
    """Played contracts that scored below what conceding would have paid -
    the value a level would have captured by folding with perfect
    foresight.

    Read this as a ceiling, not as a count of blunders. Conceding *always*
    beats being set: both pay the bidding team -bid, but a concede denies
    the defenders their trick points, so the set is strictly worse by
    exactly those points. That makes this count identically equal to the
    level's set count - it is not evidence of a detectable mistake, since
    nobody knows in advance which contracts will fail. What it does
    measure honestly is the size of the prize: how many points a perfect
    fold oracle would be worth per contract, and therefore how much room a
    real fold policy has to work in. Comparing a folding level's residual
    against a never-folding level's total is the useful reading.

    Returns (count, played_total, mean points left on the table across
    *all* played contracts)."""
    played = [r for r in records if not r.folded]
    if not played:
        return 0, 0, 0.0
    missed = [r for r in played if r.fold_margin > r.margin]
    forgone = sum(r.fold_margin - r.margin for r in missed)
    return len(missed), len(played), forgone / len(played)


def _mean(values):
    return statistics.mean(values) if values else 0.0


def summarise(collector, elapsed, n_games):
    tallies = collector.tallies
    total_contracts = sum(len(t.contracts) for t in tallies.values())
    lines = [
        f"Skill profile - {n_games} games, random skill per seat "
        f"({elapsed:.0f}s, {elapsed / n_games * 1000:.0f} ms/game)",
        f"{total_contracts} contracts across all levels",
        "",
        "Level  seats  bid%   open%   avgbid  contracts  make%   set%   fold%   meld  ownmeld",
        "-" * 92,
    ]

    for skill in SKILL_LEVELS:
        tally = tallies[skill]
        records = tally.contracts
        n = len(records)
        folded = sum(1 for r in records if r.folded)
        played = [r for r in records if not r.folded]
        made = sum(1 for r in played if r.made)
        lines.append(
            f"  {skill}    {tally.seat_games:4d}  "
            f"{tally.bids / tally.auction_turns:5.1%} "
            f"{tally.opens / tally.opening_turns if tally.opening_turns else 0:6.1%}  "
            f"{_mean(tally.bid_amounts):6.0f}  "
            f"{n:8d}  "
            f"{made / len(played) if played else 0:5.1%}  "
            f"{(len(played) - made) / len(played) if played else 0:5.1%}  "
            f"{folded / n if n else 0:5.1%}  "
            f"{_mean(tally.melds_at_meld_time):5.0f}  "
            f"{_mean([r.winner_own_meld for r in records]):6.0f}"
        )

    lines += [
        "",
        "Fold quality - is a level's folding skill or fear?",
        "",
        "Level  folds  fold%   AUC(all)  AUC(live)  autoset%  needed(fold)  needed(play)",
        "-" * 92,
    ]
    for skill in SKILL_LEVELS:
        records = tallies[skill].contracts
        n = len(records)
        folded = [r for r in records if r.folded]
        played = [r for r in records if not r.folded]
        auc_all = fold_auc(records)
        auc_live = fold_auc([r for r in records if not r.auto_set])
        auto = sum(1 for r in folded if r.auto_set)
        lines.append(
            f"  {skill}  {len(folded):5d}  {len(folded) / n if n else 0:5.1%}  "
            f"{f'{auc_all:.3f}' if auc_all is not None else '-':>8}  "
            f"{f'{auc_live:.3f}' if auc_live is not None else '-':>9}  "
            f"{auto / len(folded) if folded else 0:7.1%}  "
            f"{_mean([r.needed for r in folded]):11.0f}  "
            f"{_mean([r.needed for r in played]):12.0f}"
        )

    lines += [
        "",
        "Hindsight value of folding - what a perfect fold oracle would be worth",
        "(equal to the set count by identity: a concede always beats a set by the",
        " defenders' trick points, so this is the size of the prize, not a blunder count)",
        "",
        "Level   sets/played    set%   oracle gain/contract   gain when it applies",
        "-" * 92,
    ]
    for skill in SKILL_LEVELS:
        records = tallies[skill].contracts
        n_missed, n_played, cost = missed_folds(records)
        played = [r for r in records if not r.folded]
        missed = [r for r in played if r.fold_margin > r.margin]
        lines.append(
            f"  {skill}  {n_missed:6d}/{n_played:<7d} "
            f"{n_missed / n_played if n_played else 0:6.1%}  "
            f"{cost:+12.0f}   "
            f"{_mean([r.fold_margin - r.margin for r in missed]):+18.0f}"
        )

    lines += [
        "",
        f"`needed` = bid - bidding meld, out of {MAX_TRICK_POINTS} trick points available.",
        "AUC 0.50 = folds unrelated to how hard the contract was; 1.00 = perfectly targeted.",
        "AUC(live) excludes auto-set contracts, where folding is subtraction, not judgment.",
        "oracle gain = mean margin a perfect fold oracle would add; an upper bound, not a debt.",
    ]
    return "\n".join(lines)


def to_json(collector, elapsed, n_games):
    out = {"games": n_games, "elapsed_seconds": elapsed, "levels": {}}
    for skill in SKILL_LEVELS:
        tally = collector.tallies[skill]
        records = tally.contracts
        played = [r for r in records if not r.folded]
        n_missed, n_played, cost = missed_folds(records)
        out["levels"][skill] = {
            "params": GENERAL_STRATEGY_SKILL_PARAMS[skill],
            "seat_games": tally.seat_games,
            "auction_turns": tally.auction_turns,
            "bid_rate": tally.bids / tally.auction_turns if tally.auction_turns else 0,
            "open_rate": tally.opens / tally.opening_turns if tally.opening_turns else 0,
            "avg_bid": _mean(tally.bid_amounts),
            "contracts": len(records),
            "make_rate": sum(1 for r in played if r.made) / len(played) if played else 0,
            "fold_rate": sum(1 for r in records if r.folded) / len(records) if records else 0,
            "fold_auc": fold_auc(records),
            "avg_meld": _mean(tally.melds_at_meld_time),
            "avg_own_meld_as_bidder": _mean([r.winner_own_meld for r in records]),
            "avg_needed_folded": _mean([r.needed for r in records if r.folded]),
            "avg_needed_played": _mean([r.needed for r in played]),
            "missed_folds": n_missed,
            "played_contracts": n_played,
            "missed_fold_cost_per_contract": cost,
            "avg_margin_as_bidder": _mean([r.margin for r in records]),
        }
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--games", type=int, default=300, help="games to simulate (default: 300)")
    parser.add_argument("--seed", type=int, default=None, help="master seed for reproducibility")
    parser.add_argument("--json", type=str, default=None, help="also write raw stats to this path")
    args = parser.parse_args()

    collector, elapsed = run_profile(args.games, seed=args.seed)
    print()
    print(summarise(collector, elapsed, args.games))

    if args.json:
        with open(args.json, "w") as handle:
            json.dump(to_json(collector, elapsed, args.games), handle, indent=2)
        print(f"\nraw stats -> {args.json}")


if __name__ == "__main__":
    main()

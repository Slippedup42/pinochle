"""
Record seeded rounds from the Python engine so the TypeScript engine can be
replayed against them (issue #125, ROADMAP.md Phase 1.6).

The bug class this exists to catch is #118: two constants in
`web/src/engine/bidding.ts` had silently diverged from `pinochle_engine.py`,
changing which suit the browser names as trump, and it was found by hand months
later while doing unrelated work. Nothing in either suite would have caught it,
because each side was only ever checked against itself.

Two things this deliberately does NOT do, both of which look like the obvious
approach and are dead ends:

  Seed both engines and compare the deals. Python shuffles with
  `random.Random` (`Deck.shuffle`); the TS side reseeds `Math.random` through
  `makeRng` (`web/src/ab/headlessGame.ts`). Different PRNGs — the same seed does
  not produce the same deal and never will, no matter how the seeding is
  arranged.

  Compare what the two AIs decide. They deliberately differ: Python runs Monte
  Carlo rollouts, TS `hard`+ runs the evaluator distilled from them (#115).
  Divergence there is the design, not a bug, so a test asserting agreement would
  be asserting the opposite of what the project wants.

So the *deal and the decisions are pinned* and only the rules are compared. Each
scenario records a complete round as Python actually played it — the four dealt
hands, the auction result, the 3-card pass both ways, and every card of every
trick — plus what Python's rules made of it: meld per hand, the winner and
points of each trick, and the final round score for both teams. The TS side
replays the recorded cards through its own engine and has to arrive at the same
numbers. A recorded play the TS legal-move filter rejects is itself a failure:
that means the two filters disagree.

Two artefacts, two stages, on purpose:

  `parity_scenarios.json`               the recorded rounds (committed)
  `web/src/engine/engineParity.fixture.ts`  the same data as a typed TS module

Recording replays the AI, so it is only rerun on demand; rendering is a pure
function of the committed JSON, so `--check` can fail a stale fixture without
the answer depending on what the AI happens to decide today. That split is the
whole point: if the check re-recorded, every unrelated AI tweak would move every
scenario and the fixture would report a "failure" that is nothing of the kind.

    python export_parity_scenarios.py --record   # replay the engine, rewrite both
    python export_parity_scenarios.py            # re-render the TS from the JSON
    python export_parity_scenarios.py --check    # fail if the TS is stale
"""

import argparse
import json
import os
import random
import sys

from pinochle_engine import (
    EasyPlayer,
    Game,
    Player,
    Round,
    Suit,
    Trick,
    score_melds,
)


# ---------------------------------------------------------------------------
# Where the artefacts live.
#
# Paths are relative to this file, not to the shell's working directory - the
# same reasoning as `export_evaluator.py`: this gets run from the repo root,
# from `web/`, and from pytest, and a generator that writes somewhere different
# depending on where it was invoked from is a generator that silently leaves a
# stale copy behind.
# ---------------------------------------------------------------------------

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
SCENARIOS_JSON_PATH = os.path.join(REPO_ROOT, "parity_scenarios.json")
FIXTURE_TS_PATH = os.path.join(REPO_ROOT, "web", "src", "engine", "engineParity.fixture.ts")

FORMAT_VERSION = 1

# How many rounds get recorded. Each one is a full 12-trick round, so this is
# 1,920 legal-move filterings, 480 trick-winner resolutions and 160 meld
# scorings - enough that a rule that is only wrong in an uncommon position (a
# forced overtrump, a sluff with no trump left, a last-trick bonus landing on
# the defenders) is very likely to appear, while the generated file stays small
# enough to review as a diff.
SCENARIO_COUNT = 40

# One seed per scenario, consecutive from here. Each scenario reseeds the global
# RNG from its own seed before playing, so a scenario reproduces on its own
# rather than depending on how many random values the scenarios before it
# happened to consume.
FIRST_SEED = 1250001

# Seat tiers, cycled across scenarios. Mixing Proficient and Easy is not about
# measuring either one - the AI is pinned and never compared. It is about the
# *positions* the rules then have to resolve: Easy always plays its lowest legal
# card, which produces far more sluffing, overtrumping and lost last tricks than
# four Proficient seats ever would, and those are the branches of the legal-move
# filter that a port is most likely to get wrong.
TIER_CYCLE = (
    ("proficient", "proficient", "proficient", "proficient"),
    ("proficient", "easy", "proficient", "easy"),
    ("easy", "proficient", "easy", "proficient"),
    ("easy", "easy", "easy", "easy"),
)
TIER_CLASSES = {"proficient": Player, "easy": EasyPlayer}

# Team scores carried into the auction, cycled across scenarios. The score
# reaches the rules through the contract only - `Player.choose_bid` bids
# differently when the game is nearly over - but that is exactly the lever that
# decides whether the bidding team makes it or goes set, and the -bid branch of
# round scoring is a rule the fixture would otherwise never exercise.
SCORE_CYCLE = ((0, 0), (400, 250), (250, 400), (860, 300), (600, 600))

PASS_COUNT = 3
TRICK_COUNT = 12
LAST_TRICK_BONUS = 10


# ---------------------------------------------------------------------------
# Recording a round.
#
# The engine is instrumented rather than reimplemented. An exporter that ran its
# own deal/pass/trick loop would be a third engine to keep in sync, and the one
# it could most easily drift from is the one it is supposed to be recording.
# ---------------------------------------------------------------------------

def team_of(seat):
    """Seats 0 & 2 are team 0, seats 1 & 3 are team 1 (pinochle_rules.md).

    Matches `web/src/engine/round.ts`'s `teamOf`, which is what makes the two
    sides' team indices comparable at all.
    """
    return seat % 2


def _tokens(cards):
    """A hand as sorted `Card.__repr__` tokens, space-separated.

    Same encoding `evaluatorParity.fixture.ts` uses, and for the same reason:
    `rank + suit + '_' + copy_id` is what both `Card.__repr__` and TS's
    `Card.toString()` already produce, so the two sides agree on which cards a
    scenario means without a second encoding to keep in sync. Sorted because a
    hand is a set - only the play order below is order-sensitive.
    """
    return " ".join(sorted(repr(card) for card in cards))


class _RecordingRound(Round):
    """`Round` that snapshots each phase boundary on its way past.

    Overrides only to observe: every method calls `super()` first and then reads
    state that already exists. Nothing here changes what the round does, which
    is the property that makes the recording worth having.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.dealt_hands = None
        self.hands_after_pass = None
        self.meld_by_player = None
        self.plays = []  # (seat, Card), in the order choose_card was asked

    def _deal(self):
        super()._deal()
        self.dealt_hands = [list(p.hand) for p in self.players]

    def _passing_phase(self):
        super()._passing_phase()
        self.hands_after_pass = [list(p.hand) for p in self.players]

    def _meld_phase(self):
        super()._meld_phase()
        self.meld_by_player = [
            score_melds(p.hand, self.trump_suit) for p in self.players
        ]


def _instrument_plays(players, sink):
    """Record every card each seat plays, without touching how it chooses.

    Shadowing the bound method on the instance rather than subclassing the four
    player classes: the tiers are cycled per scenario, and a wrapper that works
    for any `Player` subclass is one thing to keep correct instead of four.
    """
    for seat, player in enumerate(players):
        original = player.choose_card

        def recorder(*args, _seat=seat, _original=original, **kwargs):
            card = _original(*args, **kwargs)
            sink.append((_seat, card))
            return card

        player.choose_card = recorder


def _received(dealt, after):
    """The cards a seat gained across the pass, as tokens.

    Derived by difference rather than by intercepting `choose_pass_cards`,
    because `run_simultaneous_pass` moves both selections atomically (#80) and
    intercepting either side of that would record a state the round never
    actually held. Every (suit, rank, copy_id) is unique in a 48-card deck, so
    comparing tokens is exact.
    """
    before = {repr(card) for card in dealt}
    return " ".join(sorted(t for t in (repr(c) for c in after) if t not in before))


def replay_tricks(hands_after_pass, trump, bid_winner, plays):
    """Re-derive the tricks from the flat play list, through the real `Trick`.

    This is the Python half of the parity check, and it runs at record time so a
    scenario that does not replay cleanly never reaches the fixture at all. It
    asserts the same three things `engineParity.test.ts` asserts on the TS side:
    that the seat asked matches the seat recorded, that the recorded card was
    legal, and that the winner and points come out of the engine's own
    `Trick.winner()`/`Trick.points()` rather than being restated by hand.

    It also records the *whole* legal-move set at each follow, not just the card
    chosen. Recording only the card would make the fixture one-directional: it
    would catch a TS filter that is stricter than Python's (a recorded card gets
    rejected) but never one that is looser, and a looser filter is the port bug
    that actually reaches a player - a browser that lets you underplay a trick
    you were required to beat. Lead positions are skipped because the legal set
    there is the whole hand on both sides by definition.

    `Trick` is agnostic about what a "player" is (it only ever hands the value
    back out of `winner()`), so seat integers go in directly.

    Returns (tricks, trick_points_by_team).
    """
    hands = [list(hand) for hand in hands_after_pass]
    tricks = []
    trick_points_by_team = [0, 0]
    leader = bid_winner
    position = 0

    for trick_number in range(TRICK_COUNT):
        trick = Trick(trump)
        seat = leader
        cards = []
        legal_follows = []
        for play_position in range(4):
            recorded_seat, card = plays[position]
            assert recorded_seat == seat, (
                f"trick {trick_number}: recorded seat {recorded_seat} but the "
                f"trick reaches seat {seat}"
            )
            legal = trick.legal_moves(hands[seat])
            assert card in legal, (
                f"trick {trick_number}: seat {seat} played {card!r}, which is "
                f"not among its legal moves {legal!r}"
            )
            if play_position > 0:
                legal_follows.append(_tokens(legal))
            hands[seat].remove(card)
            trick.play(seat, card)
            cards.append(repr(card))
            position += 1
            seat = (seat + 1) % 4

        winner = trick.winner()
        points = trick.points()
        awarded = points + (LAST_TRICK_BONUS if trick_number == TRICK_COUNT - 1 else 0)
        trick_points_by_team[team_of(winner)] += awarded
        tricks.append({
            "leader": leader,
            "cards": cards,
            # One entry per follow, so `legal_follows[i]` belongs to
            # `cards[i + 1]`. The lead has no entry - its legal set is the
            # whole hand.
            "legal_follows": legal_follows,
            "winner": winner,
            # Excludes the last-trick bonus, matching what `Trick.points()`
            # returns on both sides; the bonus shows up in the team total, so a
            # port that dropped it fails on the total rather than silently.
            "points": points,
        })
        leader = winner

    assert position == len(plays), f"{len(plays) - position} plays left unconsumed"
    return tricks, trick_points_by_team


def record_scenario(index):
    """Play one seeded round and return it as a JSON-ready dict."""
    seed = FIRST_SEED + index
    tiers = TIER_CYCLE[index % len(TIER_CYCLE)]
    team_scores = SCORE_CYCLE[index % len(SCORE_CYCLE)]
    dealer = index % 4

    # Both the AI's own randomness (partner estimates, Easy's bid noise) and the
    # shuffle come from this seed, so the scenario replays from its seed alone.
    random.seed(seed)
    players = [
        TIER_CLASSES[tier](f"S{seat}", None) for seat, tier in enumerate(tiers)
    ]
    game = Game.from_players(players)
    for team, score in zip(game.teams, team_scores):
        team.score = score

    round_ = _RecordingRound(
        game.players, game.teams, dealer, deal_rng=random.Random(seed)
    )
    _instrument_plays(game.players, round_.plays)
    round_scores = round_.run()

    assert not round_.conceded, (
        "a conceded round has no trick play to replay - Player/EasyPlayer never "
        "concede, so reaching this means the tier wiring changed"
    )

    bid_winner = game.players.index(round_.bid_winner)
    partner = (bid_winner + 2) % 4
    tricks, trick_points_by_team = replay_tricks(
        round_.hands_after_pass, round_.trump_suit, bid_winner, round_.plays
    )

    # The replay has to reproduce what the round itself scored, or the recording
    # is a transcript of some other game. Checked here so a bad scenario cannot
    # reach the fixture and be "confirmed" by the TS side agreeing with it.
    for team_index, team in enumerate(game.teams):
        assert trick_points_by_team[team_index] == team.trick_points, (
            f"replayed trick points {trick_points_by_team[team_index]} != "
            f"round's {team.trick_points} for team {team_index}"
        )

    meld_by_player = [total for total, _breakdown in round_.meld_by_player]
    meld_by_team = [0, 0]
    for seat, total in enumerate(meld_by_player):
        meld_by_team[team_of(seat)] += total

    return {
        "id": f"s{index + 1:02d}",
        "seed": seed,
        "dealer": dealer,
        "seat_tiers": list(tiers),
        "team_scores": list(team_scores),
        "dealt_hands": [_tokens(hand) for hand in round_.dealt_hands],
        "bid_winner": bid_winner,
        "bid": round_.current_bid,
        "trump": round_.trump_suit.value,
        "pass_to_bidder": _received(
            round_.dealt_hands[bid_winner], round_.hands_after_pass[bid_winner]
        ),
        "pass_to_partner": _received(
            round_.dealt_hands[partner], round_.hands_after_pass[partner]
        ),
        "hands_after_pass": [_tokens(hand) for hand in round_.hands_after_pass],
        "meld_by_player": meld_by_player,
        "meld_breakdown_by_player": [
            dict(breakdown) for _total, breakdown in round_.meld_by_player
        ],
        "meld_by_team": meld_by_team,
        "tricks": tricks,
        "trick_points_by_team": trick_points_by_team,
        "round_score_by_team": [round_scores[team] for team in game.teams],
    }


def record_scenarios(count=SCENARIO_COUNT):
    """The full artefact: every recorded scenario plus its provenance."""
    return {
        "format_version": FORMAT_VERSION,
        "issue": "#125",
        "generated_by": os.path.basename(__file__),
        "engine": "pinochle_engine.py",
        "scenario_count": count,
        "first_seed": FIRST_SEED,
        "scenarios": [record_scenario(index) for index in range(count)],
    }


# ---------------------------------------------------------------------------
# Rendering the TypeScript fixture.
#
# A generated module rather than a JSON import, for the reason `export_evaluator
# .py` spells out: `web/` type-checks with `verbatimModuleSyntax` and `noEmit`,
# and an imported JSON blob would be untyped exactly where a shape mismatch
# would hide. Typing `bidWinner` as `PlayerIndex` and `trump` as `Suit` makes a
# malformed scenario a TypeScript error instead of a runtime surprise.
# ---------------------------------------------------------------------------

def _string(value):
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def _string_list(values):
    return "[" + ", ".join(_string(v) for v in values) + "]"


def _number_list(values):
    return "[" + ", ".join(str(int(v)) for v in values) + "]"


def _record(mapping):
    """A meld breakdown as a TS object literal, key order preserved."""
    if not mapping:
        return "{}"
    return "{ " + ", ".join(
        f"{_string(name)}: {int(points)}" for name, points in mapping.items()
    ) + " }"


def _comment_block(text):
    return "\n".join(f"// {line}".rstrip() for line in text.split("\n"))


FIXTURE_HEADER = """\
GENERATED FILE — do not edit by hand.

Produced by `export_parity_scenarios.py` (issue #125) from
`parity_scenarios.json`, which the same script records by playing seeded rounds
through `pinochle_engine.py`. Re-render with
`python export_parity_scenarios.py`; `test_export_parity_scenarios.py` fails the
Python suite if this file has drifted from the JSON it claims to carry.\
"""

FIXTURE_MODULE_DOC = """\

// Complete rounds, as the *Python* engine played them, for `engineParity.test.ts`.
//
// ROADMAP.md Phase 1.6's correctness net. `web/src/engine/` is a hand port of
// `pinochle_engine.py`, and #118 is what happens without one: two Base Bid
// constants were ported at half value, the browser named a different trump
// suit for months, and it surfaced because someone happened to read both files
// side by side.
//
// What is pinned and what is checked are different things, and the distinction
// is the whole design:
//
//   Pinned — the deal, the auction result, the 3-card pass, and every card
//   played. None of it is recomputed here. The two engines cannot generate the
//   same deal (different PRNGs) and are not supposed to make the same decisions
//   (Python rolls out, TS `hard`+ runs the distilled evaluator from #115), so
//   anything derived from a decision has to be recorded rather than compared.
//
//   Checked — the rules. Meld per hand, the winner and points of every trick,
//   the last-trick bonus, and the final round score for both teams. Plus
//   legality: a recorded card that TS's `Trick.legalMoves` rejects is a
//   failure, because it means the two legal-move filters disagree.
//
// Seats are 0-3 clockwise, teams are seats 0&2 (team 0) and 1&3 (team 1) — the
// same convention as `round.ts`'s `teamOf`. Hands are sorted `Card.toString()`
// tokens; `cards` within a trick is play order, starting from that trick's
// leader.\
"""


def build_fixture_module(artefact):
    """The generated `engineParity.fixture.ts`, as a string."""
    lines = [_comment_block(FIXTURE_HEADER), FIXTURE_MODULE_DOC, ""]
    lines.append("import type { Suit } from './card'")
    lines.append("import type { PlayerIndex } from './trick'")
    lines.append("")

    lines.append(_comment_block(
        "`points` excludes the last-trick bonus, matching what `Trick.points()`\n"
        "returns on both sides. The bonus is folded into `trickPointsByTeam`\n"
        "instead, so a port that forgot it fails on the team total rather than\n"
        "being quietly absorbed into a per-trick number nobody reads."
    ))
    lines.append("export interface ParityTrick {")
    lines.append("  readonly leader: PlayerIndex")
    lines.append("  /** Play order, starting from `leader`. */")
    lines.append("  readonly cards: readonly string[]")
    lines.append("  /**")
    lines.append("   * Every card Python's `Trick.legal_moves` allowed at each follow —")
    lines.append("   * `legalFollows[i]` is the set `cards[i + 1]` was chosen from. The lead")
    lines.append("   * has no entry: its legal set is the whole hand on both sides.")
    lines.append("   *")
    lines.append("   * Recorded as a set rather than just the card played so the comparison")
    lines.append("   * runs both ways. A TS filter that is *stricter* than Python's shows up")
    lines.append("   * as a rejected play; one that is *looser* shows up only here, and it is")
    lines.append("   * the looser one that reaches a player — a browser that lets you")
    lines.append("   * underplay a trick you were required to beat.")
    lines.append("   */")
    lines.append("  readonly legalFollows: readonly string[]")
    lines.append("  readonly winner: PlayerIndex")
    lines.append("  readonly points: number")
    lines.append("}")
    lines.append("")

    lines.append(_comment_block(
        "`dealtHands` plus the two pass lists is what the TS side rebuilds\n"
        "`handsAfterPass` from, rather than trusting the recorded post-pass hands\n"
        "- so the 3-card exchange itself is checked and not merely restated."
    ))
    lines.append("export interface ParityScenario {")
    lines.append("  readonly id: string")
    lines.append("  /** Seeds both the shuffle and the AI's own randomness in Python. Replay-only; TS derives nothing from it. */")
    lines.append("  readonly seed: number")
    lines.append("  readonly dealer: PlayerIndex")
    lines.append("  readonly seatTiers: readonly string[]")
    lines.append("  /** Scores carried into the auction, per team. They reach the rules only through the contract. */")
    lines.append("  readonly teamScores: readonly number[]")
    lines.append("  readonly dealtHands: readonly string[]")
    lines.append("  readonly bidWinner: PlayerIndex")
    lines.append("  readonly bid: number")
    lines.append("  readonly trump: Suit")
    lines.append("  /** Partner -> bid winner. */")
    lines.append("  readonly passToBidder: string")
    lines.append("  /** Bid winner -> partner. */")
    lines.append("  readonly passToPartner: string")
    lines.append("  readonly handsAfterPass: readonly string[]")
    lines.append("  readonly meldByPlayer: readonly number[]")
    lines.append("  readonly meldBreakdownByPlayer: readonly Readonly<Record<string, number>>[]")
    lines.append("  readonly meldByTeam: readonly number[]")
    lines.append("  readonly tricks: readonly ParityTrick[]")
    lines.append("  /** Includes the +10 last-trick bonus. */")
    lines.append("  readonly trickPointsByTeam: readonly number[]")
    lines.append("  readonly roundScoreByTeam: readonly number[]")
    lines.append("}")
    lines.append("")

    lines.append("export const PARITY_SCENARIOS: readonly ParityScenario[] = [")
    for scenario in artefact["scenarios"]:
        lines.extend(_scenario_lines(scenario))
    lines.append("]")
    lines.append("")

    return "\n".join(lines)


def _scenario_lines(scenario):
    lines = ["  {"]
    lines.append(f"    id: {_string(scenario['id'])},")
    lines.append(f"    seed: {scenario['seed']},")
    lines.append(f"    dealer: {scenario['dealer']},")
    lines.append(f"    seatTiers: {_string_list(scenario['seat_tiers'])},")
    lines.append(f"    teamScores: {_number_list(scenario['team_scores'])},")
    lines.append("    dealtHands: [")
    for hand in scenario["dealt_hands"]:
        lines.append(f"      {_string(hand)},")
    lines.append("    ],")
    lines.append(f"    bidWinner: {scenario['bid_winner']},")
    lines.append(f"    bid: {scenario['bid']},")
    lines.append(f"    trump: {_string(scenario['trump'])},")
    lines.append(f"    passToBidder: {_string(scenario['pass_to_bidder'])},")
    lines.append(f"    passToPartner: {_string(scenario['pass_to_partner'])},")
    lines.append("    handsAfterPass: [")
    for hand in scenario["hands_after_pass"]:
        lines.append(f"      {_string(hand)},")
    lines.append("    ],")
    lines.append(f"    meldByPlayer: {_number_list(scenario['meld_by_player'])},")
    lines.append("    meldBreakdownByPlayer: [")
    for breakdown in scenario["meld_breakdown_by_player"]:
        lines.append(f"      {_record(breakdown)},")
    lines.append("    ],")
    lines.append(f"    meldByTeam: {_number_list(scenario['meld_by_team'])},")
    lines.append("    tricks: [")
    for trick in scenario["tricks"]:
        lines.append("      {")
        lines.append(f"        leader: {trick['leader']},")
        lines.append(f"        cards: {_string_list(trick['cards'])},")
        lines.append(f"        legalFollows: {_string_list(trick['legal_follows'])},")
        lines.append(f"        winner: {trick['winner']},")
        lines.append(f"        points: {trick['points']},")
        lines.append("      },")
    lines.append("    ],")
    lines.append(f"    trickPointsByTeam: {_number_list(scenario['trick_points_by_team'])},")
    lines.append(f"    roundScoreByTeam: {_number_list(scenario['round_score_by_team'])},")
    lines.append("  },")
    return lines


# ---------------------------------------------------------------------------
# Read / render / check
# ---------------------------------------------------------------------------

def read_scenarios(path=SCENARIOS_JSON_PATH):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def scenarios_json_text(artefact):
    """The committed JSON, formatted so a re-record produces a readable diff."""
    return json.dumps(artefact, indent=2, ensure_ascii=False) + "\n"


def generated_files(artefact=None):
    """{path: contents} for every file this exporter owns, from the JSON."""
    if artefact is None:
        artefact = read_scenarios()
    return {FIXTURE_TS_PATH: build_fixture_module(artefact)}


def stale_files(files):
    """Paths whose committed contents differ from what the exporter produces."""
    stale = []
    for path, contents in files.items():
        try:
            with open(path, encoding="utf-8") as handle:
                current = handle.read()
        except FileNotFoundError:
            stale.append(path)
            continue
        if current != contents:
            stale.append(path)
    return stale


def write_files(files):
    for path, contents in files.items():
        with open(path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(contents)


def main():
    parser = argparse.ArgumentParser(
        description="Record Python-engine rounds for the TS parity suite (#125)",
    )
    parser.add_argument("--record", action="store_true",
                        help="replay the engine and rewrite parity_scenarios.json as well")
    parser.add_argument("--count", type=int, default=SCENARIO_COUNT,
                        help="scenarios to record (only meaningful with --record)")
    parser.add_argument("--check", action="store_true",
                        help="exit non-zero if the committed fixture is stale, writing nothing")
    args = parser.parse_args()

    if args.check:
        stale = stale_files(generated_files())
        for path in stale:
            print(f"stale: {os.path.relpath(path, REPO_ROOT)}")
        if stale:
            print("\nRe-run `python export_parity_scenarios.py` and commit the result.")
            return 1
        print("generated files are up to date")
        return 0

    if args.record:
        artefact = record_scenarios(args.count)
        write_files({SCENARIOS_JSON_PATH: scenarios_json_text(artefact)})
        print(f"wrote {os.path.relpath(SCENARIOS_JSON_PATH, REPO_ROOT)}"
              f" ({len(artefact['scenarios'])} scenarios)")
    else:
        artefact = read_scenarios()

    files = generated_files(artefact)
    write_files(files)
    for path in files:
        print(f"wrote {os.path.relpath(path, REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

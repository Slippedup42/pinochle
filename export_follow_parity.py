"""
Record what Python's `choose_follow_card` plays, so the TypeScript follower can
be held to the same answer, position by position (issue #319).

`web/src/engine/tracker.ts`'s `chooseFollowCard` is a hand-port of
`pinochle_engine.py`'s `choose_follow_card`, and nothing compared the two
call-for-call. `engineParity.test.ts` replays scripted rounds and takes every
card played as an INPUT, so it can never notice the follower choosing a
different card. #312 shipped exactly that - `chooseFollowCard` forked on who led
the trick, TypeScript only - and it was found by reading, not by a test, then
reverted whole in #317. Since then #316 (feed-ahead) and #318 (the protecting
sluff) were hand-ported into both engines with nothing standing behind them
either. This is that guard, built the way `export_pass_parity.py` built the
passer's.

HOW THE POSITIONS ARE MADE, AND WHY THEY ARE MADE THAT WAY.

  Dealt positions come from seeded deals played out by a seeded RANDOM legal
  card at every seat - not by the AI. So a recorded position depends only on
  the deck, the seed and `Trick.legal_moves`; the answer recorded at it is the
  only thing `choose_follow_card` decides. If the positions were produced by
  the AI's own play, a change to the follower would move every later position
  of the deal as well as the answer, and `--check` would report a whole deal
  as moved when one decision changed. Random play also reaches positions a
  sensible player avoids, which is where a port is least likely to have been
  exercised by hand.

  Built positions are aimed at branches random play reaches rarely - every
  sluff card a counter, the unsecured trump with no point trump legal.

  Every position carries the whole round's played cards so far (the tracker),
  because two of the tiers read it: feed-ahead asks whether the winning card is
  boss, and the trump tier asks whether every trump is accounted for.

WHAT IS AND IS NOT COVERED.

  Covered: `choose_follow_card` - the forced beat, feed-ahead (`_feed_ahead`,
  #316), feeding a winning partner (`_feed_partner`, #164), the dump-low tier,
  the discretionary trump tier, and the free sluff (`_sluff_card`, #318), with
  both opponent-led and partner-led positions. `followParity.test.ts` replays
  each one through `chooseFollowCard`.

  Deliberately divergent, and excluded on the TypeScript side by name rather
  than by silence: #158's safe-counter selection (`safeCounterPolicy:
  'counted'`). Forced to beat with nothing but counters, the browser spends the
  cheapest counter that cannot itself be beaten in suit, and forced to
  overtrump it does the same in trump; Python spends the lowest. That is a
  TypeScript-measured addition Paul kept when #312 was reverted (web/README.md,
  "#312 reverted"). The TS test replays every position with that one field set
  to `'off'` - Python's rule - and demands total agreement; it then replays the
  shipped configuration and demands agreement everywhere except positions
  where #158's tier can fire.

  NOT covered, and it cannot be: `choose_expert_follow_card` /
  `_expert_follow_card_honest`, the follow function Python's skills 4-5 play at
  the table. The browser has no port of it - it runs the evaluator distilled
  from those rollouts - so there is no second implementation to compare.
  Positions with no tracker at all are not recorded either: both engines'
  real callers always pass one.

Two artefacts, the split `export_pass_parity.py` uses:

  `follow_parity_scenarios.json`              the recorded positions (committed)
  `web/src/engine/followParity.fixture.ts`    the same data as a typed TS module

`--check` re-records (the follower is a pure function of the position, and the
random play is seeded) and re-renders, and says which half moved.

    python export_follow_parity.py --record   # re-run the follower, rewrite both
    python export_follow_parity.py            # re-render the TS from the JSON
    python export_follow_parity.py --check    # fail if either half is stale
"""

import argparse
import json
import os
import random
import sys

from pinochle_engine import (
    POINT_RANKS,
    RANK_VALUE,
    RANKS,
    Card,
    Deck,
    PlayTracker,
    Suit,
    Trick,
    _current_winner,
    _feed_ahead,
    choose_follow_card,
)


REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
SCENARIOS_JSON_PATH = os.path.join(REPO_ROOT, "follow_parity_scenarios.json")
FIXTURE_TS_PATH = os.path.join(REPO_ROOT, "web", "src", "engine", "followParity.fixture.ts")

FORMAT_VERSION = 1

# Seeded deals, each played out to the last trick by random legal cards. Every
# follow decision with more than one legal card is recorded. Twelve deals give
# a few hundred positions - enough that every branch below turns up on both
# sides of the "who led" split without hand-building it.
DEAL_COUNT = 12
FIRST_SEED = 3190001
TRUMP_CYCLE = (Suit.SPADES, Suit.DIAMONDS, Suit.CLUBS, Suit.HEARTS)

# Seats 0-3 clockwise, partners opposite - `round.ts`'s `teamOf` and Python's
# `Round` seat teams the same way.
TEAMS = ((0, 2), (1, 3))


def team_of(seat):
    return TEAMS[seat % 2]


class Seat:
    """A seat as `choose_follow_card` sees a player: an opaque, TRUTHY object.

    Not a bare int, on purpose. `choose_follow_card` reads
    `winner_player in my_team_players if winner_player else False`, which is
    sound for the `Player` objects `play_tricks` passes and silently wrong for
    seat 0, which is falsy - partner winning from seat 0 would read as not
    winning. The first draft of this exporter fed ints and recorded exactly
    that; the TypeScript side (whose `PlayerIndex` 0 is just a number) then
    "disagreed" with a Python answer no real game produces. Equality and hash
    by index, so team membership still works.
    """

    __slots__ = ("index",)

    def __init__(self, index):
        self.index = index

    def __eq__(self, other):
        return isinstance(other, Seat) and other.index == self.index

    def __hash__(self):
        return hash(("seat", self.index))

    def __repr__(self):
        return f"Seat({self.index})"


def parse_card(token):
    """`10D_1` -> the 10 of Diamonds, first copy. Inverse of `Card.__repr__`."""
    body, copy_id = token.split("_")
    return Card(Suit(body[-1]), body[:-1], int(copy_id))


def parse_hand(tokens):
    return [parse_card(token) for token in tokens.split(" ")] if tokens else []


def _tokens(cards):
    """Space-separated `Card.__repr__` tokens, ORDER PRESERVED. Ties in both
    engines resolve by the order of `legal_moves` (Python's `min`, TS's
    `reduce` and stable `sort` all keep the first), so sorting would hide a
    port that broke ties differently."""
    return " ".join(repr(card) for card in cards)


def _trick_tokens(plays):
    """`seat:card` per play, in play order."""
    return " ".join(f"{seat}:{card!r}" for seat, card in plays)


def parse_trick(tokens):
    plays = []
    for item in tokens.split(" "):
        seat, card = item.split(":")
        plays.append((int(seat), parse_card(card)))
    return plays


# ---------------------------------------------------------------------------
# Which tier answered. Labels, not logic: the recorded `chosen` card is what
# the TS side is held to. This mirrors `choose_follow_card`'s branch structure
# only so the fixture can say what it covers and the tests can insist every
# tier is reached; `test_export_follow_parity.py` cross-checks each label
# against the helper that tier calls, so a label that stops being true fails.
# ---------------------------------------------------------------------------

BRANCHES = (
    "feed_ahead",          # forced beat, 2nd seat after an opponent's lead, winner not boss
    "forced_beat",         # every legal card beats the winner: lowest
    "partner_winning",     # feed the cheapest counter
    "dump_low",            # lowest non-point
    "dump_all_counters",   # nothing but counters legal, none forced: lowest
    "trump_secure",        # all trump, every trump accounted for: lowest
    "trump_unsecure_point",  # all trump, not secure: lowest point trump
    "trump_unsecure_low",  # all trump, not secure, no point trump legal: lowest
    "sluff_protect",       # free sluff with a counter legal that must be kept
    "sluff_no_counters",   # free sluff, nothing legal counts
    "sluff_all_counters",  # free sluff, every legal card a counter
)


def classify(hand, legal, plays, trump, team, tracker):
    lead_suit = plays[0][1].suit
    winner_seat, winner_card = _current_winner(plays, trump)
    partner_winning = winner_seat in team
    if all(c.suit == lead_suit for c in legal) and lead_suit != trump:
        forced = all(c.beats(winner_card, trump) for c in legal)
        if forced and _feed_ahead(hand, plays, team, tracker):
            return "feed_ahead"
        if forced:
            return "forced_beat"
        if partner_winning:
            return "partner_winning"
        if any(c.rank not in POINT_RANKS for c in legal):
            return "dump_low"
        return "dump_all_counters"
    if all(c.suit == trump for c in legal):
        played = sum(tracker.played_count(trump, r) for r in RANKS)
        held = sum(1 for c in hand if c.suit == trump)
        if played + held >= 12:
            return "trump_secure"
        if any(c.rank in POINT_RANKS for c in legal):
            return "trump_unsecure_point"
        return "trump_unsecure_low"
    counters = [c for c in legal if c.rank in POINT_RANKS]
    if not counters:
        return "sluff_no_counters"
    if len(counters) == len(legal):
        return "sluff_all_counters"
    return "sluff_protect"


def _record(scenario_id, source, covers, trump, seat, hand, legal, plays, played, seed=None):
    """One position, with Python's answer. `played` is every card this round
    so far, the current trick's included - what `PlayTracker` holds at the
    moment `play_tricks` asks the follower."""
    team = {Seat(s) for s in team_of(seat)}
    seated_plays = [(Seat(s), card) for s, card in plays]
    tracker = PlayTracker()
    for card in played:
        tracker.record(card)
    chosen = choose_follow_card(list(hand), list(legal), seated_plays, trump, team, tracker)
    assert chosen in legal, (scenario_id, chosen)
    leader = seated_plays[0][0]
    record = {
        "id": scenario_id,
        "source": source,
        "covers": covers,
        "trump": trump.value,
        "seat": seat,
        "team": list(team_of(seat)),
        "led_by": "partner" if leader in team else "opponent",
        "branch": classify(hand, legal, seated_plays, trump, team, tracker),
        "hand": _tokens(hand),
        "legal": _tokens(legal),
        "trick": _trick_tokens(plays),
        "played": _tokens(played),
        "chosen": repr(chosen),
    }
    if seed is not None:
        record["seed"] = seed
    return record


def dealt_positions(deal_index):
    """Every non-trivial follow position of one seeded deal, random play."""
    seed = FIRST_SEED + deal_index
    rng = random.Random(seed)
    deck = Deck()
    deck.shuffle(rng)
    hands = [deck.cards[i * 12:(i + 1) * 12] for i in range(4)]
    trump = TRUMP_CYCLE[deal_index % len(TRUMP_CYCLE)]
    leader = deal_index % 4
    played = []
    positions = []
    for trick_number in range(12):
        trick = Trick(trump)
        seat = leader
        for _ in range(4):
            hand = hands[seat]
            legal = trick.legal_moves(hand)
            if trick.plays and len(legal) > 1:
                positions.append(_record(
                    f"d{deal_index + 1:02d}t{trick_number + 1:02d}s{seat}", "deal",
                    "a randomly played deal - unbiased, and reaches positions nobody built",
                    trump, seat, hand, legal, trick.plays, played, seed=seed,
                ))
            card = rng.choice(legal)
            hand.remove(card)
            trick.play(seat, card)
            played.append(card)
            seat = (seat + 1) % 4
        leader = trick.winner()
    return positions


# Hand-built positions: (id, trump, seat, hand, trick, played-before-this-trick,
# covers). `legal` is derived with `Trick.legal_moves`, so a built position can
# never record an illegal choice set. `played` here is the cards from EARLIER
# tricks; the current trick's cards are added to it, as the tracker would hold.
BUILT_SCENARIOS = [
    ("b01", Suit.SPADES, 1, "KH_1 10C_1 AC_1", "0:QD_1", "",
     "free sluff, every legal card a counter, opponent led: shortest suit first"),
    ("b02", Suit.SPADES, 2, "AH_1 KC_1 10C_1", "0:QD_1 1:9D_1", "",
     "free sluff, every legal card a counter, partner led: suit length beats rank"),
    ("b03", Suit.SPADES, 1, "KH_1 9C_1 10C_1", "0:KD_1", "",
     "free sluff with a lone King in the shortest suit: the Clubs 9, not the King (#318)"),
    ("b04", Suit.HEARTS, 3, "KD_1 JC_1 QC_1 AC_1", "1:9S_1 2:AS_1", "",
     "free sluff after partner led and an opponent took it over: counters still protected"),
    ("b05", Suit.SPADES, 1, "JS_1 QS_1 9S_1", "0:AD_1", "",
     "ruff, trump not secure, no point trump legal: lowest trump"),
    ("b06", Suit.SPADES, 3, "JS_1 QS_1 KS_1", "1:AD_1 2:10D_1", "",
     "ruff after partner led, trump not secure: surrender the King"),
    ("b07", Suit.SPADES, 1, "9S_1 KS_1 10S_1", "0:AD_1",
     "AS_1 AS_2 10S_2 KS_2 QS_1 QS_2 JS_1 JS_2 9S_2",
     "ruff with every trump accounted for: lowest trump, conserve control"),
    ("b08", Suit.CLUBS, 1, "QD_1 KD_1", "0:JD_1", "",
     "feed-ahead: second seat after an opponent's beatable Jack, forced to beat - the King, not the Queen"),
    ("b09", Suit.CLUBS, 1, "QD_1 KD_1", "0:JD_1", "QD_2 KD_2 10D_1 10D_2 AD_1 AD_2",
     "no feed-ahead: the opponent's Jack is boss once every higher Diamond is seen - beat with the Queen"),
    ("b10", Suit.CLUBS, 2, "KD_1 AD_1", "0:QD_1 1:JD_1", "",
     "forced beat, nothing but counters, a seat still to play: #158's position in suit"),
    ("b11", Suit.CLUBS, 3, "10D_1 AD_1", "1:9D_1 2:KD_1", "",
     "forced beat in the last seat after partner led and was beaten: lowest counter"),
    ("b12", Suit.HEARTS, 2, "QC_2 10C_1 AC_2", "0:AC_1 1:9C_1", "",
     "partner led the Ace and is winning: feed the 10 - not the Queen, never the second Ace"),
    ("b13", Suit.SPADES, 2, "KS_1 AS_1", "0:AD_1 1:QS_1", "",
     "forced overtrump with nothing but counters, a seat still to play: #158's position in trump"),
    ("b14", Suit.HEARTS, 2, "KC_1 10C_1", "0:QC_1 1:AC_1", "",
     "partner led, an opponent's Ace on top, nothing but counters and none can beat it: lowest"),
    ("b15", Suit.SPADES, 2, "9S_1 KS_1 10S_1", "0:AD_1 1:9D_1",
     "AS_1 AS_2 10S_2 KS_2 QS_1 QS_2 JS_1 JS_2 9S_2",
     "partner led and is winning, void and forced to trump, every trump accounted for: lowest"),
]


def built_positions():
    positions = []
    for scenario_id, trump, seat, hand_tokens, trick_tokens, earlier, covers in BUILT_SCENARIOS:
        hand = parse_hand(hand_tokens)
        plays = parse_trick(trick_tokens)
        trick = Trick(trump)
        for player, card in plays:
            trick.play(player, card)
        legal = trick.legal_moves(hand)
        assert len(legal) > 1, (scenario_id, legal)
        played = parse_hand(earlier) + [card for _, card in plays]
        positions.append(_record(
            scenario_id, "built", covers, trump, seat, hand, legal, plays, played,
        ))
    return positions


def build_scenarios():
    """Every position, recorded from the engine. Deterministic: the deals and
    the random play come from per-deal seeds and the follower consumes no
    randomness, which is what lets `--check` re-record."""
    scenarios = []
    for deal_index in range(DEAL_COUNT):
        scenarios.extend(dealt_positions(deal_index))
    scenarios.extend(built_positions())
    return scenarios


def build_artefact():
    scenarios = build_scenarios()
    return {
        "format_version": FORMAT_VERSION,
        "issue": "#319",
        "generated_by": os.path.basename(__file__),
        "engine": "pinochle_engine.py",
        "functions": [
            "choose_follow_card",
            "_feed_ahead",
            "_feed_partner",
            "_sluff_card",
        ],
        "first_seed": FIRST_SEED,
        "deal_count": DEAL_COUNT,
        "scenario_count": len(scenarios),
        "scenarios": scenarios,
    }


# ---------------------------------------------------------------------------
# Rendering the TypeScript fixture - a typed module, not a JSON import, for the
# reason `export_evaluator.py` gives: `web/` type-checks with `noEmit` and an
# untyped blob would hide a shape mismatch exactly where it matters.
# ---------------------------------------------------------------------------

def _string(value):
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def _comment_block(text):
    return "\n".join(f"// {line}".rstrip() for line in text.split("\n"))


FIXTURE_HEADER = """\
GENERATED FILE — do not edit by hand.

Produced by `export_follow_parity.py` (issue #319) from
`follow_parity_scenarios.json`, which the same script records by asking
`pinochle_engine.py`'s `choose_follow_card` at each position. Re-render with
`python export_follow_parity.py`; `test_export_follow_parity.py` fails the
Python suite if this file has drifted from the JSON, or if the JSON has drifted
from the engine.\
"""

FIXTURE_MODULE_DOC = """\

// What the *Python* follower plays, for `followParity.test.ts` (#319).
//
// `engineParity.fixture.ts` replays whole rounds but takes every card played
// as an INPUT, so it cannot see the follower choose differently. #312 forked
// `chooseFollowCard` on who led, TypeScript only, and nothing went red. This
// file records the follow card as an ANSWER: same hand, same legal set, same
// trick, same cards seen - `tracker.ts` has to play the same card.
//
// Dealt positions come from seeded deals played out by random legal cards, so
// a position depends only on the rules and the seed; the recorded `chosen` is
// the one thing the follower decides. Built positions reach the branches
// random play rarely does. `branch` names the tier that answered in Python and
// is there for coverage and for failure messages - the card is the assertion.
//
// `legal` and `hand` are in the order Python held them. Both engines break
// ties by that order (first minimum wins), so it is part of the position.
//
// #158's safe-counter selection is TypeScript-only and deliberately kept (see
// `followParity.test.ts`); Python's `choose_expert_follow_card` has no port and
// is not recorded here.\
"""


def build_fixture_module(artefact):
    lines = [_comment_block(FIXTURE_HEADER), FIXTURE_MODULE_DOC, ""]
    lines.append("import type { Suit } from './card'")
    lines.append("import type { PlayerIndex } from './trick'")
    lines.append("")
    lines.append("export const FOLLOW_PARITY_BRANCHES = [")
    for branch in BRANCHES:
        lines.append(f"  {_string(branch)},")
    lines.append("] as const")
    lines.append("export type FollowParityBranch = (typeof FOLLOW_PARITY_BRANCHES)[number]")
    lines.append("")
    lines.append("export interface FollowParityScenario {")
    lines.append("  readonly id: string")
    lines.append("  /** `'deal'` for a randomly played seeded deal, `'built'` for a position aimed at one tier. */")
    lines.append("  readonly source: 'deal' | 'built'")
    lines.append("  readonly covers: string")
    lines.append("  readonly trump: Suit")
    lines.append("  /** The seat following. */")
    lines.append("  readonly seat: PlayerIndex")
    lines.append("  /** This seat and its partner. */")
    lines.append("  readonly team: readonly PlayerIndex[]")
    lines.append("  readonly ledBy: 'partner' | 'opponent'")
    lines.append("  /** Which tier of `choose_follow_card` answered, in Python. */")
    lines.append("  readonly branch: FollowParityBranch")
    lines.append("  /** `Card.toString()` tokens in Python's order. */")
    lines.append("  readonly hand: string")
    lines.append("  readonly legal: string")
    lines.append("  /** `seat:card` per play so far this trick, in play order. */")
    lines.append("  readonly trick: string")
    lines.append("  /** Every card played this round so far, this trick's included — the tracker. */")
    lines.append("  readonly played: string")
    lines.append("  /** The card Python plays. */")
    lines.append("  readonly chosen: string")
    lines.append("}")
    lines.append("")
    lines.append("export const FOLLOW_PARITY_SCENARIOS: readonly FollowParityScenario[] = [")
    for scenario in artefact["scenarios"]:
        lines.append(
            "  { "
            f"id: {_string(scenario['id'])}, "
            f"source: {_string(scenario['source'])}, "
            f"covers: {_string(scenario['covers'])}, "
            f"trump: {_string(scenario['trump'])}, "
            f"seat: {scenario['seat']}, "
            f"team: [{', '.join(str(s) for s in scenario['team'])}], "
            f"ledBy: {_string(scenario['led_by'])}, "
            f"branch: {_string(scenario['branch'])}, "
            f"hand: {_string(scenario['hand'])}, "
            f"legal: {_string(scenario['legal'])}, "
            f"trick: {_string(scenario['trick'])}, "
            f"played: {_string(scenario['played'])}, "
            f"chosen: {_string(scenario['chosen'])} "
            "},"
        )
    lines.append("]")
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Read / render / check
# ---------------------------------------------------------------------------

def read_scenarios(path=SCENARIOS_JSON_PATH):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def scenarios_json_text(artefact):
    return json.dumps(artefact, indent=2, ensure_ascii=False) + "\n"


def generated_files(artefact=None):
    if artefact is None:
        artefact = read_scenarios()
    return {FIXTURE_TS_PATH: build_fixture_module(artefact)}


def stale_files(files):
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


POSITION_FIELDS = ("hand", "legal", "trick", "played", "chosen")


def moved_scenarios(committed, rebuilt):
    """`(id, recorded, now)` for every position whose recorded card - or whose
    position itself - is not what re-recording produces. The position is
    compared too: a change to `Trick.legal_moves` moves the random play, and
    that is a rules change this fixture should not absorb silently either."""
    now = {s["id"]: s for s in rebuilt}
    moved = []
    for scenario in committed:
        fresh = now.pop(scenario["id"], None)
        if fresh is None:
            moved.append((scenario["id"], scenario["chosen"], "(no longer recorded)"))
        elif any(fresh[f] != scenario[f] for f in POSITION_FIELDS):
            moved.append((scenario["id"], scenario["chosen"], fresh["chosen"]))
    for scenario_id, fresh in now.items():
        moved.append((scenario_id, "(not in the committed record)", fresh["chosen"]))
    return moved


def format_check_report(committed_artefact, rebuilt_scenarios, stale):
    """`(ok, report)`. The two halves fail for different reasons and want
    different fixes, so each names its own cause - the reasoning
    `export_pass_parity.py`'s report spells out."""
    committed = committed_artefact["scenarios"]
    moved = moved_scenarios(committed, rebuilt_scenarios)
    lines = [f"{len(committed)} recorded positions, {len(rebuilt_scenarios)} rebuilt from the engine"]

    if not moved and not stale:
        lines += ["", "choose_follow_card still plays what follow_parity_scenarios.json "
                  "says it plays, and web/src/engine/followParity.fixture.ts is what "
                  "this renderer produces from it. `followParity.test.ts` is holding "
                  "chooseFollowCard to a live answer."]
        return True, "\n".join(lines)

    if moved:
        lines += ["", f"THE RECORD MOVED - {len(moved)} position(s) differ now:"]
        for scenario_id, recorded, now in moved[:12]:
            lines.append(f"  {scenario_id}: recorded {recorded} -> now {now}")
        if len(moved) > 12:
            lines.append(f"  ... and {len(moved) - 12} more")
        lines += [
            "",
            "WHAT THIS MEANS. `pinochle_engine.py`'s `choose_follow_card` (or a "
            "helper under it - `_feed_ahead`, `_feed_partner`, `_sluff_card` - or "
            "`Trick.legal_moves`, which the random play runs through) no longer "
            "gives what was recorded. If you changed it on purpose:",
            "",
            "  1. Change `web/src/engine/tracker.ts`'s `chooseFollowCard` to match, "
            "or record in `followParity.test.ts` why the browser deliberately differs.",
            "  2. `python export_follow_parity.py --record`, and commit both files.",
            "  3. `cd web && npm test -- --run followParity` to confirm the TS side moved too.",
            "",
            "DO NOT re-record without step 1. Re-recording hands the TypeScript "
            "side a fresh answer to agree with, so the suite goes green whether or "
            "not `tracker.ts` was touched - the blindness #319 exists to remove.",
        ]

    if stale:
        lines += ["", "THE GENERATED FIXTURE IS STALE:"]
        lines += [f"  {os.path.relpath(path, REPO_ROOT)}" for path in stale]
        lines += [
            "",
            "This half says nothing about the engine: the committed TypeScript is "
            "not what this renderer produces from the committed JSON (hand-edited, "
            "or re-recorded without re-rendering). Run "
            "`python export_follow_parity.py` and commit the result.",
        ]

    return False, "\n".join(lines)


def check(artefact=None):
    """Both halves, `(ok, report)`. Cheap - a few hundred pure-function calls
    over twelve seeded deals - so it sits in the suite unconditionally."""
    if artefact is None:
        artefact = read_scenarios()
    rebuilt = build_scenarios()
    stale = stale_files(generated_files(artefact))
    return format_check_report(artefact, rebuilt, stale)


def main():
    parser = argparse.ArgumentParser(
        description="Record Python's choose_follow_card for the TS parity suite (#319)",
    )
    parser.add_argument("--record", action="store_true",
                        help="re-run the follower and rewrite follow_parity_scenarios.json as well")
    parser.add_argument("--check", action="store_true",
                        help="exit non-zero if the record or the fixture is stale, writing nothing")
    args = parser.parse_args()

    if args.check:
        ok, report = check()
        print(report)
        return 0 if ok else 1

    if args.record:
        artefact = build_artefact()
        write_files({SCENARIOS_JSON_PATH: scenarios_json_text(artefact)})
        print(f"wrote {os.path.relpath(SCENARIOS_JSON_PATH, REPO_ROOT)}"
              f" ({len(artefact['scenarios'])} positions)")
    else:
        artefact = read_scenarios()

    files = generated_files(artefact)
    write_files(files)
    for path in files:
        print(f"wrote {os.path.relpath(path, REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

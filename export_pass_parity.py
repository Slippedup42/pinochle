"""
Record what Python's 3-card pass chooses, so the TypeScript passer can be held
to the same answer (issue #279).

`engineParity.test.ts` already replays whole Python rounds through the TS rules
engine, but it takes the recorded pass as an *input*: it moves the three cards
Python moved and checks the meld, the tricks and the score that follow. It never
asks whether the TS passer would have chosen those three cards. So the two
engines' pass selection could diverge permanently and that net would stay green,
because it only ever replays one side's choice through the other side's rules.
#276 moved 2 of 40 recorded scenarios and #280 moved 17 with 12 changing a round
score; the suite was green throughout, correctly, and would have been just as
green if only one engine had moved.

Pass selection is the largest hand-ported surface with nothing standing behind
it: two tiered priority lists, nine tiers each, several predicates per tier, and
a category split (D/S vs H/C) on top. `export_parity_scenarios.py --check`
guards the recorded rounds and `export_evaluator.py --check` guards the fitted
model; the passer sits between them, uncovered. This is that guard.

WHAT IS AND IS NOT COVERED HERE.

  Covered: `_partner_pass_selection` and `_bidder_pass_selection`, plus the
  category split in `Player.choose_pass_cards` - the whole shipped Proficient
  path, and the exact code `passing.ts`'s `partnerPassSelection` /
  `bidderPassSelection` / `choosePassCards` were ported from.

  NOT covered, and it cannot be: the expert-tier pass logic further down
  `pinochle_engine.py` - `choose_forward_pass_cards`, its tier-0/tier-1 rules
  and the knapsack `choose_return_pass_cards`. That is Python-only research
  code (issue #61) with no TypeScript counterpart at all, so there is no second
  implementation to compare it against. It is stated here rather than left
  looking covered by a file with "pass parity" in its name.

  Also not covered: `EasyPlayer.choose_pass_cards`. It has a TS counterpart
  (`choosePassCards`'s `meld_only` arm) but that arm is unreachable in the
  browser - `SHIPPED_SKILL` is `base_bid` - and adding it would double the
  fixture to guard a path no player meets. Filed as a note, not built.

ORDER OR SET. The tiers build an ordered list, but only the chosen three matter:
`run_simultaneous_pass` moves all three at once and nothing downstream can tell
which tier produced which card. So `passParity.test.ts` compares the two engines
as SETS of card tokens. The order is still recorded here, because it is free and
it makes a tier reordering visible in the `--record` diff even when the same
three cards come out - but a TS/Python disagreement about the order alone is not
a bug this suite should fail on, and a set comparison is also what makes the
check robust to a tie-break that happens to differ. What a set comparison does
NOT weaken: any tier change that swaps which card is chosen changes the set.

Two artefacts, two stages, the same split `export_parity_scenarios.py` uses:

  `pass_parity_scenarios.json`               the recorded passes (committed)
  `web/src/engine/passParity.fixture.ts`     the same data as a typed TS module

Rendering is a pure function of the committed JSON, so a hand-edited fixture is
caught without re-running anything. Recording calls the engine, so a changed
passer is caught too - and unlike `export_parity_scenarios.py`, which cannot
re-record in a check because its recording replays the AI, this one can: the
pass is a deterministic pure function of twelve cards, a trump suit and a role.
`--check` therefore runs both halves and says which one moved, because "Python
moved and TS did not" and "someone edited the fixture" want completely different
fixes.

    python export_pass_parity.py --record   # re-run the passer, rewrite both
    python export_pass_parity.py            # re-render the TS from the JSON
    python export_pass_parity.py --check    # fail if either half is stale
"""

import argparse
import json
import os
import random
import sys

from pinochle_engine import Card, Deck, Player, Suit


# ---------------------------------------------------------------------------
# Where the artefacts live.
#
# Paths are relative to this file, not to the shell's working directory - the
# same reasoning `export_parity_scenarios.py` and `export_evaluator.py` give:
# this gets run from the repo root, from `web/` and from pytest, and a generator
# that writes somewhere different depending on where it was invoked from is a
# generator that silently leaves a stale copy behind.
# ---------------------------------------------------------------------------

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
SCENARIOS_JSON_PATH = os.path.join(REPO_ROOT, "pass_parity_scenarios.json")
FIXTURE_TS_PATH = os.path.join(REPO_ROOT, "web", "src", "engine", "passParity.fixture.ts")

FORMAT_VERSION = 1

# Three each way, per pinochle_rules.md. Imported rather than restated on the TS
# side, where `PASS_COUNT` is exported from `passing.ts`.
PASS_COUNT = 3

# Deal-derived scenarios: one seeded 48-card shuffle per seed, all four hands
# used. Random hands are what stops the fixture from being only the cases
# somebody thought of, and they are also where the tie-breaks live - a dealt
# hand arrives in shuffle order, so two cards with equal sort keys resolve by
# an order nobody chose.
DEAL_SEED_COUNT = 10
FIRST_SEED = 2790001

# (trump, role) cycled across the dealt hands so all four trump suits and both
# roles get an equal share. Four suits x two roles divides 40 hands evenly,
# which is the only reason the counts above are what they are.
_COMBINATIONS = [
    (suit, role)
    for role in ("bidder", "partner")
    for suit in (Suit.SPADES, Suit.DIAMONDS, Suit.CLUBS, Suit.HEARTS)
]


def category_for(trump):
    """`Player.choose_pass_cards`'s split, restated.

    Restated rather than imported because it is not a function over there - it
    is one line inside `choose_pass_cards` - and because the recorded pass below
    goes through that method, so if the two ever disagree the recorded pass
    stops matching the recorded category and `test_export_pass_parity.py` says
    so. `passing.ts` derives the same category from the same rule, which is
    itself a ported constant of exactly #118's kind.
    """
    return "DS" if trump in (Suit.SPADES, Suit.DIAMONDS) else "HC"


def parse_card(token):
    """`10D_1` -> the 10 of Diamonds, first copy. Inverse of `Card.__repr__`,
    and the same encoding `evaluatorParity.fixture.ts` and
    `engineParity.fixture.ts` use."""
    body, copy_id = token.split("_")
    return Card(Suit(body[-1]), body[:-1], int(copy_id))


def parse_hand(tokens):
    return [parse_card(token) for token in tokens.split(" ")] if tokens else []


def _tokens(cards):
    """Cards as `Card.__repr__` tokens, space-separated, ORDER PRESERVED.

    Deliberately not sorted, which is the one place this differs from
    `engineParity.fixture.ts`'s hands. Both `_take` and `_take_spread` sort
    stably and then take in order, so equal-keyed cards are resolved by the
    order the hand arrives in. A fixture that sorted the hand would be feeding
    the two engines a tie-break they never see in play, and would hide a port
    that resolved ties differently.
    """
    return " ".join(repr(card) for card in cards)


# ---------------------------------------------------------------------------
# The hands.
#
# Two sources, because neither alone is enough. Dealt hands are unbiased and
# reach the tie-breaks; they also overwhelmingly stop at the first tier or two,
# so on their own they would leave most of both priority lists untested. The
# built hands below are aimed at the specific things the tiers branch on.
# ---------------------------------------------------------------------------

def dealt_hands(seed):
    """The four 12-card hands of one seeded deal, in deal order.

    Sliced the way `Deck.deal` slices rather than by running a `Round`: the
    round would need an auction, and an auction would make the recorded hands
    move every time the bidding AI changed - which is the failure mode the whole
    two-stage split exists to avoid. Nothing about a pass depends on how the
    hand was won.
    """
    deck = Deck()
    deck.shuffle(random.Random(seed))
    return [deck.cards[i * 12:(i + 1) * 12] for i in range(4)]


# Hand-built scenarios, each aimed at a branch that random deals reach rarely or
# never. `covers` is carried into the JSON so the fixture says what each case is
# for, and `test_export_pass_parity.py` asserts the list below still covers the
# branches it claims - a scenario whose label stops being true is worse than no
# label.
BUILT_SCENARIOS = [
    # ---- partner ----
    (
        "partner-ds-qs-jd",
        "partner", Suit.DIAMONDS,
        "QS_1 JD_1 AD_1 KD_1 9C_1 9C_2 JC_1 QC_1 KC_1 10H_1 AH_1 9H_1",
        "tier 1: the D/S-only Q(S)/J(D) tier, which never runs in Hearts or Clubs",
    ),
    (
        "partner-hc-trump-spread",
        "partner", Suit.HEARTS,
        "KH_1 KH_2 QH_1 JH_1 AS_1 10S_1 KS_1 QD_1 JD_1 9C_1 10C_1 QC_1",
        "#280's trump spread: K-K-Q-J of trump sends K, Q and J and keeps the spare King",
    ),
    (
        "partner-ds-qs-is-also-trump",
        "partner", Suit.SPADES,
        "QS_1 JS_1 KS_1 KS_2 AH_1 10H_1 KH_1 9D_1 9D_2 10D_1 9C_1 JC_1",
        "tier 1 and the trump tiers overlapping - with Spades trump, Q(S) is both",
    ),
    (
        "partner-nontrump-aces-singleton-first",
        "partner", Suit.HEARTS,
        "9H_1 AS_1 AS_2 AC_1 AD_1 KD_1 QD_1 JD_1 9D_1 KC_1 QC_1 JC_1",
        "tier 4's sort: a singleton Ace goes before either half of a pair",
    ),
    (
        "partner-leftover-trump-then-dix",
        "partner", Suit.CLUBS,
        "KC_1 KC_2 9C_1 10S_1 KS_1 QS_1 JS_1 10D_1 KD_1 QD_1 10H_1 KH_1",
        "tiers 5 and 6: the duplicate the spread declined, then the 9 of trump",
    ),
    (
        "partner-void-opportunity",
        "partner", Suit.HEARTS,
        "QD_1 JD_1 9D_1 10S_1 KS_1 QS_1 JS_1 9S_1 KC_1 QC_1 JC_1 10C_1",
        "tier 7: a whole three-card side suit leaves together rather than scattering",
    ),
    (
        "partner-filler-order",
        "partner", Suit.HEARTS,
        "KS_1 QS_1 JS_1 10S_1 KD_1 QD_1 JD_1 10D_1 KC_1 QC_1 JC_1 10C_1",
        "tier 9's J-10-Q-K order, on a hand with no trump, no Ace and no 9 to reach it with",
    ),
    (
        "partner-protected-ten-has-no-exception",
        "partner", Suit.HEARTS,
        "AC_1 AC_2 10C_1 KC_1 KS_1 QS_1 10S_1 10S_2 KD_1 QD_1 10D_1 10D_2",
        "#276's 10 is NOT held back by the partner: both its Aces have already gone in tier 4",
    ),
    # ---- bidder ----
    (
        "bidder-hc-qs-jd-then-ten",
        "bidder", Suit.HEARTS,
        "QS_1 JD_1 AH_1 KH_1 QH_1 JH_1 10H_1 9H_1 AS_1 10S_1 KC_1 QC_1",
        "tier 1 (H/C only), then tier 4 once the K/Q are locked in a marriage",
    ),
    (
        "bidder-protected-ten-survives-the-void-tier",
        "bidder", Suit.HEARTS,
        "AC_1 AC_2 10C_1 AH_1 KH_1 QH_1 JH_1 9H_1 KS_1 9S_1 JD_1 10D_1",
        "#276: A-A-10 of Clubs is excluded from tier 2, so the void is built elsewhere",
    ),
    (
        "bidder-unprotected-ten-goes-protected-ten-stays",
        "bidder", Suit.HEARTS,
        "AC_1 AC_2 10C_1 10S_1 KS_1 QS_1 JS_1 AH_1 KH_1 QH_1 JH_1 9H_1",
        "#276: tier 4 ships the bare 10(S) and skips the 10(C) two Aces are standing behind",
    ),
    (
        "bidder-hc-low-trump-last-resort",
        "bidder", Suit.HEARTS,
        "QS_1 JD_1 AH_1 AH_2 10H_1 10H_2 KH_1 KH_2 QH_1 QH_2 JH_1 9H_1",
        "tier 8: nothing unprotected is left, so a trump J goes - Hearts/Clubs only",
    ),
    (
        "bidder-ds-has-no-low-trump-tier",
        "bidder", Suit.DIAMONDS,
        "QS_1 JD_1 AD_1 AD_2 10D_1 10D_2 KD_1 KD_2 QD_1 QD_2 JD_2 9D_1",
        "the same shape in Diamonds: tier 8 is skipped and tier 9's last resort runs instead",
    ),
    (
        "bidder-marriage-and-around-hold-a-king-back",
        "bidder", Suit.HEARTS,
        "KS_1 KD_1 KC_1 KH_1 QS_1 QD_1 9C_1 9D_1 10C_1 AH_1 10H_1 JH_1",
        "tier 3's two exclusions together: Kings Around and a K-Q marriage both veto a spare",
    ),
    (
        "bidder-ds-void-opportunity",
        "bidder", Suit.SPADES,
        "AS_1 KS_1 QS_1 JS_1 9H_1 10H_1 KH_1 AD_1 10D_1 AC_1 KC_1 QC_1",
        "tier 2 in the D/S category, where an Ace in the other two side suits blocks them",
    ),
]


# ---------------------------------------------------------------------------
# Recording.
# ---------------------------------------------------------------------------

def choose_pass(hand, trump, role):
    """What the shipped Proficient Python passer sends, for this hand and role.

    Routed through `Player.choose_pass_cards` rather than calling
    `_partner_pass_selection` / `_bidder_pass_selection` directly, on purpose:
    the category split and the short-pass fallback live in the method, and they
    are ported to `choosePassCards` on the other side. Calling the tier
    functions straight would record the tiers and quietly skip the two lines
    above them. `test_export_pass_parity.py` calls the tier functions with the
    recorded category and checks it lands in the same place, which is what pins
    the category down as well as the tiers.
    """
    player = Player("recorder", None)
    player.receive_cards(list(hand))
    return player.choose_pass_cards(PASS_COUNT, trump, role == "bidder")


def _scenario(scenario_id, source, hand, trump, role, covers, seed=None):
    chosen = choose_pass(hand, trump, role)
    assert len(chosen) == PASS_COUNT, (scenario_id, chosen)
    assert len(set(repr(c) for c in chosen)) == PASS_COUNT, (scenario_id, chosen)
    record = {
        "id": scenario_id,
        "source": source,
        "covers": covers,
        "hand": _tokens(hand),
        "trump": trump.value,
        "role": role,
        "category": category_for(trump),
        "passed": _tokens(chosen),
    }
    if seed is not None:
        record["seed"] = seed
    return record


def build_scenarios():
    """Every scenario, recorded from the engine. Deterministic: the deals come
    from their own seeds and the passer consumes no randomness on this path, so
    two runs of this function on the same engine are identical, which is what
    lets `--check` re-record rather than only re-render."""
    scenarios = []

    for index in range(DEAL_SEED_COUNT):
        seed = FIRST_SEED + index
        for seat, hand in enumerate(dealt_hands(seed)):
            trump, role = _COMBINATIONS[(index * 4 + seat) % len(_COMBINATIONS)]
            scenarios.append(_scenario(
                f"d{index * 4 + seat + 1:02d}", "deal", hand, trump, role,
                "a dealt hand - unbiased, and where the tie-breaks live",
                seed=seed,
            ))

    for scenario_id, role, trump, hand_tokens, covers in BUILT_SCENARIOS:
        scenarios.append(_scenario(
            scenario_id, "built", parse_hand(hand_tokens), trump, role, covers,
        ))

    return scenarios


def build_artefact():
    """The full committed record: every scenario plus its provenance."""
    scenarios = build_scenarios()
    return {
        "format_version": FORMAT_VERSION,
        "issue": "#279",
        "generated_by": os.path.basename(__file__),
        "engine": "pinochle_engine.py",
        "functions": [
            "Player.choose_pass_cards",
            "_partner_pass_selection",
            "_bidder_pass_selection",
        ],
        "pass_count": PASS_COUNT,
        "scenario_count": len(scenarios),
        "first_seed": FIRST_SEED,
        "scenarios": scenarios,
    }


# ---------------------------------------------------------------------------
# Rendering the TypeScript fixture.
#
# A generated module rather than a JSON import, for the reason `export_evaluator
# .py` spells out: `web/` type-checks with `verbatimModuleSyntax` and `noEmit`,
# and an imported JSON blob would be untyped exactly where a shape mismatch
# would hide. Typing `trump` as `Suit` and `role` as a union makes a malformed
# scenario a TypeScript error rather than a test that quietly passes nothing.
# ---------------------------------------------------------------------------

def _string(value):
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def _comment_block(text):
    return "\n".join(f"// {line}".rstrip() for line in text.split("\n"))


FIXTURE_HEADER = """\
GENERATED FILE — do not edit by hand.

Produced by `export_pass_parity.py` (issue #279) from
`pass_parity_scenarios.json`, which the same script records by running
`pinochle_engine.py`'s passer over each hand. Re-render with
`python export_pass_parity.py`; `test_export_pass_parity.py` fails the Python
suite if this file has drifted from the JSON, or if the JSON has drifted from
the engine.\
"""

FIXTURE_MODULE_DOC = """\

// What the *Python* passer sends, for `passParity.test.ts` (#279).
//
// `engineParity.fixture.ts` records complete rounds and the TS engine replays
// them - but it replays the recorded 3-card pass as an INPUT. It moves the
// three cards Python moved and checks the meld, the tricks and the score that
// follow; it never asks whether this engine would have chosen those three
// cards. #276 moved two of its recorded passes and #280 moved seventeen, and it
// stayed green throughout - correctly, because both engines moved together.
// Nothing would have said if only one had.
//
// So this file records the pass as an ANSWER. Same hand, same trump, same role,
// same category: `passing.ts` has to return the same three cards.
//
// Compared as a SET, not as a list. The tiers produce an ordered selection, but
// `run_simultaneous_pass` moves all three at once and nothing downstream can
// tell which tier produced which card, so an order-only disagreement is not a
// bug worth failing on. `passed` below is nevertheless recorded in tier order,
// because it costs nothing and it makes a reordering visible in the diff when
// the same three cards still come out.
//
// NOT covered here, and it cannot be: Python's expert-tier pass logic
// (`choose_forward_pass_cards`, its tier-0/tier-1 rules and the knapsack
// `choose_return_pass_cards`, issue #61). That is research code with no
// TypeScript counterpart, so there is no second implementation to compare it
// against - it is unported, not merely untested.
//
// Hands are `Card.toString()` tokens IN DEAL ORDER, not sorted. Both engines
// sort stably inside each tier and then take in order, so equal-keyed cards are
// resolved by the order the hand arrives in; sorting the hand here would feed
// them a tie-break they never see in play.\
"""


def build_fixture_module(artefact):
    """The generated `passParity.fixture.ts`, as a string."""
    lines = [_comment_block(FIXTURE_HEADER), FIXTURE_MODULE_DOC, ""]
    lines.append("import type { Suit } from './card'")
    lines.append("import type { PassCategory } from './passing'")
    lines.append("")

    lines.append("export interface PassParityScenario {")
    lines.append("  readonly id: string")
    lines.append("  /** `'deal'` for a seeded shuffle, `'built'` for a hand aimed at one tier. */")
    lines.append("  readonly source: string")
    lines.append("  /** What this scenario is in the fixture for. */")
    lines.append("  readonly covers: string")
    lines.append("  /** Twelve `Card.toString()` tokens in deal order — see the note above on why not sorted. */")
    lines.append("  readonly hand: string")
    lines.append("  readonly trump: Suit")
    lines.append("  readonly role: 'bidder' | 'partner'")
    lines.append("  /** Python's own D/S vs H/C split, recorded so this side's copy of that rule is checked too. */")
    lines.append("  readonly category: PassCategory")
    lines.append("  /** The three cards Python sent, in tier order. Compared as a set. */")
    lines.append("  readonly passed: string")
    lines.append("}")
    lines.append("")

    lines.append(f"export const PASS_PARITY_PASS_COUNT = {artefact['pass_count']}")
    lines.append("")

    lines.append("export const PASS_PARITY_SCENARIOS: readonly PassParityScenario[] = [")
    for scenario in artefact["scenarios"]:
        lines.extend(_scenario_lines(scenario))
    lines.append("]")
    lines.append("")

    return "\n".join(lines)


def _scenario_lines(scenario):
    return [
        "  {",
        f"    id: {_string(scenario['id'])},",
        f"    source: {_string(scenario['source'])},",
        f"    covers: {_string(scenario['covers'])},",
        f"    hand: {_string(scenario['hand'])},",
        f"    trump: {_string(scenario['trump'])},",
        f"    role: {_string(scenario['role'])},",
        f"    category: {_string(scenario['category'])},",
        f"    passed: {_string(scenario['passed'])},",
        "  },",
    ]


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


def moved_scenarios(committed, rebuilt):
    """Scenarios whose recorded pass is not what the engine returns now.

    Returns a list of `(id, recorded, now)`. Keyed by id and compared as sets,
    matching what `passParity.test.ts` asserts - a fixture that failed the
    Python check on an ordering the TS check tolerates would be a guard firing
    for something it does not believe in.
    """
    now = {scenario["id"]: scenario for scenario in rebuilt}
    moved = []
    for scenario in committed:
        fresh = now.get(scenario["id"])
        if fresh is None:
            moved.append((scenario["id"], scenario["passed"], "(no longer recorded)"))
            continue
        if set(fresh["passed"].split(" ")) != set(scenario["passed"].split(" ")):
            moved.append((scenario["id"], scenario["passed"], fresh["passed"]))
    for scenario_id in now:
        if not any(s["id"] == scenario_id for s in committed):
            moved.append((scenario_id, "(not in the committed record)", now[scenario_id]["passed"]))
    return moved


def format_check_report(committed_artefact, rebuilt_scenarios, stale):
    """
    `(ok, report)`. The report is the whole value of this check when it fails.

    Written the way `generate_rollout_dataset.py`'s is (#225), and for the same
    reason: a bare "mismatch" gets read as "the check is broken" and switched
    off. The two halves fail for completely different reasons and want
    completely different fixes, so they are reported separately and each one
    names its own cause.

      The record moved  - `pinochle_engine.py`'s passer returns something else
                          now. Expected after a deliberate change; the fix is to
                          re-record and then MAKE SURE `passing.ts` moved too,
                          because re-recording on its own would hand the TS side
                          a new answer to agree with and prove nothing.

      The fixture is stale - the committed TypeScript is not what this renderer
                          produces from the committed JSON. Either someone edited
                          the generated file, or someone re-recorded without
                          re-rendering. Neither needs the engine looked at.
    """
    committed = committed_artefact["scenarios"]
    moved = moved_scenarios(committed, rebuilt_scenarios)
    lines = [
        f"{len(committed)} recorded scenarios, {len(rebuilt_scenarios)} rebuilt from the engine",
    ]

    if not moved and not stale:
        lines.append("")
        lines.append(
            "The Python passer still sends what pass_parity_scenarios.json says "
            "it sends, and web/src/engine/passParity.fixture.ts is what this "
            "renderer produces from it. `passParity.test.ts` is holding the "
            "TypeScript passer to a live answer."
        )
        return True, "\n".join(lines)

    if moved:
        lines.append("")
        lines.append(f"THE RECORD MOVED - {len(moved)} scenario(s) pass differently now:")
        for scenario_id, recorded, now in moved[:12]:
            lines.append(f"  {scenario_id}: recorded [{recorded}] -> now [{now}]")
        if len(moved) > 12:
            lines.append(f"  ... and {len(moved) - 12} more")
        lines += [
            "",
            "WHAT THIS MEANS. `pinochle_engine.py`'s pass selection - "
            "Player.choose_pass_cards and the two tier lists under it - no longer "
            "chooses what was recorded. If you changed it on purpose, this is the "
            "guard doing its job and the fix is:",
            "",
            "  1. Change `web/src/engine/passing.ts` to match. Python is "
            "authoritative for these tiers (CLAUDE.md), so the TS side follows.",
            "  2. `python export_pass_parity.py --record` to re-record and "
            "re-render, and commit both files.",
            "  3. `cd web && npm test -- --run passParity` to confirm the TS "
            "passer really did move with it.",
            "",
            "DO NOT re-record without step 1. Re-recording hands the TypeScript "
            "side a fresh answer to agree with, so the suite goes green whether "
            "or not `passing.ts` was touched - which is the exact blindness #279 "
            "filed this fixture to remove.",
        ]

    if stale:
        lines.append("")
        lines.append("THE GENERATED FIXTURE IS STALE:")
        for path in stale:
            lines.append(f"  {os.path.relpath(path, REPO_ROOT)}")
        lines += [
            "",
            "This half says nothing about the engine. The committed TypeScript is "
            "not what this renderer produces from the committed JSON, which means "
            "the generated file was hand-edited or a re-record was never "
            "re-rendered. `passParity.test.ts` is currently checking the browser "
            "against whatever that edit said. Run "
            "`python export_pass_parity.py` and commit the result.",
        ]

    return False, "\n".join(lines)


def check(artefact=None):
    """Both halves. Returns `(ok, report)` for a caller that wants an exit code.

    Cheap enough to sit in the suite unconditionally: the passer is a pure
    function of twelve cards and the deals are a seeded shuffle each, so the
    whole re-record is a few dozen milliseconds. That is deliberate - #225's
    fingerprint check costs ~40 s and is worth it for the question it asks, and
    a guard on a pure function has no excuse to cost anything.
    """
    if artefact is None:
        artefact = read_scenarios()
    rebuilt = build_scenarios()
    stale = stale_files(generated_files(artefact))
    return format_check_report(artefact, rebuilt, stale)


def main():
    parser = argparse.ArgumentParser(
        description="Record Python's 3-card pass for the TS parity suite (#279)",
    )
    parser.add_argument("--record", action="store_true",
                        help="re-run the passer and rewrite pass_parity_scenarios.json as well")
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

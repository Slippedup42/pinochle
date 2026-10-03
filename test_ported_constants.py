"""
Issue #216: a standing net for the numbers the two engines share.

#118 was two ported Base Bid constants (`NEAR_RUN_VALUE`,
`NEAR_DOUBLE_PINOCHLE_VALUE`) that had drifted between `pinochle_engine.py`
and `web/src/engine/bidding.ts`, which changed which suit the browser named as
trump; it was found by hand. #126 then audited every ported constant once, by
hand, and #200 moved `OPENING_BID` in both engines by hand again. Nothing in
either suite would have failed if only one of those edits had landed.
`engineParity.test.ts` deliberately pins the bids as scenario data, so the
auction is outside it; `export_evaluator.py --check` covers the generated
evaluator and nothing else. This file pins the numbers.

How it works: read the `export const` declarations out of the committed
TypeScript, evaluate the ones that are numbers (literals, number tuples and
records, and simple arithmetic over other constants), and compare each against
the Python constant it is *explicitly* paired with below. The pairing is
enumerated, never inferred by matching names, because a name-matched sweep
silently stops covering a constant the moment either side renames it.

Every `export const` in the swept files has to land in exactly one of three
places - `PAIRS`, `EXCLUDED` (a number with no Python counterpart, or one
deliberately not pinned here, with the reason), or `NOT_NUMBERS` - so a *new*
constant cannot be added to a ported file without someone deciding which.

Authority follows CLAUDE.md's split (#213), and each pair carries its owner so
the failure message says the right thing:

- PYTHON:     rules constants and the Base Bid valuation. Python is right; the
              TypeScript has drifted (#118's bug class).
- TYPESCRIPT: auction strategy decided on the TS side that Python keeps a named
              copy of. TypeScript is right; Python's copy is stale - or the
              divergence is now intended and the pair belongs in EXCLUDED.
- SHARED:     auction strategy neither CLAUDE.md nor #213 assigns to one side,
              which has always moved in both engines in the same change (e.g.
              #315's opening anchor). Neither side is presumed right; one side
              was edited alone.

Run directly (`python test_ported_constants.py`) for the full table.
"""

import os
import re

import pinochle_engine


REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
TS_ENGINE_DIR = os.path.join(REPO_ROOT, "web", "src", "engine")

PYTHON = "python"
TYPESCRIPT = "typescript"
SHARED = "shared"

# The TypeScript modules that port rules or auction numbers from Python. Every
# `export const` in each of them must be classified below.
SWEPT_FILES = (
    "card.ts",
    "melds.ts",
    "trick.ts",
    "round.ts",
    "passing.ts",
    "misdeal.ts",
    "bidding.ts",
    "skills.ts",
)

# (TS file, TS name, Python name in pinochle_engine.py, authority)
PAIRS = (
    # -- Rules constants: the things pinochle_rules.md states.
    ("card.ts", "GAME_WIN_SCORE", "GAME_WIN_SCORE", PYTHON),
    ("card.ts", "GAME_LOSE_SCORE", "GAME_LOSE_SCORE", PYTHON),
    ("card.ts", "OPENING_BID", "OPENING_BID", PYTHON),
    ("card.ts", "FORCED_BID", "FORCED_BID", PYTHON),
    ("card.ts", "MIN_BID_INCREMENT", "MIN_BID_INCREMENT", PYTHON),
    ("card.ts", "TOTAL_TRUMP_COPIES", "TOTAL_TRUMP_COPIES", PYTHON),
    ("melds.ts", "RUN_VALUE", "RUN_VALUE", PYTHON),
    ("melds.ts", "DOUBLE_RUN_VALUE", "DOUBLE_RUN_VALUE", PYTHON),
    ("melds.ts", "ROYAL_MARRIAGE_VALUE", "ROYAL_MARRIAGE_VALUE", PYTHON),
    ("melds.ts", "COMMON_MARRIAGE_VALUE", "COMMON_MARRIAGE_VALUE", PYTHON),
    ("melds.ts", "DIX_VALUE", "DIX_VALUE", PYTHON),
    ("melds.ts", "PINOCHLE_SINGLE_VALUE", "PINOCHLE_SINGLE_VALUE", PYTHON),
    ("melds.ts", "PINOCHLE_DOUBLE_VALUE", "PINOCHLE_DOUBLE_VALUE", PYTHON),
    ("melds.ts", "AROUND_VALUES", "AROUND_VALUES", PYTHON),
    ("melds.ts", "AROUND_DOUBLE_MULTIPLIER", "AROUND_DOUBLE_MULTIPLIER", PYTHON),
    ("passing.ts", "PASS_COUNT", "PASS_COUNT", PYTHON),
    # -- Base Bid valuation: Python-authoritative per CLAUDE.md; #118 lived here.
    ("bidding.ts", "NEAR_RUN_VALUE", "NEAR_RUN_VALUE", PYTHON),
    ("bidding.ts", "NEAR_DOUBLE_PINOCHLE_VALUE", "NEAR_DOUBLE_PINOCHLE_VALUE", PYTHON),
    ("bidding.ts", "PINOCHLE_NO_KING_OF_SPADES_BONUS", "PINOCHLE_NO_KING_OF_SPADES_BONUS", PYTHON),
    ("bidding.ts", "ACE_VALUE", "ACE_VALUE", PYTHON),
    ("bidding.ts", "TRUMP_ACE_VALUE", "TRUMP_ACE_VALUE", PYTHON),
    ("bidding.ts", "TRUMP_LENGTH_BASELINE", "TRUMP_LENGTH_BASELINE", PYTHON),
    ("bidding.ts", "EXTRA_TRUMP_VALUE", "EXTRA_TRUMP_VALUE", PYTHON),
    ("bidding.ts", "PROTECTED_TEN_VALUE", "PROTECTED_TEN_VALUE", PYTHON),
    ("bidding.ts", "LOOSE_KING_VALUE", "LOOSE_KING_VALUE", PYTHON),
    ("bidding.ts", "LOOSE_QUEEN_VALUE", "LOOSE_QUEEN_VALUE", PYTHON),
    ("bidding.ts", "PARTNER_ESTIMATE_RANGE", "PARTNER_ESTIMATE_RANGE", PYTHON),
    # -- Auction strategy kept equal in both engines, with no declared owner.
    ("bidding.ts", "OPENER_THRESHOLD", "OPENER_THRESHOLD", SHARED),
    ("bidding.ts", "ANCHOR_INTERCEPT", "ANCHOR_INTERCEPT", SHARED),
    ("bidding.ts", "ANCHOR_SLOPE", "ANCHOR_SLOPE", SHARED),
    ("bidding.ts", "ANCHOR_CAP", "ANCHOR_CAP", SHARED),
    ("bidding.ts", "DEFENSIVE_PUSH_FLOOR", "DEFENSIVE_PUSH_FLOOR", SHARED),
    ("bidding.ts", "ENDGAME_SCORE_FLOOR", "ENDGAME_SCORE_FLOOR", SHARED),
    ("bidding.ts", "ENDGAME_OPP_SCORE_CAP", "ENDGAME_OPP_SCORE_CAP", SHARED),
    ("bidding.ts", "ENDGAME_RESCUE_CEILING", "ENDGAME_RESCUE_CEILING", SHARED),
    ("bidding.ts", "THIRD_BIDDER_FLOOR", "THIRD_BIDDER_FLOOR", SHARED),
    ("skills.ts", "MELD_ONLY_TRICK_ESTIMATE", "MELD_ONLY_TRICK_ESTIMATE", SHARED),
    ("skills.ts", "MELD_ONLY_BID_NOISE", "EASY_BID_NOISE", SHARED),
    # -- Auction strategy TypeScript owns (#180/#206/#213); Python keeps copies.
    ("bidding.ts", "PARTNER_RAISE_FLOOR", "PARTNER_RAISE_FLOOR", TYPESCRIPT),
    ("bidding.ts", "COMPETITIVE_CEILING_FLOOR", "COMPETITIVE_CEILING_FLOOR", TYPESCRIPT),
)

# Numbers in the swept files that are deliberately not pinned, with the reason.
EXCLUDED = {
    ("bidding.ts", "PARTNER_PASSED_FLOOR"):
        "TS-only auction rule (#180, measured in web/src/ab/). Python's "
        "choose_bid has no partner-passed floor; #213 found the divergence "
        "inert and kept it.",
    ("misdeal.ts", "MISDEAL_NINE_THRESHOLD"):
        "TS-only: pinochle_engine.py does not implement the misdeal "
        "redeal, so there is nothing to pair it with.",
    ("round.ts", "MIN_CLAIMABLE_TRICKS"):
        "TS-only: the claim-the-rest UI has no Python counterpart.",
    ("round.ts", "TRICK_COUNT"):
        "pinochle_engine.py has no named counterpart (the 12 is implicit in "
        "the deal). engineParity.test.ts replays whole rounds, which is the "
        "stronger net for it.",
    ("round.ts", "LAST_TRICK_BONUS"):
        "pinochle_engine.py has no named counterpart (a literal in trick "
        "scoring). engineParity.test.ts checks every round's trick points, "
        "last-trick bonus included.",
    ("round.ts", "MAX_TRICK_POINTS"):
        "Derived from Set and array sizes this parser does not evaluate. "
        "round.test.ts pins it to 250; Python's copy is a literal in "
        "pinochle_rollout.py, not pinochle_engine.py.",
    ("trick.ts", "COUNTER_VALUE"):
        "pinochle_engine.py has no named counterpart (a literal in trick "
        "scoring). engineParity.test.ts checks every trick's points.",
    ("card.ts", "RANK_VALUE"):
        "Derived from RANKS by index on both sides, not a tuned number; "
        "engineParity.test.ts checks every trick winner, which is what "
        "rank order decides.",
}

# Exports in the swept files that are not numbers, so not this net's job.
NOT_NUMBERS = {
    ("card.ts", "Suit"), ("card.ts", "SUITS"), ("card.ts", "RANKS"), ("card.ts", "COPIES_PER_CARD"),
    ("melds.ts", "RUN_RANKS"),
    ("trick.ts", "POINT_RANKS"),
    # The browser's skill dial. Structured, TS-owned, and shaped differently
    # from Python's GENERAL_STRATEGY_SKILL_PARAMS - not a ported scalar.
    ("skills.ts", "SKILL_LEVELS"), ("skills.ts", "SHIPPED_PARAMS"),
    ("skills.ts", "SHIPPED_SKILL"), ("skills.ts", "SKILL_PARAMS"),
}


# ---------------------------------------------------------------------------
# Reading the TypeScript.
# ---------------------------------------------------------------------------

_EXPORT_RE = re.compile(r"^export const ([A-Za-z_][A-Za-z0-9_]*)\b(.*)$")
_SAFE_EXPR = re.compile(r"^[\w\s+\-*/().,\[\]{}:'\"]*$")  # `.` for floats


def _strip_comment(line):
    # Good enough for the numeric declarations evaluated here, none of which
    # put `//` inside a string.
    return line.split("//", 1)[0]


def read_ts_exports(filename):
    """Map each `export const` name in `filename` to its initializer text,
    joined across lines until the brackets balance. The type annotation, if
    any, is dropped."""
    path = os.path.join(TS_ENGINE_DIR, filename)
    with open(path, encoding="utf-8") as handle:
        lines = handle.read().splitlines()
    exports = {}
    i = 0
    while i < len(lines):
        match = _EXPORT_RE.match(lines[i])
        if not match:
            i += 1
            continue
        name, rest = match.group(1), _strip_comment(match.group(2))
        text = rest
        while True:
            depth = sum(text.count(c) for c in "([{") - sum(text.count(c) for c in ")]}")
            stripped = text.rstrip()
            if depth <= 0 and not stripped.endswith(("=", "+", "-", "*", "/", ",")):
                break
            i += 1
            text += " " + _strip_comment(lines[i]).strip()
        # Drop `: Type` before the `=`. Types here never contain a bare `=`.
        initializer = text.split("=", 1)[1].strip() if "=" in text else ""
        exports[name] = initializer
        i += 1
    return exports


def evaluate_ts(initializer, namespace):
    """The value of a numeric TS initializer, or raise ValueError. Handles
    literals, number tuples, `{ K: n }` records, `.length`, and arithmetic over
    names already in `namespace`."""
    expr = initializer.replace(" as const", "")
    expr = re.sub(r"\b([A-Za-z_]\w*)\.length\b", r"len(\1)", expr)
    expr = re.sub(r"([{,]\s*)([A-Za-z_]\w*)\s*:", r"\1'\2':", expr)
    if not _SAFE_EXPR.match(expr):
        raise ValueError(f"not a plain numeric expression: {initializer!r}")
    try:
        value = eval(expr, {"__builtins__": {}, "len": len}, dict(namespace))  # noqa: S307
    except Exception as exc:  # NameError for an unresolvable reference, etc.
        raise ValueError(f"cannot evaluate {initializer!r}: {exc}") from exc
    return _normalise(value)


def _normalise(value):
    if isinstance(value, tuple):
        return [_normalise(v) for v in value]
    if isinstance(value, list):
        return [_normalise(v) for v in value]
    if isinstance(value, dict):
        return {k: _normalise(v) for k, v in value.items()}
    return value


def ts_values():
    """{(file, name): value} for every TS export that evaluates as a number,
    a list of numbers, or a record of numbers. References resolve across the
    swept files (bidding.ts reads GAME_WIN_SCORE from card.ts)."""
    raw = {(f, n): text for f in SWEPT_FILES for n, text in read_ts_exports(f).items()}
    namespace = {}
    values = {}
    # Resolve in passes so a name can refer to one declared in a later file.
    pending = dict(raw)
    while pending:
        progressed = False
        for key, text in list(pending.items()):
            try:
                value = evaluate_ts(text, namespace)
            except ValueError:
                continue
            values[key] = value
            namespace[key[1]] = value
            del pending[key]
            progressed = True
        if not progressed:
            break
    return raw, values


def mismatch_message(ts_file, ts_name, ts_value, py_name, py_value, owner):
    where = (f"web/src/engine/{ts_file}'s {ts_name} = {ts_value!r}, but "
             f"pinochle_engine.py's {py_name} = {py_value!r}.")
    if owner == PYTHON:
        return (f"{where} TS has drifted: Python is authoritative for rules and "
                f"Base Bid constants (CLAUDE.md, #213; #118's bug class). Fix "
                f"the TypeScript.")
    if owner == TYPESCRIPT:
        return (f"{where} TypeScript is authoritative for this auction-strategy "
                f"constant (CLAUDE.md, #213), so Python's named copy is the "
                f"stale one: update it, or if the divergence is now intended, "
                f"move the pair to EXCLUDED with the reason.")
    return (f"{where} Neither engine is declared authoritative for this one; it "
            f"has always moved in both engines in the same change (e.g. #315). "
            f"One side was edited alone - find that change and land it on both.")


# ---------------------------------------------------------------------------
# The tests.
# ---------------------------------------------------------------------------

RAW, TS_VALUES = ts_values()


def test_every_export_in_the_swept_files_is_classified():
    classified = {(f, n) for f, n, _, _ in PAIRS} | set(EXCLUDED) | NOT_NUMBERS
    unclassified = sorted(set(RAW) - classified)
    assert not unclassified, (
        "New `export const` in a ported TypeScript file, not yet classified: "
        f"{unclassified}. Pair it with its pinochle_engine.py constant in "
        "test_ported_constants.PAIRS, or add it to EXCLUDED with the reason "
        "(or NOT_NUMBERS if it is not a number).")


def test_every_classified_name_still_exists():
    # A rename on the TS side must fail here rather than quietly uncover a pair.
    classified = {(f, n) for f, n, _, _ in PAIRS} | set(EXCLUDED) | NOT_NUMBERS
    vanished = sorted(classified - set(RAW))
    assert not vanished, (
        f"Classified in test_ported_constants.py but no longer exported: "
        f"{vanished}. If it was renamed, update the entry; if it was removed, "
        f"drop it.")


def test_classifications_do_not_overlap():
    paired = [(f, n) for f, n, _, _ in PAIRS]
    assert len(paired) == len(set(paired)), "a TS constant is paired twice"
    assert not set(paired) & set(EXCLUDED)
    assert not set(paired) & NOT_NUMBERS
    assert not set(EXCLUDED) & NOT_NUMBERS


def test_every_paired_constant_is_readable_on_both_sides():
    for ts_file, ts_name, py_name, owner in PAIRS:
        assert owner in (PYTHON, TYPESCRIPT, SHARED)
        assert (ts_file, ts_name) in TS_VALUES, (
            f"{ts_file}'s {ts_name} = {RAW.get((ts_file, ts_name))!r} did not "
            f"evaluate to a number; this net cannot pin it.")
        assert hasattr(pinochle_engine, py_name), (
            f"pinochle_engine.py no longer defines {py_name} (paired with "
            f"{ts_file}'s {ts_name}). If it was renamed, update PAIRS.")


def test_paired_constants_agree():
    mismatches = []
    for ts_file, ts_name, py_name, owner in PAIRS:
        if (ts_file, ts_name) not in TS_VALUES or not hasattr(pinochle_engine, py_name):
            continue  # reported by test_every_paired_constant_is_readable_on_both_sides
        ts_value = TS_VALUES[(ts_file, ts_name)]
        py_value = _normalise(getattr(pinochle_engine, py_name))
        if ts_value != py_value:
            mismatches.append(mismatch_message(ts_file, ts_name, ts_value,
                                               py_name, py_value, owner))
    assert not mismatches, "\n".join(mismatches)


def test_the_net_reads_values_not_just_names():
    # Guards the parser: a regex that matched the name but read the wrong
    # initializer would make every comparison above vacuous.
    assert TS_VALUES[("card.ts", "OPENING_BID")] == 300
    assert TS_VALUES[("bidding.ts", "ENDGAME_SCORE_FLOOR")] == 750
    assert TS_VALUES[("bidding.ts", "PARTNER_ESTIMATE_RANGE")] == [50, 100]
    assert TS_VALUES[("melds.ts", "AROUND_VALUES")] == {"A": 100, "K": 80, "Q": 60, "J": 40}
    assert TS_VALUES[("card.ts", "TOTAL_TRUMP_COPIES")] == 12


def test_mismatch_messages_name_the_right_authority():
    py = mismatch_message("card.ts", "OPENING_BID", 250, "OPENING_BID", 300, PYTHON)
    assert "TS has drifted" in py and "250" in py and "300" in py
    ts = mismatch_message("bidding.ts", "PARTNER_RAISE_FLOOR", 350,
                          "PARTNER_RAISE_FLOOR", 340, TYPESCRIPT)
    assert "TypeScript is authoritative" in ts and "TS has drifted" not in ts
    shared = mismatch_message("bidding.ts", "ANCHOR_INTERCEPT", 340,
                              "ANCHOR_INTERCEPT", 330, SHARED)
    assert "Neither engine" in shared and "TS has drifted" not in shared


if __name__ == "__main__":
    for ts_file, ts_name, py_name, owner in PAIRS:
        ts_value = TS_VALUES.get((ts_file, ts_name))
        py_value = _normalise(getattr(pinochle_engine, py_name, None))
        flag = "ok  " if ts_value == py_value else "DIFF"
        print(f"{flag} {owner:<10} {ts_file:<11} {ts_name:<34} {ts_value!r:<28} {py_name} = {py_value!r}")
    for (ts_file, ts_name), reason in sorted(EXCLUDED.items()):
        print(f"skip {ts_file:<11} {ts_name:<34} {reason}")

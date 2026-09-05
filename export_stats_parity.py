"""
Record `ab_harness.py`'s three statistics so `web/src/ab/stats.ts` can be held
to them (issue #211).

`stats.ts` is the last thing crossing the Python/TypeScript boundary that is
neither generated nor guarded - `export_evaluator.py --check` covers the
evaluator model, `generate_rollout_dataset.py --check` covers the dataset it is
fit to, `export_parity_scenarios.py` covers the rules engine, and these three
functions were a hand-port with nothing behind them. That matters more than an
uncovered module usually would, because every A/B result this project has acted
on came through them on one side or the other: #115's distillation call, #153's
trick-play dial, #255's third-bidder floor, #227's re-baseline. A divergence
here does not fail a test. It makes a *decision* wrong, and nothing says so.

WHAT IS PINNED AND WHAT IS CHECKED, which is the same split
`export_parity_scenarios.py` makes and for a related reason. Pinned: the
inputs, and - for the bootstrap - the resampling draws. Checked: the numbers
the three functions return. The bootstrap is the one that needs the extra
pinning. Python resamples with `random.Random.randrange` and TS with
`Math.floor(rand() * n)` over an injected generator; those are different PRNGs
and will never produce the same indices from the same seed, exactly as the two
engines' shuffles never produce the same deal. So the draws are recorded as
uniforms and replayed into both sides, which makes the resample identical and
leaves the *interval construction* - the mean, the sort, the percentile index
and its clamp - as the only thing being compared. That is the part that was
hand-ported.

CHOOSING THE CASES. These are numerical functions, so random inputs would prove
almost nothing: any two implementations agree in the middle of the range. The
cases are picked for where a port slips instead.

  Contract boundaries. Every stated contract in both docstrings gets a case:
  1.0 from a zero-trial binomial, `[0, 1]` from a zero-trial Wilson, `(0, 0)`
  and `(v, v)` from a bootstrap over no values and one value. A hand-port that
  quietly dropped one of those guards would be caught by a caller claiming
  significance it does not have, months later, which is how #118 was found.

  The exact binomial's tails, because that is the one place the two are not a
  line-by-line port at all. Python's `math.comb` is exact arbitrary precision;
  TS goes through a Lanczos `logGamma` because a few hundred decisive pairs put
  the coefficient near the double overflow boundary. Two implementations that
  agree to twelve digits in the middle can disagree about which *outcomes* fall
  inside the "no more likely than observed" set, and an outcome wrongly
  included or excluded moves the p-value by a whole term, not by a rounding.
  So the cases run out to trials=1000, where Python's coefficient is 2.7e299 -
  close enough to the boundary to be the real regime, and just inside it, since
  the exact side genuinely overflows not far above.

  Asymmetric `p`, because at `p = 0.5` the exact side's pmf is *identically*
  equal for symmetric outcomes and the `1e-9` inclusion slack never has to do
  any work. Away from 0.5 the near-ties are near-ties on both sides.

  Signed and mixed bootstrap samples, because the statistic is applied to score
  margins and "excludes zero" is the claim it exists to support.

WHY THE RECORDING IS ALSO ASSERTED FRESH, unlike the rounds in
`export_parity_scenarios.py`. There, re-recording replays the AI, so the
committed JSON is deliberately not compared against a fresh run - the AI is
expected to change and a staleness check over it would turn every tweak into a
red suite. Here recording is pure: same inputs, same numbers, forever, unless
`ab_harness.py` itself changes. So `test_export_stats_parity.py` asserts both
directions - the JSON is what Python says *today*, and the TypeScript is what
this renders from the JSON - and a change to a Python statistic fails the
Python suite naming the case, rather than surfacing days later as an
unexplained TS failure.

Two artefacts, two stages, on purpose:

  `stats_parity_cases.json`             the recorded inputs and outputs
  `web/src/ab/statsParity.fixture.ts`   the same, rendered as typed TS

Recording and rendering stay separate so that a formatting change to the
fixture does not require re-running the statistics, and so the committed JSON
is reviewable as numbers rather than as TypeScript.

Usage:

    python export_stats_parity.py            # re-render the TS from the JSON
    python export_stats_parity.py --record   # re-run the statistics too
    python export_stats_parity.py --check    # exit non-zero if either is stale
"""

import argparse
import inspect
import json
import os
import random
import sys

from ab_harness import binomial_two_sided_p, bootstrap_mean_ci, wilson_interval


# ---------------------------------------------------------------------------
# Where the artefacts live.
#
# Paths are relative to this file, not to the shell's working directory - the
# same reasoning as `export_parity_scenarios.py`. This gets run from the repo
# root, from `web/`, and from pytest, and a generator that writes somewhere
# different depending on where it was invoked from is a generator that silently
# leaves a stale copy behind.
# ---------------------------------------------------------------------------

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
CASES_JSON_PATH = os.path.join(REPO_ROOT, "stats_parity_cases.json")
FIXTURE_TS_PATH = os.path.join(REPO_ROOT, "web", "src", "ab", "statsParity.fixture.ts")

FORMAT_VERSION = 1


# ---------------------------------------------------------------------------
# The tolerance the TypeScript side compares with.
#
# Relative, not absolute, because the recorded p-values span 1.0 down to 5e-79
# and an absolute tolerance would assert nothing at all about the tail - which is
# the half of the range the two implementations actually compute differently.
# And not bit-equality, because they *are* different algorithms there:
# `math.comb` exact versus a Lanczos `logGamma` accurate to about 1e-15
# relative, summed over up to a thousand terms. Demanding equal doubles would be
# demanding the port be something it deliberately is not, and the test would be
# red on arrival.
#
# MEASURED, not guessed. Across this fixture the two sides disagree at all on
# only 22 of the 85 recorded numbers, every one of them a binomial p-value, and
# the worst is 1.5e-13 relative - on (999, 1000), the near-shutout at the
# largest trial count here, where the inclusion set is narrowest and every digit
# came through log space. The Wilson and bootstrap cases are bit-identical,
# which is what a line-by-line port of the same double arithmetic in the same
# order ought to be, and is itself worth knowing: the tolerance is spent on
# exactly the one function that earns it. So 1e-9 is about four orders above the
# noise and does not have to be widened as cases are added.
#
# It is also far below any porting error worth the name. The tightest realistic
# slip is a mistyped constant - 1.9599 for 1.96 in the Wilson z, say - which
# moves the interval by 5e-5 relative, four orders above this. A dropped clamp,
# an off-by-one percentile index, a base-e log where a base-10 was meant, a
# forgotten `min(1, ...)`: all move a digit that matters. Nothing plausible
# lands between 1.5e-13 and 1e-9, which is what makes this number a choice
# rather than a compromise. `statsParity.test.ts` asserts both bounds rather
# than describing them: the worst observed disagreement must stay under a
# hundredth of the tolerance, and every recorded value perturbed by 1e-6
# relative must be rejected.
# ---------------------------------------------------------------------------

RELATIVE_TOLERANCE = 1e-9

# What the perturbation test uses. Three orders above the tolerance and five
# below the mistyped-constant slip above, so it stands in for "the smallest
# error a human could introduce" without being tuned to any particular case.
SENSITIVITY_PERTURBATION = 1e-6


# ---------------------------------------------------------------------------
# The binomial cases.
#
# `(wins, trials, p, note)`. The note is carried through into the fixture: a
# numerical fixture with no notes is a wall of digits nobody can review, and the
# reason a case exists is the only thing that stops it being deleted as
# redundant.
# ---------------------------------------------------------------------------

BINOMIAL_CASES = [
    # -- contract boundaries -------------------------------------------------
    (0, 0, 0.5, "no trials at all: 1.0, because no evidence is not evidence of no difference"),
    (3, 0, 0.5, "no trials, and a wins count that cannot have happened: still 1.0, the guard runs first"),
    (0, 1, 0.5, "one trial, lost: the whole distribution is no more likely than observed"),
    (1, 1, 0.5, "one trial, won: mirror of the above, and 1.0 for the same reason"),
    # -- all one way ---------------------------------------------------------
    (10, 10, 0.5, "every pair one way, small: 2/1024 by hand"),
    (0, 10, 0.5, "every pair the other way: identical p by symmetry"),
    (60, 60, 0.5, "every pair one way, long enough that the exact side's coefficient is large"),
    (0, 261, 0.5, "a shutout over a real A/B's pair count - deep underflow, ~1e-79"),
    # -- dead even -----------------------------------------------------------
    (1, 2, 0.5, "the smallest possible tie"),
    (50, 100, 0.5, "dead even: every outcome is no more likely than the mode, so exactly 1.0"),
    (5, 10, 0.5, "dead even, odd-sized tail on each side"),
    (50, 101, 0.5, "odd trials, so there is no single mode and the two central outcomes tie"),
    # -- the near-tie the inclusion slack exists for -------------------------
    (26, 50, 0.5, "one pair off dead even: the symmetric partner must be counted in"),
    (24, 50, 0.5, "the mirror of the above, which must return the identical p"),
    (21, 40, 0.5, "one off even again, at a different parity"),
    # -- tails ---------------------------------------------------------------
    (95, 100, 0.5, "lopsided: the tail the harness reports as significant"),
    (2, 60, 0.5, "far tail, low side"),
    (58, 60, 0.5, "the mirror far tail, high side"),
    (211, 261, 0.5, "#115's shape of result: a decisive A/B at a realistic pair count"),
    (150, 261, 0.5, "a modest edge over the same pair count - the marginal call the harness is for"),
    (131, 261, 0.5, "odd trials at a realistic pair count: 130 and 131 tie for the mode, so this is 1.0 and not a near-miss"),
    # -- log space earns its keep -------------------------------------------
    (500, 1000, 0.5, "1000 trials: comb(1000,500) is 2.7e299, just inside the exact side's overflow"),
    (520, 1000, 0.5, "1000 trials, slightly off centre - a wide inclusion set in the large regime"),
    (999, 1000, 0.5, "1000 trials, one short of a shutout: the narrowest inclusion set at this size"),
    # -- asymmetric p, where the slack has to do real work ------------------
    (60, 100, 0.6, "p matches the observed rate exactly: 1.0, and no symmetry to lean on"),
    (55, 100, 0.6, "just off an asymmetric null - genuine near-ties, not exact ones"),
    (65, 100, 0.6, "the other side of the same asymmetric null, which is NOT its mirror"),
    (30, 100, 0.25, "a quarter-null, upper tail"),
    (15, 100, 0.25, "a quarter-null, lower tail"),
    (9, 40, 0.75, "a three-quarter null, far lower tail"),
    (2, 12, 0.4, "small trials, awkward p: the regime where an inclusion set is easiest to get wrong"),
]


# ---------------------------------------------------------------------------
# The Wilson cases. `(wins, trials, z, note)`.
#
# Both clamps get their own case. `max(0, ...)` and `min(1, ...)` are two
# characters each and are exactly the sort of thing a port drops, and the whole
# stated reason for preferring Wilson over the normal approximation is that it
# behaves at the extremes a small run hits regularly.
# ---------------------------------------------------------------------------

WILSON_CASES = [
    (0, 0, 1.96, "no trials: [0, 1], the interval that supports no claim"),
    (5, 0, 1.96, "no trials with a nonzero wins count: the guard still runs first"),
    (0, 1, 1.96, "a single loss - the lower clamp's natural home"),
    (1, 1, 1.96, "a single win - and the upper clamp's"),
    (0, 20, 1.96, "no wins over a short run: lower end pinned at 0 by the clamp"),
    (20, 20, 1.96, "all wins over a short run: upper end pinned at 1"),
    (1, 20, 1.96, "one win: asymmetric interval, well inside both clamps"),
    (5, 10, 1.96, "the small even split, where the interval is at its widest"),
    (50, 100, 1.96, "the even split at a hundred"),
    (211, 261, 1.96, "#115's shape of result at its real pair count"),
    (131, 261, 1.96, "one pair off even at a real pair count"),
    (500, 1000, 1.96, "a long run: the z^2/(4n^2) term is where a port's operator order shows"),
    (997, 1000, 1.96, "a long run near the top, still short of the clamp"),
    (7, 13, 1.0, "z = 1: the continuity term and the denominator both change scale"),
    (7, 13, 2.5758293035489004, "z for 99%: a wider interval that reaches a clamp the 95% one does not"),
    (7, 13, 0.0, "z = 0: the interval collapses to the point estimate, both clamps inert"),
    (3, 7, 3.5, "a z nobody would use, chosen so both clamps fire at once"),
]


# ---------------------------------------------------------------------------
# The bootstrap cases.
#
# `(values, iters, alpha, seed, note)`. `seed` draws the uniforms that get
# recorded; it is a recording detail and not part of what either side computes.
#
# `alpha` is the lever that moves the percentile index, and the index is the
# hand-ported arithmetic. `alpha=0.05` at `iters=40` puts the low index at 1 and
# the high at the last element; `alpha=0.5` puts both well inside the array,
# which is the only way an off-by-one shows up as a different *number* rather
# than the same clamped end; `alpha=0` drives the high index one past the end
# and is the only case that exercises the `min(iters - 1, ...)` clamp at all.
# ---------------------------------------------------------------------------

BOOTSTRAP_CASES = [
    ([], 40, 0.05, 900001, "no values: (0, 0), an interval that brackets zero and claims nothing"),
    ([137.0], 40, 0.05, 900002, "one value: the point itself, and no resampling happens"),
    ([-88.0], 40, 0.05, 900003, "one negative value: the n == 1 branch must not lose the sign"),
    ([-140.0, -35.0, 0.0, 60.0, 205.0], 40, 0.05, 900004,
     "signed margins, the shape the statistic is actually applied to; indices 1 and last"),
    ([-140.0, -35.0, 0.0, 60.0, 205.0], 40, 0.5, 900004,
     "the same sample and the same draws at alpha=0.5, so both indices land mid-array"),
    ([-140.0, -35.0, 0.0, 60.0, 205.0], 40, 0.0, 900004,
     "the same again at alpha=0, the only case that reaches the min(iters-1, ...) clamp"),
    ([210.0, 180.0, 240.0, 195.0, 260.0, 175.0], 60, 0.05, 900005,
     "a wholly positive sample: the interval that excludes zero and calls a real difference"),
    ([-3.0, 2.0, -1.0, 4.0, -2.0, 1.0, -4.0, 3.0], 50, 0.05, 900006,
     "noise around zero: the interval that must *not* exclude it"),
    ([1.0, 10.0, 100.0, 1000.0, 10000.0, 100000.0], 45, 0.05, 900007,
     "powers of ten, so every distinct resample gives a distinct mean: the one "
     "case where an off-by-one at either percentile index cannot hide in a tie"),
    ([12.0, 12.0, 12.0, 12.0], 30, 0.05, 900008,
     "a constant sample: every resample mean is identical and the interval has no width"),
]


# ---------------------------------------------------------------------------
# Recording.
# ---------------------------------------------------------------------------

class RecordedDraws:
    """The recorded uniforms, wearing the interface `bootstrap_mean_ci` uses.

    `bootstrap_mean_ci` only ever calls `rng.randrange(n)`, so this is the whole
    surface. `int(u * n)` is what `Math.floor(rand() * n)` does on the TS side
    for `u` in [0, 1) - the same index from the same draw, which is the point.
    Feeding a real `random.Random` instead would record a sequence the browser
    cannot reproduce, and the fixture would be asserting that two different
    PRNGs agree.
    """

    def __init__(self, draws):
        self.draws = list(draws)
        self.position = 0

    def randrange(self, n):
        draw = self.draws[self.position]
        self.position += 1
        return int(draw * n)


def draw_uniforms(count, seed):
    """`count` uniforms in [0, 1), reproducible from `seed` alone."""
    rng = random.Random(seed)
    return [rng.random() for _ in range(count)]


def bootstrap_means(values, draws):
    """The sorted resample means, recomputed from the draws.

    NOT the source of any recorded number - every `expected` in this file comes
    out of `ab_harness.bootstrap_mean_ci` itself. This exists so
    `test_export_stats_parity.py` can ask whether a case would actually *notice*
    an off-by-one in the percentile index, which needs the order statistics
    either side of the one that was picked. A bootstrap over a discrete sample
    produces heavy ties, and a case whose chosen index sits inside a tied block
    is a case that would report the same interval for the wrong index - the
    exact blindness a fixture of easy cases has.

    Kept honest by `test_the_recomputed_means_agree_with_the_real_function`,
    which pins its ends against `bootstrap_mean_ci` at alpha=0.
    """
    n = len(values)
    rng = RecordedDraws(draws)
    means = []
    while rng.position < len(draws):
        total = 0.0
        for _ in range(n):
            total += values[rng.randrange(n)]
        means.append(total / n)
    means.sort()
    return means


def record_binomial(case):
    wins, trials, p, note = case
    return {
        "id": f"b{wins}_{trials}_{p}",
        "note": note,
        "wins": wins,
        "trials": trials,
        "p": p,
        "expected": binomial_two_sided_p(wins, trials, p),
    }


def record_wilson(case):
    wins, trials, z, note = case
    low, high = wilson_interval(wins, trials, z)
    return {
        "id": f"w{wins}_{trials}_{z}",
        "note": note,
        "wins": wins,
        "trials": trials,
        "z": z,
        "expected": [low, high],
    }


def record_bootstrap(index, case):
    values, iters, alpha, seed, note = case
    n = len(values)
    draws = draw_uniforms(iters * n, seed)
    rng = RecordedDraws(draws)
    low, high = bootstrap_mean_ci(values, iters=iters, alpha=alpha, rng=rng)

    # An n == 0 or n == 1 sample returns before resampling, so it consumes
    # nothing; anything else must consume every draw recorded for it, or the two
    # sides are being handed different amounts of randomness and the fixture
    # would be pinning a coincidence.
    expected_used = 0 if n <= 1 else iters * n
    assert rng.position == expected_used, (
        f"bootstrap case {index}: consumed {rng.position} draws, expected "
        f"{expected_used} - `bootstrap_mean_ci`'s resampling shape has changed"
    )

    return {
        "id": f"c{index + 1:02d}",
        "note": note,
        "values": list(values),
        "iters": iters,
        "alpha": alpha,
        "seed": seed,
        "draws": draws if n > 1 else [],
        "expected": [low, high],
    }


# ---------------------------------------------------------------------------
# The default arguments, which are the ones production actually uses.
#
# This started as an oversight and is worth keeping as a note. Every case above
# passes `p`, `z`, `iters` and `alpha` explicitly, so a fixture built only from
# them proves nothing about the defaults - and the defaults are what both
# harnesses call with. `ab_harness.py` reports `wilson_interval(self.pairs_a,
# self.decisive_pairs)`; `abRun.ts` reports `wilsonInterval(pairsA,
# decisivePairs)` and `bootstrapMeanCi(pairMargins, makeRng(ciSeed))`. Mistyping
# 1.9599 for 1.96 in one signature would move every published confidence
# interval and leave every explicit-z case in this fixture green.
#
# Read out of the signature rather than written down here, so the recording
# cannot claim a default the function does not have.
# ---------------------------------------------------------------------------

def _default(function, parameter):
    value = inspect.signature(function).parameters[parameter].default
    assert value is not inspect.Parameter.empty, (
        f"{function.__name__} has no default for {parameter} - the TypeScript "
        "side has one, so the two signatures no longer correspond"
    )
    return value


def record_defaults():
    return {
        "binomial_p": _default(binomial_two_sided_p, "p"),
        "wilson_z": _default(wilson_interval, "z"),
        "bootstrap_iters": _default(bootstrap_mean_ci, "iters"),
        "bootstrap_alpha": _default(bootstrap_mean_ci, "alpha"),
    }


def record_cases():
    """The full artefact: every recorded case plus its provenance."""
    return {
        "format_version": FORMAT_VERSION,
        "issue": "#211",
        "generated_by": os.path.basename(__file__),
        "source": "ab_harness.py",
        "relative_tolerance": RELATIVE_TOLERANCE,
        "sensitivity_perturbation": SENSITIVITY_PERTURBATION,
        "defaults": record_defaults(),
        "binomial": [record_binomial(case) for case in BINOMIAL_CASES],
        "wilson": [record_wilson(case) for case in WILSON_CASES],
        "bootstrap": [
            record_bootstrap(index, case) for index, case in enumerate(BOOTSTRAP_CASES)
        ],
    }


# ---------------------------------------------------------------------------
# Rendering the TypeScript fixture.
#
# A generated module rather than a JSON import, for the reason `export_evaluator
# .py` spells out: `web/` type-checks with `verbatimModuleSyntax` and `noEmit`,
# and an imported JSON blob would be untyped exactly where a shape mismatch
# would hide.
#
# Numbers go through `repr`, which is the shortest decimal that round-trips to
# the same double, and TypeScript parses decimal literals to the same IEEE
# double Python does. So the fixture carries the *bits* Python produced, not a
# rounded copy of them, and the tolerance above is spent on the algorithms
# rather than on the transport.
# ---------------------------------------------------------------------------

def _string(value):
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def _number(value):
    text = repr(float(value))
    assert text not in ("inf", "-inf", "nan"), f"non-finite value reached the fixture: {value}"
    return text


def _number_list(values):
    return "[" + ", ".join(_number(v) for v in values) + "]"


def _wrapped_number_list(values, indent, per_line=6):
    """A long draw list, broken so the fixture is diffable line by line."""
    if not values:
        return "[]"
    lines = ["["]
    for start in range(0, len(values), per_line):
        chunk = values[start:start + per_line]
        lines.append(indent + "  " + ", ".join(_number(v) for v in chunk) + ",")
    lines.append(indent + "]")
    return "\n".join(lines)


def _comment_block(text):
    return "\n".join(f"// {line}".rstrip() for line in text.split("\n"))


FIXTURE_HEADER = """\
GENERATED FILE - do not edit by hand.

Produced by `export_stats_parity.py` (issue #211) from
`stats_parity_cases.json`, which the same script records by running
`ab_harness.py`'s three statistics. Re-render with
`python export_stats_parity.py`; `test_export_stats_parity.py` fails the Python
suite if this file has drifted from the JSON it claims to carry, or if the JSON
has drifted from what Python computes today.\
"""

FIXTURE_MODULE_DOC = """\

// What Python's `ab_harness.py` returns from `binomial_two_sided_p`,
// `wilson_interval` and `bootstrap_mean_ci`, for `statsParity.test.ts`.
//
// `web/src/ab/stats.ts` is a hand-port of those three, and until #211 nothing
// checked it. It is not an ordinary uncovered module: every A/B result this
// project has shipped a decision on was reported through these functions on one
// side or the other. A divergence would not turn a suite red - it would make a
// decision wrong, quietly, and the run that made it would read exactly like a
// run that did not.
//
// Pinned - the inputs, and for the bootstrap the resampling draws. Python
// resamples through `random.Random.randrange` and TS through
// `Math.floor(rand() * n)`; those are different generators and no seed makes
// them agree, so the draws are recorded and replayed into both. What is left to
// compare is the interval construction itself, which is the hand-ported part.
//
// Checked - the numbers, to `RELATIVE_TOLERANCE`. Not bit-equality: the exact
// binomial genuinely uses different arithmetic on the two sides (`math.comb`
// versus a Lanczos `logGamma`, by design, because the exact coefficient
// overflows a double not far above a thousand trials). See the tolerance's own
// note below for why 1e-9 is both far above the disagreement that produces and
// far below any porting error.
//
// Each case carries the reason it exists. A numerical fixture without them is a
// wall of digits, and the next reader has no way to tell a load-bearing case
// from a duplicate.\
"""


def build_fixture_module(artefact):
    """The generated `statsParity.fixture.ts`, as a string."""
    lines = [_comment_block(FIXTURE_HEADER), FIXTURE_MODULE_DOC, ""]

    lines.append(_comment_block(
        "Relative, because these p-values span 1.0 down to 5e-79 and an absolute\n"
        "tolerance would assert nothing about the tail - which is the half of the\n"
        "range the two sides compute differently. Measured rather than guessed:\n"
        "across this fixture the two disagree at all on 22 of 85 numbers, every\n"
        "one a binomial p-value, worst 1.5e-13 relative on the 1000-trial\n"
        "near-shutout. The Wilson and bootstrap cases are bit-identical, which is\n"
        "what a line-by-line port of the same arithmetic should be. The tightest\n"
        "porting error worth the name is a mistyped constant - 1.9599 for 1.96 -\n"
        "which moves a result by 5e-5. Nothing plausible lands in between, and\n"
        "`statsParity.test.ts` asserts both bounds rather than describing them."
    ))
    lines.append(f"export const RELATIVE_TOLERANCE = {_number(artefact['relative_tolerance'])}")
    lines.append("")
    lines.append(_comment_block(
        "The perturbation the sensitivity test applies to every recorded value:\n"
        "three orders above the tolerance, five below the mistyped-constant slip.\n"
        "It stands in for the smallest error a human could introduce, without\n"
        "being tuned to any one case."
    ))
    lines.append(f"export const SENSITIVITY_PERTURBATION = {_number(artefact['sensitivity_perturbation'])}")
    lines.append("")

    lines.append(_comment_block(
        "Python's default arguments, read out of its signatures. Every case below\n"
        "passes these explicitly, and production passes none of them:\n"
        "`ab_harness.py` reports `wilson_interval(pairs_a, decisive_pairs)` and\n"
        "`abRun.ts` reports `wilsonInterval(pairsA, decisivePairs)` and\n"
        "`bootstrapMeanCi(pairMargins, makeRng(ciSeed))`. So a default that had\n"
        "drifted - 1.9599 for 1.96 in one signature - would move every published\n"
        "interval while leaving every explicit-argument case green. Pinned\n"
        "separately for that reason."
    ))
    defaults = artefact["defaults"]
    lines.append("export const PYTHON_DEFAULTS = {")
    lines.append(f"  binomialP: {_number(defaults['binomial_p'])},")
    lines.append(f"  wilsonZ: {_number(defaults['wilson_z'])},")
    lines.append(f"  bootstrapIters: {int(defaults['bootstrap_iters'])},")
    lines.append(f"  bootstrapAlpha: {_number(defaults['bootstrap_alpha'])},")
    lines.append("} as const")
    lines.append("")

    lines.append("export interface BinomialCase {")
    lines.append("  readonly id: string")
    lines.append("  /** Why this case is in the fixture. */")
    lines.append("  readonly note: string")
    lines.append("  readonly wins: number")
    lines.append("  readonly trials: number")
    lines.append("  readonly p: number")
    lines.append("  /** What `ab_harness.binomial_two_sided_p` returns. */")
    lines.append("  readonly expected: number")
    lines.append("}")
    lines.append("")

    lines.append("export interface WilsonCase {")
    lines.append("  readonly id: string")
    lines.append("  readonly note: string")
    lines.append("  readonly wins: number")
    lines.append("  readonly trials: number")
    lines.append("  readonly z: number")
    lines.append("  /** What `ab_harness.wilson_interval` returns. */")
    lines.append("  readonly expected: readonly [number, number]")
    lines.append("}")
    lines.append("")

    lines.append(_comment_block(
        "`draws` is the recorded uniform sequence, consumed one per resample\n"
        "pick, left to right. `bootstrapMeanCi` takes `rand: () => number`, so\n"
        "the test hands it a closure over this array and both sides select the\n"
        "same indices. It is empty for the cases that return before resampling."
    ))
    lines.append("export interface BootstrapCase {")
    lines.append("  readonly id: string")
    lines.append("  readonly note: string")
    lines.append("  readonly values: readonly number[]")
    lines.append("  readonly iters: number")
    lines.append("  readonly alpha: number")
    lines.append("  /** Seeded the draws in Python. Recording detail; neither side derives anything from it. */")
    lines.append("  readonly seed: number")
    lines.append("  readonly draws: readonly number[]")
    lines.append("  /** What `ab_harness.bootstrap_mean_ci` returns given those draws. */")
    lines.append("  readonly expected: readonly [number, number]")
    lines.append("}")
    lines.append("")

    lines.append("export const BINOMIAL_CASES: readonly BinomialCase[] = [")
    for case in artefact["binomial"]:
        lines.append("  {")
        lines.append(f"    id: {_string(case['id'])},")
        lines.append(f"    note: {_string(case['note'])},")
        lines.append(f"    wins: {case['wins']},")
        lines.append(f"    trials: {case['trials']},")
        lines.append(f"    p: {_number(case['p'])},")
        lines.append(f"    expected: {_number(case['expected'])},")
        lines.append("  },")
    lines.append("]")
    lines.append("")

    lines.append("export const WILSON_CASES: readonly WilsonCase[] = [")
    for case in artefact["wilson"]:
        lines.append("  {")
        lines.append(f"    id: {_string(case['id'])},")
        lines.append(f"    note: {_string(case['note'])},")
        lines.append(f"    wins: {case['wins']},")
        lines.append(f"    trials: {case['trials']},")
        lines.append(f"    z: {_number(case['z'])},")
        lines.append(f"    expected: [{_number(case['expected'][0])}, {_number(case['expected'][1])}],")
        lines.append("  },")
    lines.append("]")
    lines.append("")

    lines.append("export const BOOTSTRAP_CASES: readonly BootstrapCase[] = [")
    for case in artefact["bootstrap"]:
        lines.append("  {")
        lines.append(f"    id: {_string(case['id'])},")
        lines.append(f"    note: {_string(case['note'])},")
        lines.append(f"    values: {_number_list(case['values'])},")
        lines.append(f"    iters: {case['iters']},")
        lines.append(f"    alpha: {_number(case['alpha'])},")
        lines.append(f"    seed: {case['seed']},")
        lines.append(f"    draws: {_wrapped_number_list(case['draws'], '    ')},")
        lines.append(f"    expected: [{_number(case['expected'][0])}, {_number(case['expected'][1])}],")
        lines.append("  },")
    lines.append("]")
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Read / render / check
# ---------------------------------------------------------------------------

def read_cases(path=CASES_JSON_PATH):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def cases_json_text(artefact):
    """The committed JSON, formatted so a re-record produces a readable diff."""
    return json.dumps(artefact, indent=2, ensure_ascii=False) + "\n"


def generated_files(artefact=None):
    """{path: contents} for every file this exporter owns, from the JSON."""
    if artefact is None:
        artefact = read_cases()
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


# ---------------------------------------------------------------------------
# The check.
#
# The report is most of the value of a guard. `generate_rollout_dataset.py`'s
# `--check` is trusted because its failure text says what a mismatch MEANS and
# what to do about it; a bare "mismatch" reads as "the check is broken", and the
# next person switches it off. There are two distinct failures here and they
# call for opposite responses, so they are reported separately rather than as
# one staleness list.
# ---------------------------------------------------------------------------

STALE_JSON_REPORT = """\
stats_parity_cases.json no longer matches what ab_harness.py computes.

WHAT THIS MEANS. One of `binomial_two_sided_p`, `wilson_interval` or
`bootstrap_mean_ci` returns something different than it did when these cases
were recorded. Python is authoritative for this pair, so the recording is out of
date rather than wrong - but web/src/ab/stats.ts is a hand-port of those three
functions and has NOT moved with them, so the two harnesses are now reporting
different numbers from the same run. Every A/B comparison that crosses them
is affected.

THE FIX, in this order:
  1. Decide whether the Python change was intended. If it was not, that is the
     bug and this guard has just found it.
  2. If it was, port the same change into web/src/ab/stats.ts.
  3. Re-record: `python export_stats_parity.py --record`, and commit both
     stats_parity_cases.json and web/src/ab/statsParity.fixture.ts.
  4. Run `cd web && npm test` - statsParity.test.ts is what confirms the port
     actually landed. Re-recording alone makes this check pass while leaving the
     TypeScript wrong, which is the one outcome worse than no fixture.

The differing cases:\
"""

STALE_TS_REPORT = """\
web/src/ab/statsParity.fixture.ts is not what export_stats_parity.py renders
from stats_parity_cases.json.

WHAT THIS MEANS. The committed TypeScript carries numbers that did not come out
of Python. Either the JSON was re-recorded without re-rendering, or the fixture
was edited by hand - and a hand-edited fixture is invisible to both suites
otherwise, because the TS side would be checking stats.ts against whatever the
edit said and reporting parity.

THE FIX is `python export_stats_parity.py`, then commit the result. Do not edit
the fixture directly; it is generated, and the next render will discard it.\
"""


def compare_with_python(artefact):
    """Cases whose recorded output is not what `ab_harness.py` returns now.

    Returns a list of human-readable lines, empty when the recording is current.
    Recording is pure - same inputs, same numbers - so this is an exact
    comparison rather than a tolerant one. The tolerance in this file is for
    comparing two *languages*, not two runs of the same one.
    """
    fresh = record_cases()
    differences = []

    recorded_defaults = artefact.get("defaults", {})
    for name, value in fresh["defaults"].items():
        if recorded_defaults.get(name) != value:
            differences.append(
                f"  default {name}: recorded {recorded_defaults.get(name)}, "
                f"ab_harness.py's signature now says {value}  (production calls "
                "these functions without the argument, on both sides)"
            )

    for kind in ("binomial", "wilson", "bootstrap"):
        recorded = {case["id"]: case for case in artefact.get(kind, [])}
        current = {case["id"]: case for case in fresh[kind]}
        for case_id in sorted(set(recorded) | set(current)):
            if case_id not in recorded:
                differences.append(f"  {kind} {case_id}: not in the committed JSON")
            elif case_id not in current:
                differences.append(f"  {kind} {case_id}: recorded, but no longer a case")
            elif recorded[case_id] != current[case_id]:
                differences.append(
                    f"  {kind} {case_id}: recorded {recorded[case_id]['expected']}, "
                    f"ab_harness.py now says {current[case_id]['expected']}"
                    f"  ({recorded[case_id]['note']})"
                )
    return differences


def main():
    parser = argparse.ArgumentParser(
        description="Record ab_harness.py's statistics for the TS parity suite (#211)",
    )
    parser.add_argument("--record", action="store_true",
                        help="re-run the statistics and rewrite stats_parity_cases.json as well")
    parser.add_argument("--check", action="store_true",
                        help="exit non-zero if either artefact is stale, writing nothing")
    args = parser.parse_args()

    if args.check:
        artefact = read_cases()
        failed = False

        differences = compare_with_python(artefact)
        if differences:
            failed = True
            print(STALE_JSON_REPORT)
            for line in differences:
                print(line)
            print("")

        stale = stale_files(generated_files(artefact))
        if stale:
            failed = True
            print(STALE_TS_REPORT)
            for path in stale:
                print(f"  stale: {os.path.relpath(path, REPO_ROOT)}")
            print("")

        if failed:
            return 1
        print("stats_parity_cases.json matches ab_harness.py, and the generated "
              "TypeScript matches the JSON")
        return 0

    if args.record:
        artefact = record_cases()
        write_files({CASES_JSON_PATH: cases_json_text(artefact)})
        print(f"wrote {os.path.relpath(CASES_JSON_PATH, REPO_ROOT)}"
              f" ({len(artefact['binomial'])} binomial, {len(artefact['wilson'])} wilson,"
              f" {len(artefact['bootstrap'])} bootstrap cases)")
    else:
        artefact = read_cases()

    files = generated_files(artefact)
    write_files(files)
    for path in files:
        print(f"wrote {os.path.relpath(path, REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

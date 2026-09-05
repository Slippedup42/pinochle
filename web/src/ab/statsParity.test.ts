// Does `stats.ts` return what `ab_harness.py` returns? (issue #211)
//
// `web/src/ab/stats.ts` is a hand-port of the three statistics in
// `ab_harness.py`, and until this file it was the last thing crossing the
// Python/TypeScript boundary that was neither generated nor guarded. That is
// worse than an ordinary gap in coverage, because these functions are not part
// of the product - they are what the product's *decisions* are judged by. #115's
// call to ship the distilled evaluator, #153's trick-play dial, #255's
// third-bidder floor and #227's re-baseline were all reported through them, on
// one side or the other. A divergence would not turn anything red. It would
// make a decision wrong, and the run that made it would read exactly like a run
// that did not.
//
// `ab.test.ts` already checks these functions against hand-computable values,
// and keeps doing so; that is a different question. It asks whether the TS
// implementation is *correct*. This one asks whether it is the *same* - which
// is what makes an A/B number measured in the browser comparable to one
// measured in Python, and it is the question #118 showed nobody was asking.
//
// The fixture is generated. `export_stats_parity.py` records these inputs and
// outputs by running the Python functions, and `test_export_stats_parity.py`
// fails the Python suite if the recording no longer matches what Python says or
// if the committed TypeScript is not what the exporter renders. So the loop is
// closed at both ends: neither side can drift without a suite going red, and
// neither can be quietly hand-edited into agreement.
//
// WHY THE BOOTSTRAP TAKES ITS DRAWS FROM THE FIXTURE. Python resamples via
// `random.Random.randrange` and this module via `Math.floor(rand() * n)` over an
// injected generator. Those are different PRNGs and no seed will ever make them
// agree, exactly as the two engines' shuffles never produce the same deal. So
// the uniforms are recorded and replayed into both, which makes the resample
// identical and leaves the interval construction - the mean, the sort, the
// percentile index and its clamp - as the thing under comparison. That is
// precisely the hand-ported part, and the PRNG is not.

import { describe, expect, it } from 'vitest'

import {
  BINOMIAL_CASES,
  BOOTSTRAP_CASES,
  PYTHON_DEFAULTS,
  RELATIVE_TOLERANCE,
  SENSITIVITY_PERTURBATION,
  WILSON_CASES,
} from './statsParity.fixture'
import { binomialTwoSidedP, bootstrapMeanCi, wilsonInterval } from './stats'

/**
 * Relative agreement, with an absolute floor at exact zero.
 *
 * Relative rather than absolute because the recorded p-values run from 1.0 down
 * to 5e-79, and an absolute tolerance would be asserting nothing whatever about
 * the tail - which is the half of the range where the two implementations
 * genuinely differ in method. Zero is the one value a relative comparison
 * cannot express, and every recorded zero here is a structural zero (a clamped
 * interval end, an empty-sample bootstrap) rather than a rounded one, so it is
 * required exactly.
 */
function relativeDelta(actual: number, expected: number): number {
  if (expected === 0) return actual === 0 ? 0 : Infinity
  return Math.abs(actual - expected) / Math.abs(expected)
}

function replayDraws(draws: readonly number[]): () => number {
  let position = 0
  return () => {
    // Reading past the end would silently become NaN indices and an interval of
    // NaNs, which is a failure that reads as a maths bug rather than as a
    // fixture that was handed the wrong number of draws.
    if (position >= draws.length) {
      throw new Error(`ran out of recorded draws after ${draws.length}`)
    }
    return draws[position++]
  }
}

describe('stats.ts against ab_harness.py (#211)', () => {
  it('returns the exact binomial p-value Python returns, tails included', () => {
    for (const testCase of BINOMIAL_CASES) {
      const actual = binomialTwoSidedP(testCase.wins, testCase.trials, testCase.p)
      expect(
        relativeDelta(actual, testCase.expected),
        `${testCase.id} (${testCase.note}): TS ${actual}, Python ${testCase.expected}`,
      ).toBeLessThanOrEqual(RELATIVE_TOLERANCE)
    }
  })

  it('returns the Wilson interval Python returns, clamps included', () => {
    for (const testCase of WILSON_CASES) {
      const [low, high] = wilsonInterval(testCase.wins, testCase.trials, testCase.z)
      const label = `${testCase.id} (${testCase.note})`
      expect(
        relativeDelta(low, testCase.expected[0]),
        `${label} low: TS ${low}, Python ${testCase.expected[0]}`,
      ).toBeLessThanOrEqual(RELATIVE_TOLERANCE)
      expect(
        relativeDelta(high, testCase.expected[1]),
        `${label} high: TS ${high}, Python ${testCase.expected[1]}`,
      ).toBeLessThanOrEqual(RELATIVE_TOLERANCE)
    }
  })

  it('builds the same bootstrap interval Python builds from the same draws', () => {
    for (const testCase of BOOTSTRAP_CASES) {
      const [low, high] = bootstrapMeanCi(
        testCase.values,
        replayDraws(testCase.draws),
        testCase.iters,
        testCase.alpha,
      )
      const label = `${testCase.id} (${testCase.note})`
      expect(
        relativeDelta(low, testCase.expected[0]),
        `${label} low: TS ${low}, Python ${testCase.expected[0]}`,
      ).toBeLessThanOrEqual(RELATIVE_TOLERANCE)
      expect(
        relativeDelta(high, testCase.expected[1]),
        `${label} high: TS ${high}, Python ${testCase.expected[1]}`,
      ).toBeLessThanOrEqual(RELATIVE_TOLERANCE)
    }
  })

  // -------------------------------------------------------------------------
  // The default arguments, which are the ones production actually uses.
  //
  // Every case above passes `p`, `z`, `iters` and `alpha` explicitly, and
  // neither harness passes any of them: `abRun.ts` calls
  // `wilsonInterval(pairsA, decisivePairs)` and
  // `bootstrapMeanCi(pairMargins, makeRng(ciSeed))`, and `ab_harness.py` does
  // the same. So a default that had drifted between the two signatures would
  // move every published confidence interval in this project while leaving all
  // eighty-five recorded cases green - which is not a hypothetical: it is what
  // the first draft of this fixture missed, and it was found by mistyping
  // Python's `z` and watching the check stay silent.
  // -------------------------------------------------------------------------

  it('defaults to the same arguments Python defaults to', () => {
    expect(binomialTwoSidedP(211, 261)).toBe(binomialTwoSidedP(211, 261, PYTHON_DEFAULTS.binomialP))
    expect(wilsonInterval(211, 261)).toEqual(
      wilsonInterval(211, 261, PYTHON_DEFAULTS.wilsonZ),
    )

    // The bootstrap's two defaults are read off behaviour rather than compared
    // as values, because they are not arguments a caller can see. `iters` is
    // exactly the number of resample picks divided by the sample size; `alpha`
    // is pinned by running the same draws with and without it and requiring the
    // same interval - and then, so that equality is known to mean something on
    // this data rather than being a tie, requiring a *different* alpha to give
    // a different one.
    const sample = [-140, -35, 0, 60, 205]
    let picks = 0
    bootstrapMeanCi(sample, () => {
      picks += 1
      return 0.5
    })
    expect(picks).toBe(PYTHON_DEFAULTS.bootstrapIters * sample.length)

    const draws = BOOTSTRAP_CASES.find((c) => c.draws.length > 0)!.draws
    // Cycled rather than consumed once: this comparison is TypeScript against
    // TypeScript, so the repetition costs nothing, and the alternative is
    // 25,000 recorded uniforms in the fixture to reach the default `iters`.
    const cycled = () => {
      let i = 0
      return () => draws[i++ % draws.length]
    }
    const implied = bootstrapMeanCi(sample, cycled())
    expect(implied).toEqual(
      bootstrapMeanCi(sample, cycled(), PYTHON_DEFAULTS.bootstrapIters, PYTHON_DEFAULTS.bootstrapAlpha),
    )
    expect(implied).not.toEqual(
      bootstrapMeanCi(sample, cycled(), PYTHON_DEFAULTS.bootstrapIters, 0.5),
    )
  })

  // -------------------------------------------------------------------------
  // Is the tolerance tight enough to catch anything?
  //
  // A parity fixture with a slack tolerance is worse than none: it reports
  // agreement it did not check. The two tests below bound it from both sides
  // rather than arguing for the number in prose - the first says the tolerance
  // is not being spent, the second says an error of a size a human could
  // actually introduce does not fit inside it.
  // -------------------------------------------------------------------------

  it('is nowhere near spending its tolerance on the cases it carries', () => {
    let worst = 0
    let worstLabel = ''
    const record = (delta: number, label: string) => {
      if (delta > worst) {
        worst = delta
        worstLabel = label
      }
    }

    for (const testCase of BINOMIAL_CASES) {
      const actual = binomialTwoSidedP(testCase.wins, testCase.trials, testCase.p)
      record(relativeDelta(actual, testCase.expected), testCase.id)
    }
    for (const testCase of WILSON_CASES) {
      const [low, high] = wilsonInterval(testCase.wins, testCase.trials, testCase.z)
      record(relativeDelta(low, testCase.expected[0]), `${testCase.id} low`)
      record(relativeDelta(high, testCase.expected[1]), `${testCase.id} high`)
    }
    for (const testCase of BOOTSTRAP_CASES) {
      const [low, high] = bootstrapMeanCi(
        testCase.values,
        replayDraws(testCase.draws),
        testCase.iters,
        testCase.alpha,
      )
      record(relativeDelta(low, testCase.expected[0]), `${testCase.id} low`)
      record(relativeDelta(high, testCase.expected[1]), `${testCase.id} high`)
    }

    // Two orders of headroom below the tolerance. If a new case ever lands
    // between here and 1e-9 that is worth knowing about explicitly - it would
    // mean the log-space route had found a regime where it is much less
    // accurate than it is anywhere in this fixture - rather than being absorbed
    // by a tolerance that quietly has less margin than its comment claims.
    expect(worst, `worst relative disagreement was on ${worstLabel}`).toBeLessThan(
      RELATIVE_TOLERANCE / 100,
    )
  })

  it('would reject every recorded value moved by less than a mistyped constant', () => {
    // `SENSITIVITY_PERTURBATION` is 1e-6 relative: three orders above the
    // tolerance, and still five orders *below* the smallest porting slip worth
    // the name - 1.9599 typed for 1.96 in the Wilson z moves a result by 5e-5.
    // So this is the statement that matters: the comparison above is not merely
    // passing, it is discriminating, on every single recorded number.
    const recorded = [
      ...BINOMIAL_CASES.map((c) => [c.id, c.expected] as const),
      ...WILSON_CASES.flatMap((c) => [
        [`${c.id} low`, c.expected[0]] as const,
        [`${c.id} high`, c.expected[1]] as const,
      ]),
      ...BOOTSTRAP_CASES.flatMap((c) => [
        [`${c.id} low`, c.expected[0]] as const,
        [`${c.id} high`, c.expected[1]] as const,
      ]),
    ]

    expect(recorded.length).toBeGreaterThan(60)
    for (const [label, expected] of recorded) {
      // A structural zero is compared exactly, so any perturbation at all is a
      // failure and the relative form has nothing to say. Nudge it absolutely.
      const perturbed =
        expected === 0 ? SENSITIVITY_PERTURBATION : expected * (1 + SENSITIVITY_PERTURBATION)
      expect(
        relativeDelta(perturbed, expected),
        `${label}: a ${SENSITIVITY_PERTURBATION} relative error would slip through`,
      ).toBeGreaterThan(RELATIVE_TOLERANCE)
    }
  })

  // -------------------------------------------------------------------------
  // Coverage of the fixture, asserted rather than assumed.
  //
  // A numerical fixture is worth exactly the shapes of input it contains, and
  // that is not visible by reading a wall of digits. These pin the ones the
  // cases were chosen for, so a future edit that drops the last zero-trial case
  // or the last asymmetric `p` says so.
  // -------------------------------------------------------------------------

  it('covers the contract each function documents for a degenerate input', () => {
    expect(BINOMIAL_CASES.some((c) => c.trials <= 0 && c.expected === 1)).toBe(true)
    expect(
      WILSON_CASES.some((c) => c.trials <= 0 && c.expected[0] === 0 && c.expected[1] === 1),
    ).toBe(true)
    expect(
      BOOTSTRAP_CASES.some(
        (c) => c.values.length === 0 && c.expected[0] === 0 && c.expected[1] === 0,
      ),
    ).toBe(true)
    expect(
      BOOTSTRAP_CASES.some(
        (c) => c.values.length === 1 && c.expected[0] === c.values[0] && c.expected[1] === c.values[0],
      ),
    ).toBe(true)
  })

  it('covers the binomial tail deep enough that the log-space route is the whole answer', () => {
    // Below about 1e-300 the exact side's coefficient stops fitting in a double
    // at all, which is why `stats.ts` works in logs. A fixture that stopped at
    // p = 0.01 would never visit the regime the two implementations were
    // written differently for.
    expect(BINOMIAL_CASES.some((c) => c.expected > 0 && c.expected < 1e-70)).toBe(true)
    expect(BINOMIAL_CASES.some((c) => c.trials >= 1000)).toBe(true)
    // And `p` away from 0.5, where the exact side no longer has an identical
    // symmetric partner and the inclusion slack has to do real work.
    expect(BINOMIAL_CASES.some((c) => c.p !== 0.5)).toBe(true)
  })

  it('covers a bootstrap percentile index at each end and one in the middle', () => {
    const lowIndex = (c: { alpha: number; iters: number }) => Math.floor((c.alpha / 2) * c.iters)
    const highIndex = (c: { alpha: number; iters: number }) =>
      Math.floor((1 - c.alpha / 2) * c.iters)
    const resampling = BOOTSTRAP_CASES.filter((c) => c.values.length > 1)

    expect(resampling.some((c) => lowIndex(c) === 0)).toBe(true)
    expect(resampling.some((c) => lowIndex(c) > 1)).toBe(true)
    // The only thing that exercises `Math.min(iters - 1, ...)`: without the
    // clamp this indexes one past the end and the interval's high side is
    // `undefined`, which arithmetic turns into NaN rather than into an error.
    expect(resampling.some((c) => highIndex(c) >= c.iters)).toBe(true)
    expect(resampling.some((c) => highIndex(c) < c.iters - 1)).toBe(true)
    // Signed samples, because the statistic is applied to score margins and
    // "the interval excludes zero" is the claim it exists to support.
    expect(resampling.some((c) => c.values.some((v) => v < 0))).toBe(true)
    expect(resampling.some((c) => c.expected[0] > 0)).toBe(true)
    expect(resampling.some((c) => c.expected[0] < 0 && c.expected[1] > 0)).toBe(true)
  })
})

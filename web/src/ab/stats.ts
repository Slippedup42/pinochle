// The three statistics `ab_harness.py` reports, ported to TS (#115).
//
// This is a deliberate port rather than a fresh design. #115's A/B compares two
// TypeScript AIs, so the Python harness cannot run it — but its *discipline* is
// the part that matters, and re-deriving it here would be how a subtly weaker
// test creeps in. The three functions below are `binomial_two_sided_p`,
// `wilson_interval` and `bootstrap_mean_ci` from that module, with the same
// contracts:
//
//   - `binomialTwoSidedP` returns 1.0 on zero trials. No evidence is not
//     evidence of no difference, and 1.0 is the value that stops a caller
//     claiming one.
//   - The interval on margin is a percentile bootstrap, not a normal
//     approximation. Pinochle margins are a mix of comfortable wins, blowouts
//     and near-ties; nothing about them is normal.
//   - Wilson rather than the normal approximation for a rate, because it stays
//     inside [0, 1] at the extremes a small run hits regularly.
//
// One genuine difference from Python. `math.comb` there is exact arbitrary
// precision; here the binomial coefficient goes through `logGamma`, because a
// run with a few hundred decisive pairs produces a coefficient near the double
// overflow boundary multiplied by a probability near the underflow one. Working
// in log space keeps the product accurate. The consequence is that two outcomes
// that are exactly symmetric can differ in the last bits, which is why the
// "no more likely than observed" comparison carries a relative tolerance — the
// same tolerance, and for the same reason, as the Python original.

/** Lanczos log-gamma (g=7, n=9). Accurate to ~1e-15 relative over the range
 *  factorials of trial counts need, which is far more than a sign test does. */
function logGamma(x: number): number {
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ]
  if (x < 0.5) {
    // Reflection, so the caller never has to care which side of 0.5 it is on.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)
  }
  const z = x - 1
  let a = g[0]
  const t = z + 7.5
  for (let i = 1; i < 9; i++) a += g[i] / (z + i)
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a)
}

function logChoose(n: number, k: number): number {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1)
}

/**
 * Exact two-sided binomial test that `wins` out of `trials` differs from `p`.
 * Sums the probability of every outcome no more likely than the observed one —
 * the standard exact construction, and the one that behaves sensibly for the
 * small symmetric case a paired A/B produces.
 */
export function binomialTwoSidedP(wins: number, trials: number, p = 0.5): number {
  if (trials <= 0) return 1
  const pmf = (k: number) =>
    Math.exp(logChoose(trials, k) + k * Math.log(p) + (trials - k) * Math.log(1 - p))
  const observed = pmf(wins)
  const tolerance = observed * 1e-9
  let total = 0
  for (let k = 0; k <= trials; k++) {
    const q = pmf(k)
    if (q <= observed + tolerance) total += q
  }
  return Math.min(1, total)
}

/** Wilson score interval for a win rate. */
export function wilsonInterval(wins: number, trials: number, z = 1.96): [number, number] {
  if (trials <= 0) return [0, 1]
  const phat = wins / trials
  const denom = 1 + (z * z) / trials
  const centre = (phat + (z * z) / (2 * trials)) / denom
  const half =
    (z * Math.sqrt((phat * (1 - phat)) / trials + (z * z) / (4 * trials * trials))) / denom
  return [Math.max(0, centre - half), Math.min(1, centre + half)]
}

/**
 * Percentile-bootstrap confidence interval for the mean of `values`.
 *
 * Games-won is coarse: it discards *how* a game was won, so a real edge can
 * fail to register over a few hundred games. Margin keeps that magnitude, and
 * an interval on it will usually resolve a difference long before games-won
 * does. An interval excluding zero is evidence of a real difference in margin.
 *
 * `rand` is injected rather than taken from `Math.random` so a reported
 * interval is reproducible from the run's seed alone.
 */
export function bootstrapMeanCi(
  values: readonly number[],
  rand: () => number,
  iters = 5000,
  alpha = 0.05,
): [number, number] {
  const n = values.length
  if (n === 0) return [0, 0]
  if (n === 1) return [values[0], values[0]]

  const means: number[] = []
  for (let i = 0; i < iters; i++) {
    let total = 0
    for (let j = 0; j < n; j++) total += values[Math.floor(rand() * n)]
    means.push(total / n)
  }
  means.sort((a, b) => a - b)
  return [means[Math.floor((alpha / 2) * iters)], means[Math.min(iters - 1, Math.floor((1 - alpha / 2) * iters))]]
}

/** Percentile of an unsorted sample, by nearest rank. Used for the latency
 *  report, where p95 is the number that decides whether a model is affordable
 *  and the mean is the number that hides a stall. */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[idx]
}

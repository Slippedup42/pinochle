// CLI entry point for #115's two measurements.
//
// Run through jiti, which is already a dependency (Tailwind pulls it in) and
// executes TypeScript directly, so this needs no build step and no new package:
//
//   node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts ab --pairs 400
//   node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts selftest --pairs 100
//   node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts latency --positions 4000
//
// `selftest` is the harness's own correctness check, exactly as in
// `ab_harness.py`: one policy against itself must not produce a significant
// result, because only seating, deal assignment or bookkeeping could separate
// the two sides. Run it before believing anything the `ab` command says.
//
// `process` is reached through `globalThis` because tsconfig.app.json does not
// load Node's types — this file lives under `src` so it is type-checked with
// the rest of the engine, and paying for that with one cast is the cheaper
// trade than a second tsconfig project.

import { DISTILLED_LEVEL, STATIC_LEVEL, analyse, runAb, summarise } from './abRun'
import { formatLatency, runLatencyBenchmark } from './latency'

const argv = (globalThis as { process?: { argv: string[] } }).process?.argv ?? []
const args = argv.slice(2)
const command = args[0] ?? 'ab'

function flag(name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`)
  if (i === -1 || i + 1 >= args.length) return fallback
  const value = Number(args[i + 1])
  return Number.isFinite(value) ? value : fallback
}

if (command === 'ab' || command === 'selftest') {
  const pairs = flag('pairs', command === 'selftest' ? 100 : 400)
  const seed = flag('seed', 1)
  // `--policy distilled` self-tests the model path instead of the threshold
  // path. Worth having separately: the evaluator is the side that could be
  // non-deterministic, and a self-test that never exercises it would not notice.
  const policy = args.includes('--policy') ? args[args.indexOf('--policy') + 1] : 'static'
  const level = policy === 'distilled' ? DISTILLED_LEVEL : STATIC_LEVEL
  const report =
    command === 'selftest'
      ? runAb({ nPairs: pairs, seed, labelA: `${policy} A`, labelB: `${policy} B`, levelA: level, levelB: level })
      : runAb({ nPairs: pairs, seed, levelA: DISTILLED_LEVEL, levelB: STATIC_LEVEL })
  console.log(summarise(report, analyse(report, seed)))
} else if (command === 'latency') {
  const positions = flag('positions', 3000)
  const repeats = flag('repeats', 40)
  console.log(formatLatency(runLatencyBenchmark(positions, repeats)))
} else {
  console.log('usage: cli.ts [ab|selftest|latency] [--pairs N] [--seed N] [--positions N] [--repeats N]')
}

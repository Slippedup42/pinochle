// CLI entry point for the A/B measurements (#115, #123, #153).
//
// Run through jiti, which is already a dependency (Tailwind pulls it in) and
// executes TypeScript directly, so this needs no build step and no new package:
//
//   node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts ab --pairs 400
//   node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts fold --pairs 400
//   node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts play --pairs 400
//   node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts selftest --pairs 100
//   node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts latency --positions 4000
//
// `selftest` is the harness's own correctness check, exactly as in
// `ab_harness.py`: one policy against itself must not produce a significant
// result, because only seating, deal assignment or bookkeeping could separate
// the two sides. Run it before believing anything the `ab` command says.
//
// `--policy` names which arm the self-test doubles up, and so also which dial
// it exercises: `static`/`distilled` are the bidding pair, `simple`/`cascade`
// the trick-play pair. Worth having each separately — a self-test that never
// runs a policy cannot vouch for it, and the paths differ in what could go
// wrong (the evaluator is the one that could be non-deterministic; card play is
// the one reached tens of times per round rather than once per auction).
//
// `process` is reached through `globalThis` because tsconfig.app.json does not
// load Node's types — this file lives under `src` so it is type-checked with
// the rest of the engine, and paying for that with one cast is the cheaper
// trade than a second tsconfig project.

import type { SkillParams } from '../engine/skills'
import type { SkillLevel } from '../persistence/options'
import {
  BID_AB_POLICIES,
  DISTILLED_LEVEL,
  FOLD_AB_POLICIES,
  PLAY_AB_POLICIES,
  STATIC_LEVEL,
  analyse,
  runAb,
  summarise,
} from './abRun'
import { formatLatency, runLatencyBenchmark } from './latency'

/** Which level carries each named arm, and which override map has to be
 *  installed for that arm to exist at all. */
const SELFTEST_ARMS: Record<string, { level: SkillLevel; policies: Record<string, SkillParams> }> = {
  static: { level: STATIC_LEVEL, policies: BID_AB_POLICIES },
  distilled: { level: DISTILLED_LEVEL, policies: BID_AB_POLICIES },
  simple: { level: STATIC_LEVEL, policies: PLAY_AB_POLICIES },
  cascade: { level: DISTILLED_LEVEL, policies: PLAY_AB_POLICIES },
}

const argv = (globalThis as { process?: { argv: string[] } }).process?.argv ?? []
const args = argv.slice(2)
const command = args[0] ?? 'ab'

function flag(name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`)
  if (i === -1 || i + 1 >= args.length) return fallback
  const value = Number(args[i + 1])
  return Number.isFinite(value) ? value : fallback
}

if (command === 'fold') {
  // #123's measurement: identical distilled bidders, one allowed to concede.
  const pairs = flag('pairs', 400)
  const seed = flag('seed', 1)
  const report = runAb({
    nPairs: pairs,
    seed,
    labelA: 'fold',
    labelB: 'no-fold',
    policies: FOLD_AB_POLICIES,
  })
  console.log(summarise(report, analyse(report, seed)))
} else if (command === 'play') {
  // #153's measurement: identical bidders and folders, one side running the
  // Proficient cascade and one the simplified card play `easy` ships.
  const pairs = flag('pairs', 400)
  const seed = flag('seed', 1)
  const report = runAb({
    nPairs: pairs,
    seed,
    labelA: 'cascade',
    labelB: 'simple',
    policies: PLAY_AB_POLICIES,
  })
  console.log(summarise(report, analyse(report, seed)))
} else if (command === 'ab' || command === 'selftest') {
  const pairs = flag('pairs', command === 'selftest' ? 100 : 400)
  const seed = flag('seed', 1)
  const policy = args.includes('--policy') ? args[args.indexOf('--policy') + 1] : 'static'
  const arm = SELFTEST_ARMS[policy]
  if (command === 'selftest' && arm === undefined) {
    console.log(`unknown --policy '${policy}'; expected one of ${Object.keys(SELFTEST_ARMS).join(', ')}`)
  } else {
    const report =
      command === 'selftest'
        ? runAb({
            nPairs: pairs,
            seed,
            labelA: `${policy} A`,
            labelB: `${policy} B`,
            levelA: arm.level,
            levelB: arm.level,
            policies: arm.policies,
          })
        : runAb({ nPairs: pairs, seed, levelA: DISTILLED_LEVEL, levelB: STATIC_LEVEL })
    console.log(summarise(report, analyse(report, seed)))
  }
} else if (command === 'latency') {
  const positions = flag('positions', 3000)
  const repeats = flag('repeats', 40)
  console.log(formatLatency(runLatencyBenchmark(positions, repeats)))
} else {
  console.log(
    'usage: cli.ts [ab|fold|play|selftest|latency] [--pairs N] [--seed N] ' +
      `[--policy ${Object.keys(SELFTEST_ARMS).join('|')}] [--positions N] [--repeats N]`,
  )
}

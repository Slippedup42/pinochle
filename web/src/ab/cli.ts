// CLI entry point for the A/B measurements (#115, #123, #153, #158, #178).
//
// Run through jiti, which is already a dependency (Tailwind pulls it in) and
// executes TypeScript directly, so this needs no build step and no new package:
//
//   node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts ab --pairs 400
//   node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts fold --pairs 400
//   node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts play --pairs 400
//   node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts opening --pairs 5000
//   node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts autoset --pairs 5000
//   node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts safe --pairs 400 --level expert
//   node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts capacity --high expert --low easy
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
// the trick-play pair, `auto-set` the #178 one, `counted`/`uncounted` the #158
// one. Worth having each separately —
// a self-test that never runs a policy cannot vouch for it, and the paths
// differ in what could go wrong (the evaluator is the one that could be
// non-deterministic; card play is the one reached tens of times per round
// rather than once per auction; auto-SET is the one that ends a round early and
// so is the one that could desynchronise dealer rotation or scoring).
//
// `process` is reached through `globalThis` because tsconfig.app.json does not
// load Node's types — this file lives under `src` so it is type-checked with
// the rest of the engine, and paying for that with one cast is the cheaper
// trade than a second tsconfig project.

import type { SkillParams } from '../engine/skills'
import type { SkillLevel } from '../persistence/options'
import {
  AUTO_SET_AB_POLICIES,
  BID_AB_POLICIES,
  DISTILLED_LEVEL,
  FOLD_AB_POLICIES,
  OPENING_AB_POLICIES,
  PLAY_AB_POLICIES,
  SAFE_COUNTER_CONTROL,
  STATIC_LEVEL,
  analyse,
  runAb,
  safeCounterAbPolicies,
  safeCounterCapacityPolicies,
  summarise,
} from './abRun'
import { formatLatency, runLatencyBenchmark } from './latency'

const SKILL_LEVELS: readonly SkillLevel[] = ['easy', 'medium', 'hard', 'proficient', 'expert']

/** Which level carries each named arm, and which override map has to be
 *  installed for that arm to exist at all. */
const SELFTEST_ARMS: Record<string, { level: SkillLevel; policies: Record<string, SkillParams> }> = {
  static: { level: STATIC_LEVEL, policies: BID_AB_POLICIES },
  distilled: { level: DISTILLED_LEVEL, policies: BID_AB_POLICIES },
  simple: { level: STATIC_LEVEL, policies: PLAY_AB_POLICIES },
  cascade: { level: DISTILLED_LEVEL, policies: PLAY_AB_POLICIES },
  'auto-set': { level: DISTILLED_LEVEL, policies: AUTO_SET_AB_POLICIES },
  walk: { level: DISTILLED_LEVEL, policies: OPENING_AB_POLICIES },
  'fixed-open': { level: STATIC_LEVEL, policies: OPENING_AB_POLICIES },
  // #158's two arms. `counted` doubles up the expert capacity against itself;
  // `uncounted` doubles up the baseline, which is the control that says the
  // safe-counter change is the only thing separating the two sides of a `safe`
  // run rather than the level names being read somewhere unexpected.
  counted: { level: 'expert', policies: safeCounterAbPolicies('expert', SAFE_COUNTER_CONTROL.expert) },
  uncounted: {
    level: SAFE_COUNTER_CONTROL.expert,
    policies: safeCounterAbPolicies('expert', SAFE_COUNTER_CONTROL.expert),
  },
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
} else if (command === 'autoset') {
  // #178's measurement: identical distilled bidders, both consulting the fold
  // model, one also forced to throw in a contract the arithmetic has killed.
  const pairs = flag('pairs', 400)
  const seed = flag('seed', 1)
  const report = runAb({
    nPairs: pairs,
    seed,
    labelA: 'auto-set',
    labelB: 'play-it-out',
    policies: AUTO_SET_AB_POLICIES,
  })
  console.log(summarise(report, analyse(report, seed)))
} else if (command === 'opening') {
  // #204's measurement: identical distilled bidders opening on identical hands,
  // one naming `OPENING_BID` and one naming the highest rung its own policy
  // still says the hand is worth.
  const pairs = flag('pairs', 400)
  const seed = flag('seed', 1)
  const report = runAb({
    nPairs: pairs,
    seed,
    labelA: 'walk',
    labelB: 'fixed-open',
    policies: OPENING_AB_POLICIES,
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
} else if (command === 'safe') {
  // #158's measurement: identical bidders, folders and cascades, one side
  // picking the counter that cannot be beaten and the other spending the
  // cheapest one. `--level` names the level the counted arm sits on, and so the
  // trump-memory capacity it gets (2 x skill) — the whole point is to run it at
  // more than one and see whether they separate. The baseline never consults a
  // memory, so it is the same opponent at every level.
  const pairs = flag('pairs', 400)
  const seed = flag('seed', 1)
  const levelArg = args.includes('--level') ? args[args.indexOf('--level') + 1] : 'expert'
  const level = SKILL_LEVELS.find((l) => l === levelArg)
  if (level === undefined) {
    console.log(`unknown --level '${levelArg}'; expected one of ${SKILL_LEVELS.join(', ')}`)
  } else {
    const control = SAFE_COUNTER_CONTROL[level]
    const report = runAb({
      nPairs: pairs,
      seed,
      labelA: `counted@${level}`,
      labelB: 'uncounted',
      levelA: level,
      levelB: control,
      policies: safeCounterAbPolicies(level, control),
    })
    console.log(summarise(report, analyse(report, seed)))
  }
} else if (command === 'capacity') {
  // #158's other measurement, and the direct one: both sides run the counted
  // rule, and the only thing separating them is how much trump each remembers.
  // `--high` and `--low` name the two levels; capacity is `2 x skill`.
  const pairs = flag('pairs', 400)
  const seed = flag('seed', 1)
  const pick = (name: string, fallback: SkillLevel) => {
    const raw = args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback
    return SKILL_LEVELS.find((l) => l === raw)
  }
  const high = pick('high', 'expert')
  const low = pick('low', 'easy')
  if (high === undefined || low === undefined || high === low) {
    console.log(`--high/--low must be two distinct levels from ${SKILL_LEVELS.join(', ')}`)
  } else {
    const report = runAb({
      nPairs: pairs,
      seed,
      labelA: `counted@${high}`,
      labelB: `counted@${low}`,
      levelA: high,
      levelB: low,
      policies: safeCounterCapacityPolicies(high, low),
    })
    console.log(summarise(report, analyse(report, seed)))
  }
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
    'usage: cli.ts [ab|fold|play|autoset|safe|capacity|selftest|latency] [--pairs N] [--seed N] ' +
      `[--policy ${Object.keys(SELFTEST_ARMS).join('|')}] [--level ${SKILL_LEVELS.join('|')}] ` +
      '[--high LEVEL] [--low LEVEL] [--positions N] [--repeats N]',
  )
}

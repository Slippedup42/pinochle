/// <reference types="node" />

// Measurement code must not be reachable from the shipped app (#236).
//
// `src/ab/` is the A/B harness, the latency instrument and the headless game
// driver. It lives inside `src/` because it drives the real engine and must not
// drift from it, and it stays out of the bundle because nothing the app loads
// happens to import it. Until this file, that was the whole of the enforcement:
// a true sentence about the current import graph, written down in `ROADMAP.md`
// and nowhere checked.
//
// WHY THAT IS WORTH A TEST RATHER THAN A CONVENTION. `installPolicies` in
// `abRun.ts` does not build a private copy of the tuning table - it writes rows
// into the shared `SKILL_PARAMS` and hands back a restore function. #222 kept
// `SKILL_PARAMS` mutable on purpose so the harness could do exactly that, and
// that decision is right: a mirrored A/B needs both policies live in one
// process, and installing them explicitly is what makes the measurement
// independent of whichever dial happens to be shipped. The cost of keeping the
// seam is that an accidental import is not "the harness got bundled", it is
// "engine configuration became writable at runtime in the product". A seam
// preserved deliberately is one to guard, not one to close.
//
// WHY REACHABILITY RATHER THAN A BAN ON THE IMPORT. The forbidden edge is
// directional. `src/ab/` imports the engine and the components constantly -
// that is the entire point of it, and a rule reading "nothing may import across
// the `ab/` boundary" would have to be suppressed on almost every file in the
// harness. Walking outward from `index.html`'s module scripts gets the
// asymmetry for free: the walk only ever follows edges away from the app, so
// `ab/ -> engine/` is never even visited, while `engine/ -> ab/` is found the
// moment it is written. It also settles the test question without an allowlist.
// `engine/round.test.ts` and `components/TrickPlayFlow.test.tsx` both import
// `dealFromRng` from `../ab/headlessGame` today; neither is reachable from an
// entry, so neither is a violation, and no carve-out has to be maintained for
// them.
//
// WHAT THIS DOES NOT CATCH. It is a static walk, so: a specifier built at
// runtime (`import('./' + name)`) is invisible to it; so is anything pulled in
// through a Vite alias or plugin virtual module, since it resolves relative and
// root-absolute specifiers only; and it says nothing about a *copy* of harness
// code pasted into an engine file, which is a different failure with a
// different remedy. It also does not check the emitted bundle - if Rollup ever
// included a module no entry imports, this would not see it. Those gaps are
// accepted because the mistake being guarded is the ordinary one: someone
// imports a type or a helper from `ab/` into an engine or component file
// because it was the nearest definition of the thing they wanted.

import { describe, expect, it } from 'vitest'
import {
  chainTo,
  dirOf,
  diskReader,
  htmlEntries,
  moduleSpecifiers,
  resolveSpecifier,
  walkImports,
  type GraphWalk,
  type SourceReader,
} from './importGraph'

/** `web/`, the directory a root-absolute `/src/...` in `index.html` hangs off. */
const webRoot = dirOf(import.meta.url, '../../')

/**
 * Directories, not files, so nothing here has to be maintained as `src/ab/`
 * grows. Each is a tree with its own dev-only HTML page that `vite build` never
 * takes as an input - `bench/index.html` for the latency instrument,
 * `layout/index.html` for the portrait-fit probe - which is precisely the
 * arrangement that makes them unreachable today and gives them nothing to
 * announce if that stops being true.
 */
const DEV_ONLY_TREES = [
  { prefix: 'src/ab/', what: 'the A/B harness, latency bench and headless driver' },
  { prefix: 'src/layout/', what: 'the portrait-fit probe served at /layout/' },
  // This directory, which reads the filesystem and imports the TypeScript
  // compiler. It has no dev page of its own and so no arrangement protecting
  // it, and it is the one tree where an accidental import would pull a
  // multi-megabyte parser into a phone's download. A guard that exempts itself
  // is a guard with a hole in it.
  { prefix: 'src/boundaries/', what: 'this import-graph guard and its parser' },
] as const

function forbiddenTree(relPath: string): (typeof DEV_ONLY_TREES)[number] | undefined {
  return DEV_ONLY_TREES.find((tree) => relPath.startsWith(tree.prefix))
}

function relative(path: string): string {
  return path.startsWith(`${webRoot}/`) ? path.slice(webRoot.length + 1) : path
}

function describeChain(walk: GraphWalk, file: string): string {
  return chainTo(walk, file).map(relative).join('\n     -> ')
}

/** The real graph, walked once and shared: parsing ~90 files is not free. */
const appEntries = htmlEntries(`${webRoot}/index.html`, webRoot, diskReader)
const appGraph = walkImports(appEntries, webRoot, diskReader)

describe('the shipped app does not reach measurement code', () => {
  it('nothing under a dev-only tree is reachable from index.html', () => {
    const violations = appGraph.reachable
      .map(relative)
      .filter((rel) => forbiddenTree(rel) !== undefined)
      .map((rel) => {
        const tree = forbiddenTree(rel)!
        const edge = appGraph.edges.find((e) => relative(e.to) === rel)
        const kind = edge?.typeOnly ? 'type-only import' : 'import'
        return (
          `${rel} is ${tree.what}, and the app loads it.\n` +
          `  Reached by ${kind} from ${edge ? relative(edge.from) : 'an entry'}:\n` +
          `     -> ${describeChain(appGraph, `${webRoot}/${rel}`)}`
        )
      })

    expect(violations, violations.join('\n\n')).toEqual([])
  })

  // Everything below keeps the assertion above from passing for the wrong
  // reason. A reachability check reports success when the walk finds nothing,
  // and a walk that resolved no entries, or died at the first import, finds
  // nothing too.

  it('walks from real entries rather than from an empty root set', () => {
    expect(appEntries.map(relative)).toContain('src/main.tsx')
  })

  it('resolved every relative import it met', () => {
    const misses = appGraph.unresolved.map((u) => `${relative(u.from)} -> ${u.specifier}`)
    expect(misses, `unwalked imports:\n${misses.join('\n')}`).toEqual([])
  })

  it('reached the modules the app is known to be built out of', () => {
    const reached = new Set(appGraph.reachable.map(relative))
    for (const anchor of [
      'src/App.tsx',
      'src/components/GameFlow.tsx',
      'src/engine/round.ts',
      'src/engine/skills.ts',
      'src/engine/evaluatorModel.ts',
      'src/persistence/gameSave.ts',
    ]) {
      expect(reached, `${anchor} should be reachable from index.html`).toContain(anchor)
    }
  })

  it('leaves the permitted direction alone', () => {
    // The harness reads the engine, and must go on being able to. Asserted
    // against the real tree, not a fixture, so a future rewrite of this guard
    // into something symmetric fails here instead of quietly banning the seam.
    const abRun = diskReader.read(`${webRoot}/src/ab/abRun.ts`)
    expect(abRun).not.toBeNull()
    const intoEngine = moduleSpecifiers(abRun!, 'abRun.ts').filter((i) =>
      i.specifier.includes('../engine/'),
    )
    expect(intoEngine.length).toBeGreaterThan(0)
  })

  it('does not count test files as part of the app', () => {
    // Both of these import `../ab/headlessGame`. Tests do not ship, and the
    // reason they pass is structural - an entry does not import a test - rather
    // than an exemption someone has to remember to keep in step.
    const reached = new Set(appGraph.reachable.map(relative))
    expect(reached).not.toContain('src/engine/round.test.ts')
    expect(reached).not.toContain('src/components/TrickPlayFlow.test.tsx')
  })
})

// -- The walker itself, over trees written for the purpose --------------------
//
// The assertion above is only ever watched passing on this repository, because
// the property it guards is true here. These run it against graphs that break
// it, so its failure path is exercised on every run rather than once by whoever
// wrote it (#261).

const ROOT = '/proj'

function virtualReader(files: Record<string, string>): SourceReader {
  return { read: (path) => (path in files ? files[path] : null) }
}

function walkFixture(files: Record<string, string>, entry = '/proj/src/main.tsx'): GraphWalk {
  return walkImports([entry], ROOT, virtualReader(files))
}

function reachedRel(walk: GraphWalk): string[] {
  return walk.reachable.map((p) => p.slice(ROOT.length + 1))
}

describe('the walk that guard rests on', () => {
  it('reports a direct import of forbidden code', () => {
    const walk = walkFixture({
      '/proj/src/main.tsx': `import { helper } from './ab/abRun'\nhelper()\n`,
      '/proj/src/ab/abRun.ts': `export const helper = () => 0\n`,
    })
    expect(reachedRel(walk)).toContain('src/ab/abRun.ts')
  })

  it('reports it through a chain, and names the chain', () => {
    const walk = walkFixture({
      '/proj/src/main.tsx': `import './App'\n`,
      '/proj/src/App.tsx': `import './engine/round'\n`,
      '/proj/src/engine/round.ts': `import { SkillParams } from '../ab/abRun'\nexport const p: SkillParams = 1\n`,
      '/proj/src/ab/abRun.ts': `export type SkillParams = number\n`,
    })
    expect(chainTo(walk, '/proj/src/ab/abRun.ts')).toEqual([
      '/proj/src/main.tsx',
      '/proj/src/App.tsx',
      '/proj/src/engine/round.ts',
      '/proj/src/ab/abRun.ts',
    ])
  })

  it('does not report the reverse edge, which is the one that must keep working', () => {
    const walk = walkFixture({
      '/proj/src/main.tsx': `import './engine/round'\n`,
      '/proj/src/engine/round.ts': `export const play = () => 0\n`,
      '/proj/src/ab/abRun.ts': `import { play } from '../engine/round'\nplay()\n`,
    })
    expect(reachedRel(walk)).toEqual(['src/engine/round.ts', 'src/main.tsx'])
  })

  it('does not report a test file that imports forbidden code', () => {
    const walk = walkFixture({
      '/proj/src/main.tsx': `import './engine/round'\n`,
      '/proj/src/engine/round.ts': `export const play = () => 0\n`,
      '/proj/src/engine/round.test.ts': `import { deal } from '../ab/headlessGame'\ndeal()\n`,
      '/proj/src/ab/headlessGame.ts': `export const deal = () => 0\n`,
    })
    expect(reachedRel(walk)).not.toContain('src/ab/headlessGame.ts')
  })

  it('reports a type-only import, and labels it as one', () => {
    // Erased at compile time, so it adds no bytes. It is still a violation:
    // `ab/`'s API has become part of the engine's compile-time surface, the
    // module it names is one deleted `type` keyword away from being loaded for
    // real, and a reader who sees the import has been told the engine may
    // depend on the harness.
    const walk = walkFixture({
      '/proj/src/main.tsx': `import type { SkillParams } from './ab/abRun'\nexport type P = SkillParams\n`,
      '/proj/src/ab/abRun.ts': `export type SkillParams = number\n`,
    })
    expect(reachedRel(walk)).toContain('src/ab/abRun.ts')
    expect(walk.edges[0].typeOnly).toBe(true)
  })

  it('treats a bindings-only type import as a real load', () => {
    // `import { type A } from 'x'` keeps the statement under
    // `verbatimModuleSyntax`, so the module is fetched at runtime with nothing
    // taken from it. Reported as a value edge, because that is what it is.
    const walk = walkFixture({
      '/proj/src/main.tsx': `import { type SkillParams } from './ab/abRun'\nexport type P = SkillParams\n`,
      '/proj/src/ab/abRun.ts': `export type SkillParams = number\n`,
    })
    expect(walk.edges[0].typeOnly).toBe(false)
  })

  it('follows dynamic imports and re-exports', () => {
    const dynamic = walkFixture({
      '/proj/src/main.tsx': `const go = async () => (await import('./ab/cli')).run()\ngo()\n`,
      '/proj/src/ab/cli.ts': `export const run = () => 0\n`,
    })
    expect(reachedRel(dynamic)).toContain('src/ab/cli.ts')

    const reexport = walkFixture({
      '/proj/src/main.tsx': `export * from './engine/api'\n`,
      '/proj/src/engine/api.ts': `export { stats } from '../ab/stats'\n`,
      '/proj/src/ab/stats.ts': `export const stats = 1\n`,
    })
    expect(reachedRel(reexport)).toContain('src/ab/stats.ts')
  })

  it('ignores import paths that only appear in comments and strings', () => {
    // Every file under `src/ab/` is heavily commented and several quote engine
    // paths in prose. A guard with false positives gets muted, so this is the
    // reason the parser is used instead of a regular expression.
    const walk = walkFixture({
      '/proj/src/main.tsx':
        `// see import { x } from './ab/abRun' for the harness\n` +
        `/* import './ab/cli' */\n` +
        `const note = "import './ab/stats'"\n` +
        `export default note\n`,
      '/proj/src/ab/abRun.ts': `export const x = 1\n`,
      '/proj/src/ab/cli.ts': `export const y = 1\n`,
      '/proj/src/ab/stats.ts': `export const z = 1\n`,
    })
    expect(reachedRel(walk)).toEqual(['src/main.tsx'])
  })

  it('surfaces an import it could not resolve instead of walking past it', () => {
    const walk = walkFixture({
      '/proj/src/main.tsx': `import './does/not/exist'\n`,
    })
    expect(walk.unresolved).toEqual([{ from: '/proj/src/main.tsx', specifier: './does/not/exist' }])
  })

  it('records a non-source file as reached without trying to parse it', () => {
    const walk = walkFixture({
      '/proj/src/main.tsx': `import './ab/bench.css'\n`,
      '/proj/src/ab/bench.css': `body { color: red }\n`,
    })
    expect(reachedRel(walk)).toContain('src/ab/bench.css')
  })

  it('takes every module script on the page as a root', () => {
    const files = {
      '/proj/index.html':
        `<script type="module" src="/src/main.tsx"></script>\n` +
        `<script type="module" src="/src/second.ts"></script>\n`,
      '/proj/src/main.tsx': `export default 1\n`,
      '/proj/src/second.ts': `import './ab/abRun'\n`,
      '/proj/src/ab/abRun.ts': `export const x = 1\n`,
    }
    const reader = virtualReader(files)
    const entries = htmlEntries('/proj/index.html', ROOT, reader)
    expect(entries).toEqual(['/proj/src/main.tsx', '/proj/src/second.ts'])
    expect(reachedRel(walkImports(entries, ROOT, reader))).toContain('src/ab/abRun.ts')
  })

  it('resolves the specifier shapes this codebase actually writes', () => {
    const reader = virtualReader({
      '/proj/src/App.tsx': '',
      '/proj/src/engine/round.ts': '',
      '/proj/src/engine/index.ts': '',
      '/proj/src/index.css': '',
    })
    const from = '/proj/src/main.tsx'
    expect(resolveSpecifier('./App.tsx', from, ROOT, reader)).toBe('/proj/src/App.tsx')
    expect(resolveSpecifier('./engine/round', from, ROOT, reader)).toBe('/proj/src/engine/round.ts')
    expect(resolveSpecifier('./engine/round.js', from, ROOT, reader)).toBe(
      '/proj/src/engine/round.ts',
    )
    expect(resolveSpecifier('./engine', from, ROOT, reader)).toBe('/proj/src/engine/index.ts')
    expect(resolveSpecifier('/src/index.css', from, ROOT, reader)).toBe('/proj/src/index.css')
    expect(resolveSpecifier('react', from, ROOT, reader)).toBeNull()
    expect(resolveSpecifier('node:fs', from, ROOT, reader)).toBeNull()
  })
})

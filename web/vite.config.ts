/// <reference types="vitest/config" />
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// -- Suite completeness guard (#170) -----------------------------------------
//
// Under CPU contention vitest can fail to start its workers
// (`[vitest-pool]: Failed to start forks worker ... Timeout waiting for worker
// to respond`; `START_TIMEOUT` is hardcoded at 60 s in the pool runner and is
// not configurable). Measured here: a 30-process load run executed 14 of 39
// files and another executed 28 — and both printed a *green* summary,
// `Tests 127 passed (127)`, because the denominator shrinks with the numerator.
//
// The exit code was non-zero in those runs, so CI would have caught them. But
// the summary line is what a human reads, and "127 passed" over a suite of 372
// looks like success. `npm test` is the gate every PR here has to pass, and a
// gate that can run a third of the suite and print green is worse than one that
// times out loudly.
//
// So the file count is asserted rather than trusted: whatever vitest discovered
// and ran must match what is on disk, or the run fails with a message that says
// so in as many words. That covers both shapes of the problem — workers that
// fail to start, and files that are never discovered — without depending on
// which one occurred.
const TEST_FILE_RE = /\.(test|spec)\.(c|m)?[jt]sx?$/
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git'])

function countTestFilesOnDisk(dir: string): number {
  let found = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) found += countTestFilesOnDisk(`${dir}/${entry.name}`)
    } else if (TEST_FILE_RE.test(entry.name)) {
      found++
    }
  }
  return found
}

/**
 * `npm test` runs `vitest run` and nothing else, so that exact argv is the gate
 * and only that invocation is held to the full on-disk count. Anything more
 * specific is a developer narrowing the run on purpose (`vitest run one.test.ts`,
 * `-t 'name'`, `--exclude ...`) and would fail such a check by design. Matching
 * the gate's argv exactly, rather than trying to parse arbitrary vitest CLI, is
 * what keeps this free of false alarms — an earlier attempt to detect filters by
 * scanning argv stood down on `--exclude "**‍/engine/**"`, because a flag's
 * space-separated value is indistinguishable from a positional filter.
 */
function isGateRun(): boolean {
  const args = process.argv.slice(2)
  return args.length === 0 || (args.length === 1 && args[0] === 'run')
}

function reportIncomplete(ran: number, expected: number, source: string): void {
  console.error(
    `\n  INCOMPLETE TEST RUN\n` +
      `  Ran ${ran} test files, but ${expected} ${source}.\n` +
      `  ${expected - ran} file(s) never executed, so the summary above reports success\n` +
      `  over a subset of the suite. Treat this run as FAILED.\n` +
      `  Usual cause is vitest failing to start workers under CPU load (#170):\n` +
      `  re-run on a quieter machine and check the file count, not just the colour.\n`,
  )
  process.exitCode = 1
}

/**
 * A module left in one of these at the end of the run was resolved but never
 * executed. Counting modules is not enough on its own: vitest keeps unrun files
 * in the results (a `--bail` run reports `states={failed:1, pending:39}` with
 * all 40 modules present), so the state is the signal, not the length.
 */
const UNEXECUTED_STATES = new Set(['pending', 'queued', 'running'])

function isUnexecuted(testModule: { state?: () => string }): boolean {
  try {
    return UNEXECUTED_STATES.has(String(testModule.state?.()))
  } catch {
    return false
  }
}

/** `--bail` deliberately abandons the remaining files, and already exits non-zero. */
function isBailRun(): boolean {
  return process.argv.slice(2).some((arg) => arg === '--bail' || arg.startsWith('--bail='))
}

let intendedSpecCount = -1

const suiteCompletenessReporter = {
  onTestRunStart(specifications: readonly unknown[] = []) {
    intendedSpecCount = specifications.length
  },
  onTestRunEnd(
    testModules: readonly { state?: () => string }[] = [],
    _errors: readonly unknown[] = [],
    _reason?: string,
  ) {
    if (isBailRun()) return
    const unexecuted = testModules.filter(isUnexecuted).length
    const ran = testModules.length - unexecuted

    // 1. Resolved but never executed. Filter-agnostic, so it holds under any
    //    combination of CLI narrowing.
    if (unexecuted > 0) {
      reportIncomplete(ran, testModules.length, 'were resolved for this run')
      return
    }

    // 2. Dropped from the results entirely — the shape the worker-startup
    //    failure takes, where the denominator itself shrinks (`14 passed (14)`
    //    out of 39 files) and the summary still reads green.
    if (intendedSpecCount >= 0 && testModules.length < intendedSpecCount) {
      reportIncomplete(ran, intendedSpecCount, 'were resolved for this run')
      return
    }

    // 3. Gate only: catches discovery itself, which 1 and 2 cannot see — if the
    //    glob resolves 33 files, "33 of 33 ran" is true and still wrong.
    if (!isGateRun()) return
    const onDisk = countTestFilesOnDisk(fileURLToPath(new URL('./src', import.meta.url)))
    if (ran < onDisk) reportIncomplete(ran, onDisk, 'exist on disk')
  },
}

// The app is served from Netlify at a domain root
// (<https://pinochle-house-rulez.netlify.app>), which is why this is `/`; the
// same value is what `npm run dev` / `npm run preview` want. Deploys are manual
// uploads of a locally built `web/dist` (see `netlify.toml`), so changing this
// does not reach the live site until someone deploys.
//
// If the site ever moves under a subpath (e.g. `example.com/pinochle/`), set
// this to that subpath *and* move the manifest's `id`/`start_url`/`scope` below
// with it. Built asset URLs will not resolve otherwise, and a manifest left
// behind installs an app that launches into a 404 — #141 shipped exactly that
// and it stayed invisible until #143.
const base = '/'

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        // `id`, `start_url`, and `scope` must track `base` above. They were
        // left at the GitHub Pages project-page path (`/pinochle/`) when that
        // deploy was removed and `base` went back to `/`, which pointed an
        // installed app at a URL the build does not contain: tapping the home
        // screen icon loaded `/pinochle/` and 404'd, and the document at `/`
        // sat outside the declared scope, so browsers declined to install it
        // at all. The service worker registers at `/` either way, so the two
        // disagreed. If `base` ever changes, change these with it.
        id: '/',
        name: 'Pinochle',
        short_name: 'Pinochle',
        description: 'Partnership Pinochle — play against AI opponents.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#14532d',
        background_color: '#14532d',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Offline shell caching: precache the built app shell so the game
        // loads (and can be reopened) without a network connection.
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    // 'default' keeps the normal output; the guard only adds the completeness
    // assertion on top of it (#170).
    reporters: ['default', suiteCompletenessReporter],
  },
})

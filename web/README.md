# Pinochle — web client

The product — React + TypeScript + Vite + Tailwind CSS. A complete game
against three AI opponents. **Not currently hosted anywhere**: GitHub holds
the code only, there is no deploy pipeline, and there is no public URL. Run
it locally with `npm run dev`.

The rules engine (`src/engine/`) is a TypeScript port of the Python
reference implementation (`../pinochle_engine.py`). Both sides are active
and neither is winding down: player-visible behaviour lands here, while
Python stays authoritative for ported rules constants and is where the AI
research and measurement run. The root [`README.md`](../README.md) and
[`CLAUDE.md`](../CLAUDE.md) describe that split; [`ROADMAP.md`](../ROADMAP.md)
has the sequencing.

## Running

```
npm install
npm run dev     # dev server
npm run build   # typecheck + production build
npm test        # vitest
```

## Structure

- `src/engine/` — the ported rules engine, one file per concern rather than
  one module with section breaks, each with a matching `*.test.ts`:
  `card.ts`, `melds.ts`, `bidding.ts`, `passing.ts`, `trick.ts`, `tracker.ts`,
  `round.ts`, `game.ts`, `misdeal.ts`, and `names.ts`/`teamNames.ts`. Those
  tests cover the same edge cases as the Python `__main__` self-checks (Double
  Run vs. Run, Double Pinochle vs. Pinochle, etc.) plus additional coverage.
  Alongside them: `skills.ts` (`SKILL_PARAMS`, the five-level difficulty
  dial), the shipped AI (`evaluator.ts`), and two generated fixture pairs that
  check this engine against the Python reference and are never hand-edited —
  `evaluatorModel.ts` + `evaluatorParity.*` from `../export_evaluator.py`, and
  `engineParity.*` from `../export_parity_scenarios.py` (described below).
- `src/App.tsx` — four lines; renders `<GameShell />`.
- `src/components/` — the UI and the reducers behind it. `GameShell.tsx` owns
  the start-menu/in-game split and the Options overlay; `gameFlowReducer.ts`
  drives a round end to end, with `auctionReducer.ts` and
  `trickPlayReducer.ts` owning the auction and trick phases.
- `src/persistence/` — localStorage autosave (`gameSave.ts`) and stored
  options.
- `src/ab/` — the measurement harness (issue #115). Not shipped: nothing under
  `src/` outside the App's import graph reaches the bundle. See below.

## Parity with the Python engine (`engineParity.*`)

`src/engine/` is a hand port, and until #125 each side was only ever checked
against itself. #118 is what that costs: `NEAR_RUN_VALUE` and
`NEAR_DOUBLE_PINOCHLE_VALUE` were ported at half value, so the browser named a
different trump suit than the reference for months, and it surfaced because
someone read both files side by side while working on something else.

`engineParity.fixture.ts` holds 40 complete rounds exactly as `pinochle_engine.py`
played them, and `engineParity.test.ts` replays the recorded cards through this
engine. Two things are deliberately **not** compared, and both look like the
obvious approach:

- **The deals.** Python shuffles with `random.Random`, the TS side reseeds
  `Math.random` via `makeRng`. Different PRNGs — the same seed does not produce
  the same deal and never will. So the deal is *pinned*, not generated.
- **The AI's decisions.** Python runs Monte Carlo rollouts, TS `hard`+ runs the
  evaluator distilled from them (#115). Divergence there is the design, so the
  auction result, the 3-card pass and every card played are pinned too.

What is compared is only what both sides must agree on: `scoreMelds` per hand
(total *and* breakdown), the winner and points of every trick, the +10
last-trick bonus, and `scoreRound`'s final number for both teams. Plus the
legal-move set at every follow, compared as a set rather than "was Python's card
allowed" — the one-directional version catches a filter that is *stricter* than
the reference but not one that is *looser*, and looser is the bug that reaches a
player, as a browser that lets you underplay a trick you were required to beat.

Regenerating, from the repo root (not `web/`):

```
python export_parity_scenarios.py --record   # replay the Python engine, rewrite both files
python export_parity_scenarios.py            # re-render the TS fixture from the committed JSON
python export_parity_scenarios.py --check    # fail if the committed fixture is stale
```

`--record` is on demand only. Recording replays the AI, so re-recording on every
run would turn any AI change into a red suite and a six-figure diff; rendering
is a pure function of the committed `parity_scenarios.json`, which is what
`--check` and `test_export_parity_scenarios.py` guard. That Python test also
replays every committed scenario back through the *Python* engine, so a rules
change on that side fails there rather than showing up here as an unexplained
TS failure.

## Measuring the AI (`src/ab/`)

`chooseBid` runs one of two policies per skill level (`SKILL_PARAMS.bidPolicy`
in `src/engine/skills.ts`): the hand-tuned thresholds that predate epic #104, or
the evaluator distilled from the Python rollout AI. Issue #115 had to decide
whether the second is worth switching on, which `ab_harness.py` cannot answer
because both sides are TypeScript.

`headlessGame.ts` plays complete games without React, calling the same reducers
and the same AI entry points `GameFlow.tsx` calls, in the same order, with the
delays and the rendering removed. `abRun.ts` pairs them the way `ab_harness.py`
does — identical deals derived from (seed, round) so they cannot drift, seats
mirrored, significance over pairs rather than games, split pairs discarded, and
a bootstrap interval on score margin because games-won alone is too coarse.
`stats.ts` is a direct port of that module's three statistics.

```
node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts selftest --pairs 100
node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts ab --pairs 1000
node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts latency --positions 4000
```

Run `selftest` before believing `ab`: one policy against itself must find
nothing, and here it must find *exactly* nothing — with the same policy in all
four seats the mirrored orientations are the same game relabelled, so every pair
splits and every paired margin is zero. `ab.test.ts` asserts that in the suite.

What it found, over 1000 pairs / 2000 games: distilled swept 211 deals to
static's 50 (739 split), 95% CI 75.6%–85.2% of decisive deals, p < 1e-4, and
+227 score margin per deal with a 95% CI of +198 to +257. The evaluator takes a
third fewer contracts and makes 63.7% of them against static's 54.6% — declining
the `DEFENSIVE_PUSH_FLOOR` raise, which is what the static rule does on almost
any hand, is worth more than the contracts it gives up. Cost: +872 B gzipped,
and a p95 per decision of 72 µs (Node) / 495 µs (Chrome at 375×812), against the
600 ms the auction already waits before each AI bid. `hard` and above now run
`'distilled'`; `easy` and `medium` keep the thresholds.

Two bounds on that conclusion. The evaluator only governs the opening decision
and the defensive push — the ordinary raise ladder and the 330/340 constants in
`chooseBid` are untouched, and the two policies return a different bid on 6.5%
of real auction positions, which is the ceiling on what the model can be
credited with. And every seat in the harness is an AI, so this says the policy
is stronger, not that it is a better partner for a human.

### What #126 changed about those numbers

The #126 audit found that `chooseBid` opened at 300 unconditionally from the
first seat to speak, a rule the Python reference does not have (see
`bidding.ts`). It applied to both sides of the #115 run, so the comparison was
fair — but it meant neither policy was ever *asked* the opening question in a
real auction, and the +227 above is the two rules judged on the defensive push
and the raise ladder alone.

Re-measured with the opening decision restored, on the same 1000 pairs:
distilled swept 122 deals to static's 88 (790 split), p = 0.02, margin **+62
per deal with a 95% CI of +41 to +82**. Same direction, a third of the size.
Both sides now take fewer and better contracts (distilled 4439 at 70.8% made,
static 5423 at 66.0%), which is what removing a rule that bought a cheap
contract on every deal should do. `hard` and above keep `'distilled'`.

The parity fix itself was A/B'd the same way, with the two ported formulas
`legacy` on one side and `fixed` on the other, over 1000 pairs:

    fixed swept 226, legacy 88 (686 split), p < 1e-4
    margin +176 per deal, 95% CI +147 to +206
    contracts 4998 vs 6080, made 65.1% vs 57.5%, avg bid 328 vs 315

Split by fix, the bidding one carries all of it (+179, CI +150 to +209) and the
`defenderLead` one is a null result (-3, CI -9 to +3, p = 0.85, 972 of 1000
pairs split) — it ships as parity with the reference engine, not as a strength
claim. The `parity` dial those runs needed is not in the tree: it was a
temporary fourth field on `SkillParams` plus a `PARITY_AB_POLICIES` pair, added
for the measurement in the shape `FOLD_AB_POLICIES` already uses and removed
before the fix was committed, since a permanent switch for "play the port bug"
is not a difficulty setting.

`bench/index.html` is the browser side of the latency measurement, served by
`npm run dev` at `/bench/` (it follows `base`, which is `/`). It is never an
input to `vite build`, so it cannot reach a player or the PWA precache.

## Notes

- TypeScript is configured with `erasableSyntaxOnly`, so no `enum` or
  constructor parameter-property shorthand — see `src/engine/card.ts` for the
  const-object-plus-type pattern used instead.

## PWA / deployment

- `vite-plugin-pwa` generates the web app manifest and a service worker
  (Workbox `generateSW` strategy) that precaches the built app shell for
  offline use. Config lives in `vite.config.ts`.
- `public/pwa-*.png`, `public/maskable-icon-512x512.png`, and
  `public/apple-touch-icon.png` are placeholder icons (solid color, generated
  programmatically) — swap for real art whenever it exists; they just need to
  keep the same filenames/sizes referenced in `vite.config.ts`.
- **There is no automatic deploy pipeline, and no site yet.** The app was
  served from GitHub Pages from 2026-07-31 until 2026-08-01, when that was
  removed by decision — GitHub is source control only and `.github/` no
  longer exists. What replaces it is a *manual* target, described next: the
  config is committed, but no Netlify site exists yet (#144), so there is
  still no public URL.
- **Deploying to Netlify (manual).** `netlify.toml` at the repo root sets
  `publish = "web/dist"` and nothing else build-related. The repo is
  deliberately **not** connected to Netlify's git integration — a
  push-triggered build would recreate the coupling that removing GitHub
  Pages took out. Netlify never builds this repo; you build locally and
  upload the result:

  ```
  cd web && npm ci && npm run build
  cd .. && npx netlify deploy --prod     # uploads web/dist as-is
  ```

  Run the deploy from the **repo root** — `publish` resolves relative to
  `netlify.toml`, so running it from `web/` looks for `web/web/dist`. For the
  same reason there is no `command` and no `NODE_VERSION` in that file: they
  would be dead config implying a build that never happens. Node 24 locally.
- **No SPA fallback redirect, on purpose.** `netlify.toml` sets no redirects.
  The usual `/* /index.html 200` rule exists for client-side routers, and
  this app has none — nothing imports `react-router`, nothing calls
  `pushState`. Every real URL is a file in `dist/`, so the rule would only
  turn genuine 404s into a 200 serving the app shell. Add it when a router
  lands, not before.
- `base` in `vite.config.ts` is `/`. If the build is ever served under a
  subpath (a project page at `example.com/pinochle/`, say), set `base` to
  that subpath or the built asset URLs will not resolve. This is the single
  most common way a working build serves a blank page. **The manifest's
  `id` / `start_url` / `scope` have to move with it** — they were left at
  the old GitHub Pages `/pinochle/` path after `base` went back to `/`, which
  meant an installed app launched into a 404 and the page at `/` fell outside
  its own manifest scope. Fixed in #143; the failure is invisible in a
  browser tab and only shows up once the app is installed.
- **Security headers** are set in `netlify.toml` for `/*`: a strict
  allowlist CSP (the bundle has no backend, no outbound requests, no forms,
  no third-party scripts and no `eval`, so `'unsafe-inline'` is not needed
  anywhere), plus `X-Content-Type-Options`, `Referrer-Policy`, and a
  `Permissions-Policy` denying device APIs the game never uses. Hashed
  `/assets/*` are cached immutably; `sw.js` is explicitly
  `max-age=0, must-revalidate`, since a stale service worker would pin a
  device to an old build.
- Whoever maintains the host should know: a static host that cannot set
  COOP/COEP response headers rules out `SharedArrayBuffer`, and therefore
  rules out multi-threaded WebAssembly. Single-threaded Wasm is unaffected.
  GitHub Pages could not set headers — **Netlify can**, via the `[[headers]]`
  block already in `netlify.toml`. They are deliberately left off: nothing
  uses either today, and COEP breaks cross-origin subresources for no gain.
  Turn them on only if browser-side rollouts are attempted for skills 4–5.
- To check the production build locally: `npm run build && npm run preview`,
  then open the printed local URL. Note that `preview` does **not** apply
  `netlify.toml`'s headers — it serves the files without them, so a CSP
  problem will not reproduce there.

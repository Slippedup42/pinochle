# Pinochle — web client

The PWA client, per [`ROADMAP.md`](../ROADMAP.md) Phase 1. React + TypeScript +
Vite + Tailwind CSS. The game engine (`src/engine/`) is a TypeScript port of
the Python reference implementation (`../pinochle_engine.py`, frozen — see
root `ROADMAP.md`).

## Running

```
npm install
npm run dev     # dev server
npm run build   # typecheck + production build
npm test        # vitest
```

## Structure

- `src/engine/` — ported rules engine (`card.ts`: `Card`/`Deck`; `melds.ts`:
  `scoreMelds`), one file per concern, mirroring the Python module's section
  breaks. Each ported piece carries matching tests (`*.test.ts`) covering the
  same edge cases as the Python `__main__` self-checks (Double Run vs. Run,
  Double Pinochle vs. Pinochle, etc.) plus additional coverage.
- `src/App.tsx` — UI shell, currently a placeholder.
- `src/ab/` — the measurement harness (issue #115). Not shipped: nothing under
  `src/` outside the App's import graph reaches the bundle. See below.

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

`bench/index.html` is the browser side of the latency measurement, served by
`npm run dev` at `/pinochle/bench/`. It is never an input to `vite build`, so it
cannot reach a player or the PWA precache.

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
- `base` in `vite.config.ts` is hardcoded to `/pinochle/` for GitHub Pages
  project-page hosting (`https://slippedup42.github.io/pinochle/`). Update it
  if a custom domain is ever configured (and switch to `base: '/'`).
- `.github/workflows/deploy-pages.yml` builds `web/` and deploys `web/dist` to
  GitHub Pages on every push to `main` that touches `web/`. Requires GitHub
  Pages to be enabled for the repo with source set to "GitHub Actions"
  (Settings → Pages) — one-time manual step, not something a workflow file
  can do.
- To check the production build locally: `npm run build && npm run preview`,
  then open the printed local URL (it serves under the `/pinochle/` base to
  match production).

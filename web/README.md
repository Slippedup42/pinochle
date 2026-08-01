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

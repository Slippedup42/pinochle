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

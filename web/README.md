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

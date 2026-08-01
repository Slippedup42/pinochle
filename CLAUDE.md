# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Partnership Pinochle, in two implementations that are not peers:

- **`web/` — the TypeScript PWA, and the product.** React + TS + Vite +
  Tailwind. The rules engine is `web/src/engine/`. New player-visible
  work lands here. **Not currently hosted anywhere** — GitHub holds the
  code only, and there is no deploy pipeline. Run it locally with
  `npm run dev`. A change is shipped when it is merged, not deployed.
- **`pinochle_engine.py` — Python, the reference implementation *and*
  the AI-research and measurement harness.** Both roles are live. It
  implements the same rules end-to-end, it is what the TS port is
  checked against, and it is the platform all the strategy work runs on
  (Monte Carlo rollouts, the win-probability table, dataset generation,
  model fitting, A/B harness). Python is **not** frozen — the whole
  measured-EV AI program ran here, recently. It is simply not where
  player-visible behaviour lands.

What crosses the boundary is a *generated artifact*, not a hand-port:
`export_evaluator.py` emits `web/src/engine/evaluatorModel.ts` plus a
parity fixture, and `export_evaluator.py --check` fails the Python suite
if the committed TypeScript has drifted. Python also stays authoritative
for ported rules constants — if a constant disagrees across the two
engines, Python is right and the TS side has drifted — that is issue
#118's bug class, and #125/#126 are the standing net and the audit.

See [README.md](README.md) for current status, file-by-file contents, and
architecture — keep that file in sync as the project evolves rather than
duplicating it here.

## Key references

- `pinochle_rules.md` is the source of truth for game rules, and its
  "Implementation Notes" section is the fastest orientation to how the
  two engines divide up. An engine should always match it; if they
  disagree, that's a bug to flag, not a cue to silently pick one.
- `ROADMAP.md` is the top-level source of truth for sequencing and for
  what is done versus still open.
- `pinochle_expert_ai_strategy.md` is the design spec for the rollout AI,
  built in Python as `GeneralStrategy` — one `Player` subclass on a skill
  dial 1–5, not a separate tier. It is a spec that has been implemented,
  and its Section 9 open questions are all resolved. The PWA does not run
  these rollouts; it runs the model distilled from them
  (`pinochle_rules.md`'s "How the AI reaches the browser").
- Strategy changes are judged on a paired A/B run over identical deals
  with the seats mirrored, not on impressions: `ab_harness.py` in Python,
  `web/src/ab/` in TypeScript. Null results are recorded as null and
  shipped disabled (issue #101) rather than argued away.

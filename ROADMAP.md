# Roadmap

Owned by the **architect** agent — keep this current as phases complete
or priorities shift. Other team-lead agents should treat this as the
top-level source of truth for sequencing; individual specs (rules,
AI strategy) live in their own docs and are linked from here.

## Phase 0 — Rules engine + Proficient AI (done)

- Full rules implementation: deal, bidding, 3-card pass, meld scanning,
  trick-taking, round scoring, multi-round games to ±1000
  (`pinochle_engine.py`).
- Proficient-tier AI: hand valuation (Base Bid), positional/score-aware
  bidding, category-split passing strategy, card-counting trick play.
- Interactive human-play layer: chat-resumable (`human_play.py`) and
  standalone terminal (`play_local.py`).

## Phase 1 — Correctness & validation

- Resolve the known **rules/engine mismatch**: `pinochle_rules.md` says
  opening bid is 250; `pinochle_engine.py` uses `OPENING_BID = 300` with
  `FORCED_BID = 250` as the no-bid fallback. Needs a decision, then the
  loser doc gets fixed.
- Build a real automated test suite (currently just `__main__`
  self-checks and ad hoc sanity asserts).
- Resolve the open design questions listed at the end of
  `pinochle_expert_ai_strategy.md` (forward/return-pass tie-breaks,
  defender trump-leading default, card-counting infrastructure
  confirmation, etc.) before they block Phase 2.

## Phase 2 — Expert-tier AI

- Implement Monte Carlo determinization + rollout per
  `pinochle_expert_ai_strategy.md`: bid-time EV, return-pass knapsack
  triage, trick-play lookahead, auto-SET pruning.
- Validate as a separate strategy module (`ExpertPlayer`) so Proficient
  stays the control group; win-rate tournament sim (Expert vs.
  Proficient) is both the acceptance test and the ongoing regression
  check.

## Phase 3 — Web client

- Port the rules engine to JS/TS. Python stays useful as the
  AI-research/tournament-simulation harness (headless, scriptable), but
  the shipped client is a JS port — GitHub Pages only serves static
  files, and iOS Safari doesn't run Python natively without added
  complexity (Pyodide/WASM) that buys nothing here.
- Parity tests between the Python and JS engines while both exist, to
  catch drift.

## Phase 4 — Mobile-installable PWA

- Add a web app manifest + service worker so the game installs to the
  iPhone home screen via Safari "Add to Home Screen" — full-screen,
  app-like, no App Store involved.
- Host on GitHub Pages.

## Phase 5 — UI/UX

- Table layout, card rendering, bidding/passing/trick-play interactions
  for the web client. Not yet scoped in detail.

## Tooling & process (parallel track, not phase-gated)

See [TEAM.md](TEAM.md) for the full roster, label conventions, and
workflow — team-lead agents (architect, design, engineering, QA), the
`/standup` and `/work-queue` commands, and epic lifecycle rules are all
live as of this phase.

- Coding standards, design specs, dev specs — owned by the relevant
  lead per `TEAM.md`; locations TBD as they're written.

## Open questions

- Python-vs-JS engine: keep both long-term (Python for AI research
  velocity) or eventually retire the Python engine once the JS port has
  full parity?

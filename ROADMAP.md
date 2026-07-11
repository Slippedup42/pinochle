# Roadmap

Owned by the **architect** agent — keep this current as phases complete
or priorities shift. Other team-lead agents should treat this as the
top-level source of truth for sequencing; individual specs (rules, AI
strategy) live in their own docs and are linked from here.

**Mission shift (2026-07-10):** short runway — getting an installable
PWA in front of players is now the priority, ahead of Expert-tier AI
and Python-side hardening. Everything below is reordered around that.

## Phase 0 — Rules engine + Proficient AI (Python) — done

- Full rules implementation: deal, bidding, 3-card pass, meld scanning,
  trick-taking, round scoring, multi-round games to ±1000
  (`pinochle_engine.py`).
- Proficient-tier AI: hand valuation (Base Bid), positional/score-aware
  bidding, category-split passing strategy, card-counting trick play.
- Interactive human-play layer: chat-resumable (`human_play.py`) and
  standalone terminal (`play_local.py`).
- This is now a **frozen reference implementation** for the JS port,
  not an active development target — see the open question at the
  bottom on its long-term role.

## Phase 1 — PWA critical path (current focus)

Stack: **React + TypeScript + Vite + Tailwind CSS**, PWA via
`vite-plugin-pwa` (manifest + service worker), hosted on GitHub Pages
via GitHub Actions. Chosen for a modern, polished UI without heavy
build overhead, and first-class PWA tooling on top of Vite.

1. **Decisions** (unblock the port)
   - Opening-bid mismatch resolved: engine value (300 min /
     250 forced) is canonical; `pinochle_rules.md` updated to match.
   - Stack locked (above).
2. **Rules engine port to TS** — the critical-path item; no JS/TS
   exists yet.
   - Core data model, deal, meld scoring
   - Bidding + 3-card pass
   - Trick-taking + round/game scoring
3. **Port Proficient-tier AI to TS** — needed so a solo player has
   3 AI opponents/partner to play against; this is the actual product.
4. **Minimal playable UI** — table layout, card rendering, bid/pass/
   trick-play interaction flows, score/win-loss screens. Scoped to
   *playable*, not fully polished — see Phase 4.
5. **PWA shell** — manifest, icons, service worker (offline shell
   caching), GitHub Pages deploy pipeline, verify "Add to Home Screen"
   on iOS Safari end-to-end.
6. **Correctness net** — seeded-scenario parity checks between the
   Python and TS engines (same deal in → same meld scores / trick
   winners / final score out). Lighter than a full test suite; exists
   to catch port bugs, not to be exhaustive.

## Phase 2 — Post-MVP hardening (deferred until the PWA ships)

Everything here is real and tracked, just not on the critical path:

- Full automated `pytest` suite for the Python engine.
- Tournament-simulation harness (win-rate validation for AI strategy
  changes).
- Split `pinochle_engine.py` into rules-engine and AI-strategy modules
  — low value while the Python engine is a frozen reference rather
  than something actively extended.
- Engineering polish: dedupe win-condition logic (`Game.play` vs.
  `play_local.py`), explicit sync note between `Round` and
  `InteractiveRound`.
- Design doc fixes: document Double Run meld, document the misdeal
  reshuffle house rule (and wire it into AI-only games), refresh
  `pinochle_rules.md`'s stale Implementation Notes, write up AI
  strategy open question 6.

## Phase 3 — Expert-tier AI

- Implement Monte Carlo determinization + rollout per
  `pinochle_expert_ai_strategy.md`: bid-time EV, return-pass knapsack
  triage, trick-play lookahead, auto-SET pruning.
- Validate as a separate strategy module (`ExpertPlayer`) so Proficient
  stays the control group; win-rate tournament sim (Expert vs.
  Proficient) is both the acceptance test and the ongoing regression
  check.
- Deliberately behind the PWA MVP and Phase 2 hardening — this was
  the previous roadmap's near-term focus; it no longer is.

## Phase 4 — UI/UX polish

- Once the MVP UI (Phase 1.4) is proven playable, invest in the fuller
  "modern and pretty" treatment: table layout refinement, animations,
  responsive/mobile-first interaction details. Not yet scoped in
  detail.

## Tooling & process (parallel track, not phase-gated)

See [TEAM.md](TEAM.md) for the full roster, label conventions, and
workflow — team-lead agents (architect, design, engineering, QA), the
`/standup` and `/work-queue` commands, and epic lifecycle rules are all
live.

- Coding standards, design specs, dev specs — owned by the relevant
  lead per `TEAM.md`; locations TBD as they're written.

## Open questions

- Python-vs-JS engine: the mission shift answers this for the near
  term — Python is the frozen reference implementation while JS
  becomes the primary, shipped engine. Whether Python stays useful
  long-term as an AI-research/tournament-simulation harness (once
  Phase 2/3 revisit it) is still open.

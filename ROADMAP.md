# Roadmap

Owned by the **architect** agent — keep this current as phases complete
or priorities shift. Other team-lead agents should treat this as the
top-level source of truth for sequencing; individual specs (rules, AI
strategy) live in their own docs and are linked from here.

**Current focus (2026-08-01): port fidelity.** The game is built, live,
and played by a distilled AI. The open work is proving the TypeScript
engine still agrees with the Python reference it was ported from — the
parity net (Phase 1.6, #125) and the constant-by-constant audit (#126).
That is the whole near-term queue; Phases 2 and 4 are the backlog behind
it.

**Mission shift (2026-07-10) — satisfied.** The short-runway call was to
get an installable PWA in front of players ahead of Expert-tier AI and
Python-side hardening. It worked, and then some: the PWA was playable
within two days, and the AI work happened anyway (Phase 3) rather than
waiting behind it. Kept here because it explains why the phases are
ordered the way they are, not because it is still a live constraint.

## Phase 0 — Rules engine + Proficient AI (Python) — done

- Full rules implementation: deal, bidding, 3-card pass, meld scanning,
  trick-taking, round scoring, multi-round games to ±1000
  (`pinochle_engine.py`).
- Proficient-tier AI: hand valuation (Base Bid), positional/score-aware
  bidding, category-split passing strategy, card-counting trick play.
- Interactive human-play layer: chat-resumable (`human_play.py`) and
  standalone terminal (`play_local.py`).
- Python's role is **settled, and it is not "frozen"** — see
  [Settled questions](#settled-questions). It is the reference
  implementation the TS port is checked against, and the platform all
  the AI research runs on. Every result in Phase 3 was produced here.

## Phase 1 — PWA critical path — shipped (1.6 open)

Stack: **React + TypeScript + Vite + Tailwind CSS**, PWA via
`vite-plugin-pwa` (manifest + service worker). Chosen for a modern,
polished UI without heavy build overhead, and first-class PWA tooling on
top of Vite.

**Hosting: Netlify, manual deploys (2026-08-01).** Live at
<https://pinochle-house-rulez.netlify.app>.

Two moves in one day, and the reasoning matters more than the dates. The
app was served from GitHub Pages from 2026-07-31; Paul removed that
deployment the next day (#141), scoping GitHub to source control only.
It moved to Netlify hours later (#143/#144) for a specific reason: the
alternative on the table was mailing a single self-contained HTML file,
and that does not work on iOS — Quick Look does not execute JavaScript.
Reliable `localStorage` and Add to Home Screen both require a real
`https` origin, which is what hosting actually buys here. Sharing was
never the constraint; persistence was.

**Merging does not ship.** The repo is deliberately *not* connected to
Netlify's git integration — that would rebuild the coupling #141
removed, in a different service. Deploys are manual from a locally built
`web/dist` (`npx netlify deploy --prod` from the repo root; see
`netlify.toml`). "Shipped" in this document means merged to `main`; a
change reaches players only when someone deploys.

Two standing constraints: `base` in `web/vite.config.ts` must match the
path the build is served under — and the manifest's `id`/`start_url`/
`scope` must move with it, which #143 caught after #141 missed it and
left an installed app launching into a 404. Second, COOP/COEP headers
would be needed for `SharedArrayBuffer` and multi-threaded WebAssembly;
Netlify *can* set them (GitHub Pages could not), and they are off
because nothing needs them yet (see Open questions).

1. **Decisions** — done. Opening-bid mismatch resolved (engine value,
   300 min / 250 forced, is canonical; `pinochle_rules.md` updated to
   match). Stack locked (above).
2. **Rules engine port to TS** — done. `web/src/engine/` holds the core
   data model, deal, meld scoring, bidding, the 3-card pass,
   trick-taking, and round/game scoring, one file per concern with
   matching `*.test.ts`.
3. **Proficient-tier AI in TS** — done, and since superseded at `hard`
   and above by the distilled evaluator (Phase 3).
4. **Minimal playable UI** — done: table layout, card rendering,
   bid/pass/trick-play flows, round-summary and win/loss screens, AI
   skill selection, auction history, fold button. Scoped to *playable*;
   the fuller treatment is Phase 4.
5. **PWA shell** — done: manifest, icons, service worker (Workbox
   `generateSW` app-shell precache). The GitHub Pages deploy pipeline
   that was part of this item has since been removed (see Hosting
   above). Icons are programmatic placeholders (#129, closed — Paul's
   call is to keep them).
6. **Correctness net** — **open, tracked as #125.** Seeded-scenario
   parity between the Python and TS rules engines: pin the deal *and*
   the decisions in a committed fixture, replay the recorded play
   through the TS engine, assert agreement on meld scores, every trick
   winner, and the final round score. Note the two constraints recorded
   on the issue — the PRNGs differ, so do not seed both sides and
   compare; and AI *decisions* are meant to diverge (Python rolls out,
   TS `hard`+ runs the distilled evaluator), so only the rules engine is
   under test. #118 is the bug class this exists to catch: two ported
   bidding constants had silently drifted from the reference and changed
   which suit the browser names as trump. It was found by hand.

   Alongside it, #126 audits every ported constant and formula in
   `web/src/engine/` against the Python reference — the one-time sweep
   for drift that already happened, where #125 is the standing net.

## Phase 2 — Post-MVP hardening

Most of this is now done. What shipped:

- **Full `pytest` suite** — 269 tests, `python -m pytest -q`, ~3 min.
- **Tournament-simulation harness** — `tournament_sim.py` (+
  `test_tournament_sim.py`), issue #64: batch-runs N full games between
  two team configs, alternating seats to cancel positional bias.
  Superseded for AI-change validation by the paired A/B harness
  (`ab_harness.py`, #105), which controls for the deal as well.
- **Double Run meld documented** — `pinochle_rules.md:79`, including
  that it replaces the single Run rather than doubling it.
- **Misdeal reshuffle house rule documented** — `pinochle_rules.md:28`.
- **`pinochle_rules.md`'s Implementation Notes refreshed** — #128.
- **AI strategy open question 6 written up** — and in fact all of
  `pinochle_expert_ai_strategy.md` Section 9 is resolved, each with a
  pointer to the child issue of #57 that resolved it.

What is still open:

- Split `pinochle_engine.py` (~2,900 lines) into rules-engine and
  AI-strategy modules. This got *more* valuable, not less: the old
  reason to skip it was that Python was a frozen reference, and it
  isn't. The rollout, win-probability, dataset, fitting, and export
  layers already live in their own modules; the engine file is the
  remaining lump.
- Dedupe win-condition logic: `Game.play` (`pinochle_engine.py:2857`)
  and `play_local.py:130` each implement the bust/over check
  independently. They share the constants, not the logic.
- An explicit "changes to `Round` must be mirrored here" note on
  `InteractiveRound` — its docstring explains *how* it differs from
  `Round`, not that it has to be kept in step with it.

Deliberately **not** doing:

- Wiring the misdeal reshuffle into Python AI-only games. The house
  rule is honoured everywhere a player meets it — `web/src/engine/`
  implements the eligibility check and the redeal loop, and the TS
  headless harness redeals too. The gap is Python-side only:
  `Round.run()` goes straight from deal to bidding, and
  `InteractiveRound._check_misdeal` is the sole implementation. Closing
  it would invalidate every historical Python tuning baseline for a
  rule the shipped game already follows. Frozen on purpose; see #128.

## Phase 3 — Measured-EV AI, and distilling it into the browser — done

This is what the original "Phase 3 — Expert-tier AI" turned into, and
it did not wait behind Phase 2 the way the previous roadmap said it
would. `pinochle_expert_ai_strategy.md`'s core architecture —
determinization + rollout — is implemented and shipped; the strategy
doc is a spec that has been built, not a plan.

**The reframe (epic #106):** a threshold is a human's compressed guess
about a distribution; a rollout measures that distribution directly.
Fold is the cleanest case, because one side is exact —
`EV(fold) = -bid`, against the average scored outcome of playing on —
so nothing in the decision is a tuned constant.

Python side, `pinochle_rollout.py` + `win_probability.py`:

- Monte Carlo determinization + rollout, bid-time EV, return-pass
  triage, and the exact auto-SET guard (`#57`, issues #59–#65).
- **#105** — paired A/B harness (`ab_harness.py`): identical deals,
  seats mirrored, significance over pairs, split pairs discarded, an
  interval on score margin rather than games-won alone. Nothing else
  in this phase could have been shown to be an improvement without it.
- **#100** — fold by expected value rather than a non-loser threshold.
- **#101** — determinization constrained to the observed auction.
  Shipped **disabled**: no measurable difference. Recording null
  results as null was the right call and is the local precedent.
- **#102** — rollout objective switchable to P(win the game) rather
  than points, via a 20×20 score-bucket table tabulated from self-play
  (`win_probability.py`).
- **#103** — `EV(pass)` modelled as a real rollout instead of a flat
  zero.

Browser side, epic **#104** (#112 → #115), strictly sequential:

- Full rollouts cannot run on a phone — 150 samples × a 12-trick
  playout × each candidate bid × 4 suits, inside a React render loop.
  So: do the expensive thinking offline and ship the conclusion.
  Generate labelled rollout data (`generate_rollout_dataset.py`), fit a
  small model to it (`fit_evaluator.py`), export it as typed TS
  (`export_evaluator.py` → `evaluatorModel.ts`), and have `bidding.ts`
  consult that instead of `OPENER_THRESHOLD = 320` and friends.
- **#115** measured it and switched it on for `hard`/`proficient`/
  `expert`: **+227 score margin per deal** (95% CI +198 to +257,
  p < 1e-4) over 1000 paired deals, at **+872 B gzipped** and a p95 of
  495 µs per decision in mobile Chrome — against the 600 ms the auction
  already waits before each AI bid. The mechanism is that
  `DEFENSIVE_PUSH_FLOOR = 200` buys a great many cheap contracts the
  model declines: a third fewer contracts taken, 63.7% made against
  54.6%.
- `easy` and `medium` keep the thresholds on purpose — the evaluator
  distils *skill 5*, so wiring it into `easy` would delete the tier
  rather than calibrate it.
- **#95** ("AI underbids, avg 307 vs the 320 floor") was resolved here
  rather than fixed: under a measured-EV AI, average bid is an output,
  not a target. It was closed against games won.

**#123** — the fold model wired at **all five** skill levels. Bidding
is the skill dial; folding is shared competence, because conceding and
being set cost the bidding team exactly the same (`-bid`, meld
forfeited) and a fold only denies the defenders their trick points — it
is strictly dominant over a set, so no tier has a reason to decline it.
This deliberately reverses `pinochle_engine.py:1970`'s rule that the
static-vs-rollout switch moves together across all decision points.

**Measurement infrastructure that came with it** — `web/src/ab/`:
`headlessGame.ts` plays complete games with the same reducers and AI
entry points the UI calls, minus React and the delays; `abRun.ts` pairs
them the way `ab_harness.py` does; `stats.ts` is a direct port of its
three statistics; `bench/index.html` is the browser side of the latency
measurement. None of it reaches the bundle. Run `selftest` before
believing `ab`: one policy against itself must find *exactly* nothing,
and `ab.test.ts` asserts that.

What is left of the Expert tier:

- Real rollouts in the browser for skills 4–5, via a Web Worker. #104's
  original mapping assumed the top tiers would have them; in the
  browser they do not, so the distilled evaluator is currently their
  floor rather than their ceiling.
- The evaluator only governs the opening decision and the defensive
  push. The ordinary raise ladder and the 330/340 constants in
  `chooseBid` are untouched, and the two policies differ on 6.5% of
  real auction positions — that is the ceiling on what any of this can
  be credited with.
- Every seat in every A/B is an AI. The results show the policy is
  stronger, **not** that it is a better partner for a human. Measuring
  that needs a different harness.

## Phase 4 — UI/UX polish

- The MVP UI is proven playable, so the fuller "modern and pretty"
  treatment is now unblocked: table layout refinement, animations,
  responsive/mobile-first interaction details. Not yet scoped in
  detail.
- **#129** — the PWA ships programmatic placeholder icons (solid
  colour). Real art needs to keep the same filenames and sizes that
  `vite.config.ts` references. Blocked on a human, not an agent.

## Tooling & process (parallel track, not phase-gated)

See [TEAM.md](TEAM.md) for the full roster, label conventions, and
workflow — team-lead agents (architect, design, engineering, QA), the
`/standup`, `/work-queue`, and `/human-queue` commands, and epic
lifecycle rules are all live.

- [CODING_STANDARDS.md](CODING_STANDARDS.md) covers naming, module
  layout, and docstring style. Design and dev specs beyond that are
  still written per-issue rather than as standing documents.

## Settled questions

- **Python vs TypeScript.** Resolved by practice, not by decree:
  **TypeScript is what ships; Python is the reference implementation
  and the AI-research and measurement harness.** Both are active. The
  earlier framing — Python as a frozen reference that Phase 2/3 might
  one day revisit — is wrong in both halves: Phase 3 ran entirely in
  Python (rollouts, the win-probability table, dataset generation,
  model fitting), and nothing about that is winding down. What crosses
  the boundary is an *artifact*, not a port: `export_evaluator.py`
  generates `evaluatorModel.ts` and a parity fixture, and `--check`
  fails the Python suite if the committed TS has drifted. Expensive
  thinking in Python, cheap conclusions in the browser.

## Open questions

- Do skills 4–5 eventually get real rollouts in the browser (Web
  Worker), or does the distilled evaluator stay the top tier? Cost is
  the whole question and it has not been measured.
- Is a stronger AI a better *opponent and partner* for a human? Every
  measurement so far is AI-vs-AI, which cannot answer it.

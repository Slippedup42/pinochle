# Roadmap

Owned by the **architect** agent — keep this current as phases complete
or priorities shift. Other team-lead agents should treat this as the
top-level source of truth for sequencing; individual specs (rules, AI
strategy) live in their own docs and are linked from here.

**Current focus (2026-08-29).** Port fidelity is done — the parity net
(#125) and the constant-by-constant audit (#126) both landed on
2026-08-01, and `export_parity_scenarios.py --check` now fails the Python
suite when the committed fixture goes stale. What is actually open:

- **Removing the difficulty setting — epic #215, decided.** Paul's call
  is one AI shipped at the current `expert` configuration; #224 measures
  the Easy-to-Hard span first, #222 is the coupled edit, #221 deletes the
  `openingPolicy: 'walk'` arm, #223 writes the arm-retirement rule down.
  The explicit boundary is that `web/src/ab/`'s policy types and
  `*_AB_POLICIES` maps stay — the A/B ruler outlives the product dial.
  This contradicts the per-tier language further down this file; those
  passages are marked rather than rewritten ahead of the code.
- **#185** — the rollout dataset cannot report its own staleness, so a
  Python trick-play change silently changes what the browser bids with.
  The human call has been made: children #225 (fingerprint the dataset
  and add `generate_rollout_dataset.py --check`), #226 (regenerate,
  refit, re-export), #227 (re-measure the bidding baseline after).
- **#214** — splitting `pinochle_engine.py`, which this document has
  carried as open while the tracker carried #3 as wont-fix.
- **#211** — `web/src/ab/stats.ts` is a hand-port of `ab_harness.py`'s
  three statistics with no fixture behind it, and it is now what shipped
  strategy decisions are judged on.

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

## Phase 1 — PWA critical path — shipped

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
change reaches players only when someone deploys. The way to check is
the asset hash: `curl -s https://pinochle-house-rulez.netlify.app/ |
grep -o 'assets/[^"]*\.js'` against what is in `web/dist/assets`. As of
2026-08-29 they do **not** match. What is live is the #208 build; `main`
has since gained the dedupe refactors (#218, #229, #231, #6) and doc
changes, none of which a player can see, so nothing is waiting to ship —
but the mismatch had to be resolved by grepping a feature string out of
both bundles, because neither the repo nor the build records which commit
is deployed (#237).

Two standing constraints: `base` in `web/vite.config.ts` must match the
path the build is served under — and the manifest's `id`/`start_url`/
`scope` must move with it, which #143 caught after #141 missed it and
left an installed app launching into a 404. Second, COOP/COEP headers
would be needed for `SharedArrayBuffer` and multi-threaded WebAssembly;
Netlify *can* set them (GitHub Pages could not), and they are off
because nothing needs them yet (see Open questions).

1. **Decisions** — done. Opening-bid mismatch resolved: the engine
   value was canonical and `pinochle_rules.md` was updated to match.
   **Superseded by #200** — the auction now opens at 250 rather than
   300, changed in both engines in the same commit. Stack locked
   (above).
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
6. **Correctness net** — **done (#125).** Seeded-scenario parity
   between the Python and TS rules engines: `export_parity_scenarios.py`
   records complete Python rounds into `parity_scenarios.json` and
   renders `web/src/engine/engineParity.fixture.ts` from it;
   `engineParity.test.ts` replays the recorded play through the TS engine
   and asserts agreement on meld scores, every trick winner, and the
   final round score. Recording and rendering are separate stages on
   purpose, so `--check` can fail a stale fixture without the answer
   depending on what the AI decides today. Note the two constraints recorded
   on the issue — the PRNGs differ, so do not seed both sides and
   compare; and AI *decisions* are meant to diverge (Python rolls out,
   TS `hard`+ runs the distilled evaluator), so only the rules engine is
   under test. #118 is the bug class this exists to catch: two ported
   bidding constants had silently drifted from the reference and changed
   which suit the browser names as trump. It was found by hand.

   Alongside it, #126 audited every ported constant and formula in
   `web/src/engine/` against the Python reference — the one-time sweep
   for drift that had already happened, where #125 is the standing net.
   Both closed 2026-08-01.

   **The net does not cover everything that crosses the boundary.** It
   covers the rules engine, and `export_evaluator.py --check` covers the
   evaluator model. Two seams remain uncovered and are tracked: the
   dataset the evaluator is fit to (#185) and `web/src/ab/stats.ts`
   (#211).

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

- **Split `pinochle_engine.py` — now #214, and it needs a decision
  before it needs work.** The file is 3,107 lines, up from the 1,164 it
  had when #3 asked for this and was closed as wont-fix "migrating to
  the TS/PWA client and retiring the Python engine." That premise is
  disowned in [Settled questions](#settled-questions) below, so this
  document and the tracker have been saying opposite things. #214 exists
  to settle it either way. The rollout, win-probability, dataset,
  fitting, export and A/B layers already live in their own modules; the
  engine file is the remaining lump, and it is what all of them import.
- Dedupe win-condition logic: `Game.play` in `pinochle_engine.py` and
  `play_local.py:130` each implement the bust/over check independently.
  They share the constants, not the logic.
- An explicit "changes to `Round` must be mirrored here" note on
  `InteractiveRound` — its docstring explains *how* it differs from
  `Round`, not that it has to be kept in step with it.

The last two are cheap and are folded into #214 rather than tracked
separately.

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
  rather than calibrate it. **Overtaken by #215:** the three selectable
  levels turned out to be byte-identical rows of `SKILL_PARAMS` differing
  only in trump recall, worth ~4 points a deal, and the dial is being
  removed. Nothing about the evaluator changes; the tier it was withheld
  from stops existing.
- **#95** ("AI underbids, avg 307 vs the 320 floor") was resolved here
  rather than fixed: under a measured-EV AI, average bid is an output,
  not a target. It was closed against games won.

**#123** — the fold model wired at **all five** skill levels (five as
of the measurement; #215 collapses them to one). Bidding
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
measurement. None of it reaches the bundle — though nothing
checks that, and `installPolicies` writes into the shared `SKILL_PARAMS`
object rather than a copy, so the failure mode is a mutable engine config
rather than a fat bundle (#236). Run `selftest` before believing `ab`:
one policy against itself must find *exactly* nothing, and `ab.test.ts`
asserts that.

What is left of the Expert tier:

- Real rollouts in the browser for skills 4–5, via a Web Worker. #104's
  original mapping assumed the top tiers would have them; in the
  browser they do not, so the distilled evaluator is currently their
  floor rather than their ceiling.
- The evaluator still only governs the opening decision and the
  defensive push, and the two policies differ on 6.5% of real auction
  positions — that is the ceiling on what any of this can be credited
  with. The claim that the ordinary raise ladder is untouched has
  **expired**: #180 moved `PARTNER_PASSED_FLOOR` to 320, #206 made
  `PARTNER_RAISE_FLOOR = 340` a real floor rather than an accident of
  the ladder's arithmetic, and #204 added an `openingPolicy` dial in
  `skills.ts` (measured, shipped `'fixed'`). Those are tuned constants
  reached by A/B rather than by the evaluator, and all three were
  measured in `web/src/ab/`, not in Python.
- Every seat in every A/B is an AI. The results show the policy is
  stronger, **not** that it is a better partner for a human. Measuring
  that needs a different harness.

## Phase 4 — UI/UX polish — largely shipped

This was "not yet scoped in detail" as recently as the last revision of
this file. It was then scoped one issue at a time and mostly built. What
landed, all in `web/src/components/`:

- **Phone-first layout** — #161 (portrait pass: the table was too wide
  and too tall), then #187 (the hand overflowed, Menu sat on top of the
  scoreboard, the trick circle read off-centre).
- **Card rendering** — #189 (card-face redesign, jumbo index at 80px)
  and #202 (meld cards 28 → 42px, because they were unreadable on a
  phone).
- **Less chrome during play** — #191 moved auction status onto the trick
  circle, #193 dropped the auction history from trick play, #142
  permanently hid opponents' card fans and removed the toggle, #148
  deleted `showMeldHint` (a UI toggle nothing read).
- **Score context** — #198 added a hand-by-hand game ledger to both
  scoring screens, carried in `scoreTypes.ts` and persisted through
  `gameSave.ts`.
- **Skill presentation** — #194 collapsed the visible dial to Easy /
  Medium / Hard, defaulting to Medium.
- **#208, "the rest are mine"** — the one item here that is a rules
  shortcut rather than presentation, and worth flagging on the two-engine
  seam: it lives in `web/src/engine/round.ts` and **has no Python
  counterpart**. `pinochle_rules.md` says so explicitly, and
  `playTrickTakingPhase` — what the parity tests replay Python rounds
  through — deliberately does not apply it, so the shortcut stays
  outcome-neutral and the parity net stays valid. This is the right shape
  for a TS-only addition; it is documented rather than merely absent.

Still open:

- **#129** — the PWA ships programmatic placeholder icons (solid
  colour). Real art needs to keep the same filenames and sizes that
  `vite.config.ts` references. Blocked on a human, not an agent.
- **#194's three-level Options panel is being removed** — see #215 in
  Current focus. The skill-presentation entry above records what shipped,
  not where it is going.
- Animation and transition work, which nothing has asked for yet.

## Tooling & process (parallel track, not phase-gated)

See [TEAM.md](TEAM.md) for the full roster, label conventions, and
workflow — team-lead agents (architect, design, engineering, QA), the
`/standup`, `/work-queue`, and `/human-queue` commands, and epic
lifecycle rules are all live.

- [CODING_STANDARDS.md](CODING_STANDARDS.md) covers naming, module
  layout, and docstring style, in two parts: Python, and the separate
  TypeScript conventions `web/` follows (formatting, the
  `erasableSyntaxOnly`/`verbatimModuleSyntax` constraints, the
  component/reducer/types split, and where a TS-only rule may live
  without breaking engine parity). Design and dev specs beyond that are
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

### Where measurement runs

**A/B measurement has two homes now, and that is deliberate.** The rule
is *measure a policy where that policy ships*:

- `ab_harness.py` measures Python-side AI — the rollout, EV and
  win-probability work of Phase 3. Still in use (#173's Proficient arm
  was measured with it) though the harness itself has not needed a
  change since #178.
- `web/src/ab/` measures anything that reaches a player. #153, #156,
  #158, #180, #204 and #206 all ran here. It is not a lesser harness:
  `headlessGame.ts` drives the same reducers and AI entry points the UI
  calls, `abRun.ts` pairs deals and mirrors seats the way `ab_harness.py`
  does, and `selftest` asserts a policy against itself finds exactly
  nothing.

The seam this creates is that `stats.ts` is a hand-port of
`ab_harness.py`'s three statistics with nothing checking it (#211) — the
only thing crossing the Python/TS boundary that is neither generated nor
guarded.

## Open questions

- Do the top skills eventually get real rollouts in the browser (Web
  Worker), or does the distilled evaluator stay the ceiling? Cost is the
  whole question and it has not been measured. After #215 there is only
  one shipped AI, so this is no longer "a tier gets rollouts" but "the
  AI does", which raises the bar: it would have to be affordable for
  every player, not just the ones who chose Hard. The prerequisite
  COOP/COEP headers are noted in `netlify.toml` and stay off until then.
- Is a stronger AI a better *opponent and partner* for a human? Every
  measurement so far is AI-vs-AI, which cannot answer it.

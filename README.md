# Pinochle

[![Netlify Status](https://api.netlify.com/api/v1/badges/8da01171-1d8b-4cbe-849e-4ef994fc0b68/deploy-status)](https://app.netlify.com/projects/pinochle-house-rulez/deploys)

A Partnership Pinochle game, built from scratch: a TypeScript PWA, plus
a Python reference implementation that doubles as the AI-research and
measurement harness.

## Status

**Play it: <https://pinochle-house-rulez.netlify.app>**

The PWA in [`web/`](web/) is the product — a complete game against three
AI opponents: deal, misdeal, auction, trump, 3-card pass, meld, trick
play, round scoring, and multi-round games to ±1000, across five
difficulty levels, with local autosave across a page reload. On a phone
it installs to the home screen and launches full-screen.

**Deploys are manual, and merging does not ship.** GitHub is source
control only — the repo is deliberately not connected to Netlify's git
integration (see [`netlify.toml`](netlify.toml) and the 2026-08-01
decision in [`ROADMAP.md`](ROADMAP.md)). A merged PR is not live until
someone builds and deploys:

```
cd web && npm ci && npm run build
cd .. && npx netlify deploy --prod
```

Run the deploy from the repo root — `publish` in `netlify.toml` resolves
relative to that file. To run the app locally instead, `npm run dev` in
[`web/`](web/); see [`web/README.md`](web/README.md).

The badge above reports the last deploy Netlify processed. Since nothing
builds on their servers it is a thin signal — it says an upload
succeeded, not that `main` is live. To know what is actually out there,
ask the deploy:

```
curl -s https://pinochle-house-rulez.netlify.app/version.json
```

Every build stamps that file with the commit it was built from (#237);
it is served uncached and is not precached by the service worker, so it
describes the deploy rather than the visitor's cache.

The Python side has two live roles: it is the reference implementation
the TypeScript port is checked against, *and* the harness all the AI
research and measurement runs on. `pinochle_engine.py` implements the
same rule set end-to-end, with real **Proficient-tier** strategy on
`Player` (hand valuation via Base Bid, positional/score-aware bidding,
category-split passing, card-counting trick play) and, above it,
`GeneralStrategy`
(Monte Carlo determinization + rollout, skill level 1-5) and
`RandomStrategy` (which draws a skill level once at construction). An
interactive human-play layer (`human_play.py`, `play_local.py`) lets a
person play against it in a terminal.

Expensive thinking in Python, cheap conclusions in the browser: full
rollouts can't run on a phone, so the rollout AI is distilled offline
into a small bid/fold model and exported to
`web/src/engine/evaluatorModel.ts`. What crosses the boundary is a
generated artifact rather than a hand-port —
`python export_evaluator.py --check` fails the Python suite if the
committed TypeScript has drifted from the model.

Neither side is winding down. Player-visible behaviour lands in
TypeScript; Python stays authoritative for ported rules constants and
is where the next round of strategy work will run. See
[`ROADMAP.md`](ROADMAP.md) for sequencing and `pinochle_rules.md`'s
"Implementation Notes" for how the two engines divide up.

## Contents

- [`web/`](web/) — **the product**: the React + TypeScript + Vite +
  Tailwind PWA, deployed to <https://pinochle-house-rulez.netlify.app>.
  Has its own [`web/README.md`](web/README.md). Inside it:
  - `src/engine/` — the TypeScript rules engine, split one file per
    concern (`card.ts`, `melds.ts`, `bidding.ts`, `passing.ts`,
    `trick.ts`, `tracker.ts`, `round.ts`, `game.ts`, `misdeal.ts`,
    `names.ts`/`teamNames.ts`), each with a matching `*.test.ts`. This
    is the engine players actually meet: a rule that is wrong here is
    wrong for players.
  - `src/engine/evaluator.ts` + `evaluatorModel.ts` — the shipped AI.
    The distilled bid/fold model that `export_evaluator.py` generates
    from the Python rollouts, alongside `evaluatorParity.fixture.ts` /
    `evaluatorParity.test.ts`, which fail the TS suite if the two sides
    ever compute different features. `skills.ts`'s `SKILL_PARAMS` is the
    difficulty dial (`easy` through `expert`): `hard` and above bid with
    the distilled evaluator, and all five levels fold with it and play
    trick cards the same way (#156).
  - `src/components/` — the UI and the reducers behind it.
    `gameFlowReducer.ts` drives a round end to end; `auctionReducer.ts`
    and `trickPlayReducer.ts` own the auction and trick phases. The
    misdeal ask/redeal loop is UI-layer state here rather than in
    `round.ts`, which picks up after trump is set.
  - `src/persistence/` — localStorage autosave (`gameSave.ts`, which
    reconstructs real `Card` instances on load, since they don't survive
    a JSON round trip) and stored options.
  - `src/ab/` — the TypeScript A/B harness, counterpart to
    `ab_harness.py`: `headlessGame.ts` plays complete games without
    React through the same reducers and AI entry points the UI calls.
    Not shipped — nothing outside the App's import graph reaches the
    bundle.
- [`ROADMAP.md`](ROADMAP.md) — the phased plan and where the project
  currently sits against it.
- [`TEAM.md`](TEAM.md) — team-lead agent roster, issue-label
  conventions, and the `/standup` / `/work-queue` workflow.
- [`CODING_STANDARDS.md`](CODING_STANDARDS.md) — naming, module
  layout, docstring style, and other implementation patterns already
  in use, documented so new code stays consistent with them. Split into
  a Python part and a TypeScript part, since the two engines have
  genuinely different conventions.
- [`pinochle_rules.md`](pinochle_rules.md) — the rule set this engine
  implements, including house rules (3-card pass, ±1000 game
  thresholds).
- [`pinochle_expert_ai_strategy.md`](pinochle_expert_ai_strategy.md) —
  design spec for the General Strategy AI: Monte Carlo determinization +
  rollout for bidding, passing, and trick play, on top of the
  Proficient tier already implemented. This is the *offline* AI — what
  the PWA ships is the model distilled from it, not the rollout itself.
  Implemented as `GeneralStrategy`,
  a single `Player` subclass parameterized by a skill level 1-5 (issue
  #63) rather than a separate hardcoded tier — see Section 8. All of
  Section 9's open design questions are now resolved, with pointers to
  which child issue of #57 resolved each.
- [`pinochle_engine.py`](pinochle_engine.py) — the Python reference
  rules engine and the Proficient AI: `Card`, `Deck`, `Player`, `Team`, `Trick`, `Round`,
  `Game`, meld scoring, bid valuation, passing strategy, trick-play
  strategy. Also holds the General Strategy machinery: the forward/return
  pass logic (`choose_forward_pass_cards` / `choose_return_pass_cards`,
  issue #61, `pinochle_expert_ai_strategy.md` Sections 2-3) and
  trick-play logic (`choose_expert_lead_card` / `choose_expert_follow_card`,
  issue #62, Sections 4 and 7) as free functions independent of any
  `Player` subclass, called into by both `GeneralStrategy` and the
  rollout sampler's simulated players — plus `GeneralStrategy` and
  `RandomStrategy` themselves (issue #63), which wire that machinery and
  #59/#60's rollout sampler / bid-time EV together behind one skill-level
  dial. Trick-play logic covers Ace-first trump leads (shared by the
  Bidder and partner), endgame loser-first sequencing to protect the
  12th-trick bonus, following-suit heuristics (duck/feed, count-card
  protection, over/under-trump judgment), a static-vs-rollout-compare
  split for whether defenders ever lead trump, and false-carding/
  fake-void deception as pluggable candidate moves gated behind an
  optional `deception_evaluator`.
- [`pinochle_rollout.py`](pinochle_rollout.py) — Monte Carlo
  determinization sampler + Auto-SET guard (issue #59): deals the
  currently-unseen cards for a decision point (bidding / return-pass /
  trick-play), rolls a sample out to completion via the real pass/
  trick-play logic, and aggregates P(make)/E[points] across samples.
  Carries three objectives over the same rollouts, in increasing order of
  what they can see: own points (`bid_ev`, #60), score differential
  (`bid_ev_differential` / `defend_ev` / `fold_ev`, #100/#103), and
  probability of winning the game (`*_win_probability`, #102) — the last
  being the only one the game score is an input to.
- [`win_probability.py`](win_probability.py) — P(win the game | score
  state), the objective the rollout AI can maximize instead of points
  (issue #102). A coarse 20×20 lookup table over both teams' scores in
  100-point buckets, tabulated from Proficient self-play and smoothed
  toward a race-model prior, plus exact resolution of already-decided
  states (bust before target; a round carrying both sides past 1000 goes
  to the bidding team). Also the generator that built it —
  `python win_probability.py --games 6000 --seed 7` reprints the table
  literal. Consumed by `pinochle_rollout.py`'s
  `bid_ev_win_probability` / `defend_ev_win_probability` /
  `fold_ev_win_probability`, which are gated behind the
  `use_win_probability` skill parameter.
- [`generate_rollout_dataset.py`](generate_rollout_dataset.py) — offline
  generator for the labelled training data epic #104's distillation is
  fitted to (issue #112). Plays real games with a recording
  `GeneralStrategy` subclass, captures every bid and concede decision the
  auction actually produced (rather than sampling hands uniformly, which
  is a different distribution from the one the AI meets), and labels each
  with `pinochle_rollout.py`'s measured `p_make` / `bid_ev_differential` /
  `defend_ev` / `should_fold`. Which configuration gets labelled is read
  out of `GENERAL_STRATEGY_SKILL_PARAMS` at runtime rather than assumed —
  `--config` prints it. Output is `rollout_dataset.csv`; the committed
  file is a reproducible 2000-row prefix of a longer run, not a
  hand-edited artifact.
- [`fit_evaluator.py`](fit_evaluator.py) — fits the cheap evaluator epic
  #104 wants to ship to that dataset (issue #113), and reports how often
  it reaches the rollout's *decision* rather than how close it gets to
  `p_make`. Two separate logistic models, because a bid row (auction
  running, melds unknown) and a fold row (auction over, both melds face
  up) are different problems sharing one table. Held out the last 25% of
  rows in capture order — a shuffled split would scatter one deal's rows
  across the boundary. Held-out decision agreement is 85.5% on bid rows
  against 74.3% for the shipped `ceiling >= OPENER_THRESHOLD` rule, and
  92.0% on fold rows against 81.6% for never conceding; disagreements sit
  almost entirely where the rollout's own two EVs are within sampling
  noise of each other, not on any hand class. Nothing heavier than
  logistic regression was warranted: a 150-tree gradient-boosted ensemble
  on the same features scored 86.7% five-fold against the linear model's
  86.3% ± 1.9%. Output is `rollout_evaluator.json`, the artifact #114
  exports to TypeScript.
- [`export_evaluator.py`](export_evaluator.py) — carries that artifact
  into the PWA (issue #114). Generates two files under
  `web/src/engine/`: `evaluatorModel.ts`, the weights as a typed module
  rather than a JSON import, and `evaluatorParity.fixture.ts`, a fixed
  set of real hands scored by the *Python* model. The fixture is what
  `evaluatorParity.test.ts` fails against when the two sides compute
  different features — most of all `base_bid_ceiling`, which is not a
  stored column but a re-derivation of `compute_max_bid`/`capped_bid`
  and is worth eight points of decision agreement on its own. Both files
  are regenerated, never edited; `--check` fails the Python suite if
  they have drifted from the model, which is the only place that drift
  is visible (a stale model module and a stale fixture agree with each
  other perfectly).
- [`export_parity_scenarios.py`](export_parity_scenarios.py) — the
  correctness net between this engine and the shipped TypeScript one
  (issue #125, ROADMAP.md Phase 1.6). Plays 40 seeded rounds and records
  each one whole — the four dealt hands, the auction result, the 3-card
  pass both ways, every card of every trick, the legal-move set at every
  follow — into `parity_scenarios.json`, then renders it as
  `web/src/engine/engineParity.fixture.ts`. `engineParity.test.ts`
  replays the recorded cards through the TS engine and has to arrive at
  the same meld per hand, the same winner and points for every trick,
  and the same final round score. Note what is *not* compared: the deals
  (the two sides use different PRNGs, so the same seed cannot produce
  the same deal) and the AI's decisions (Python rolls out, TS `hard`+
  runs the distilled evaluator — divergence there is the design). Only
  the rules are. Recording replays the AI and so is on-demand
  (`--record`); rendering is a pure function of the committed JSON, so
  `--check` can fail a hand-edited fixture without the answer depending
  on what the AI decides today.
- [`human_play.py`](human_play.py) — resumable interactive play layer
  (`HumanPlayer`, `InteractiveRound`) built for chat-session play, where
  a script can't block on `input()` between messages: decisions raise
  `NeedsHumanInput`, state is pickled to disk, and the next invocation
  resumes exactly where it left off.
- [`play_local.py`](play_local.py) — a standalone terminal version of
  the same interactive play, using plain `input()` in one continuous
  process (no pickling needed).
- [`names.py`](names.py) — 200-name pool for randomizing AI opponent
  names.
- [`tournament_sim.py`](tournament_sim.py) — dev/tuning tool: batch-runs
  N full `Game.play()` matches between two team configs (player class +
  kwargs per seat), alternating which physical seats each team occupies
  to cancel out positional bias, and reports win rate and average score
  margin per team. It has already done the job it was built for: issue
  #65's tuning pass set `GeneralStrategy`'s per-skill-level defaults on
  200-game tournaments and confirmed the levels come out monotonically
  ordered — that results table is the strategy doc's Section 8. For
  judging an AI *change* it has since been superseded by
  `ab_harness.py`, which controls for the deal as well as the seat.
- [`ab_harness.py`](ab_harness.py) — the paired A/B harness (issue
  #105), and the reason anything in the measured-EV work could be
  claimed as an improvement: identical deals played by both configs
  with the seats mirrored, significance taken over pairs rather than
  games, split pairs discarded, and a bootstrap interval on score
  margin because games-won alone is too coarse. `web/src/ab/` is the
  TypeScript counterpart; `stats.ts` there is a direct port of this
  module's three statistics.

## Running

The shipped client, from `web/`:

```
npm install
npm run dev     # dev server
npm run build   # typecheck + production build
npm test        # vitest
```

The Python reference and research harness, from the repo root:

```
python pinochle_engine.py   # rules engine self-checks + full-game sanity runs
python play_local.py        # play a full interactive game in the terminal
python tournament_sim.py --games 300   # Proficient-vs-Proficient sanity check (~50/50)
python ab_harness.py --pairs 100       # A/B harness self-test (a config against itself)
python win_probability.py --games 6000 --seed 7   # regenerate the win-probability table
python generate_rollout_dataset.py --config       # print the config the labels describe
python generate_rollout_dataset.py --games 100 --samples 150 --seed 112 --max-rows 2000
                                       # regenerate the committed rollout dataset (~15 min)
python fit_evaluator.py --compare --disagreements
                                       # refit the cheap evaluator, with the baselines it
                                       # has to beat and where it disagrees (~15 s)
python export_evaluator.py             # regenerate the TypeScript the PWA bids with
python export_evaluator.py --check     # fail if the committed TypeScript is stale
python export_parity_scenarios.py --record
                                       # re-record the engine-parity scenarios (~1 min)
python export_parity_scenarios.py      # re-render the TS fixture from the committed JSON
python export_parity_scenarios.py --check  # fail if that fixture is stale
python -m pytest -q                    # full test suite
```

## Architecture

### Two engines, one rule set

`pinochle_rules.md` is the source of truth and both engines implement
it, but they are not peers. **TypeScript (`web/src/engine/`) is the one
that ships** — a rule that is wrong there is wrong for players.
**Python (`pinochle_engine.py`) is the reference** the port is checked
against, and the platform the AI research runs on. Where a ported
constant disagrees, Python is right and the TS side has drifted; that
has happened (issue #118, two bidding constants, which changed the suit
the browser named as trump), which is why #125 tracks a standing parity
net and #126 a constant-by-constant audit.

They also legitimately differ in one place: the misdeal reshuffle is
implemented for every game mode in TypeScript, but in Python it exists
only in `human_play.py`'s `InteractiveRound` — `Round.run()` goes
straight from deal to bidding, so Python AI-only games never reshuffle.
That is deliberate: closing it would invalidate every historical Python
tuning baseline for a rule the shipped game already follows. See
`pinochle_rules.md`'s "Implementation Notes" for the full account.

### Shared concepts

- **Card rank** is non-standard: `A > 10 > K > Q > J > 9`.
- **Melding is a pure function** (`score_melds`) over a hand and trump
  suit — not a player decision. Doubles (Double Run, Double Pinochle,
  Arounds doubles) replace the single value rather than stacking.
- **Bid valuation** is layered: `compute_base_bid` (guaranteed +
  speculative hand value) → `compute_competitive_adjustment`
  (score-context) → `max_bid`'s 400-cap / >300-meld-uncap rule.
- **`Trick`** owns legal-move filtering and winner resolution, so
  `Player` doesn't need to know the rules.
- **`PlayTracker`** records which of the two copies of each card have
  been played, so trick-play strategy (`choose_lead_card`,
  `choose_follow_card`) can reason about safe leads and live liabilities
  across the whole round, not just the current trick.
- **`Round`** runs one hand end-to-end: deal → bid → pass → meld → trick
  play → score. **`Game`** wraps `Round` in a loop, tracking cumulative
  team scores against the ±1000 win/loss thresholds.
- **`InteractiveRound`** (in `human_play.py`) mirrors `Round` phase for
  phase, but keeps position in instance attributes instead of local
  variables so it can be interrupted by `NeedsHumanInput` and resumed
  later without losing progress.

### TypeScript side (`web/`)

- **The engine is split by concern, not by class.** Where Python has one
  ~2,900-line module, `web/src/engine/` is one file per concern
  (`card.ts`, `melds.ts`, `bidding.ts`, `passing.ts`, `trick.ts`,
  `tracker.ts`, `round.ts`, `game.ts`), each with a matching
  `*.test.ts`. `round.ts` picks up after trump is set.
- **Reducers own phase state, not the engine.** `gameFlowReducer.ts`
  drives a round end to end, with `auctionReducer.ts` and
  `trickPlayReducer.ts` owning the auction and trick phases. Anything
  that needs to ask the human — the misdeal offer, pass reveal — is
  UI-layer state here rather than in the engine.
- **The shipped AI is a distilled model, not a rollout.** `evaluator.ts`
  consults `evaluatorModel.ts`'s weights instead of thresholds like
  `OPENER_THRESHOLD`. `skills.ts`'s `SKILL_PARAMS` is the dial: `hard`
  and above bid with the model, `easy` and `medium` keep the hand-tuned
  constants on purpose (the model distils *skill 5*, so wiring it into
  `easy` would delete the tier rather than calibrate it), and **all five
  levels fold with it** — conceding and being set cost the bidding team
  the same (`-bid`, meld forfeited either way) while a fold denies the
  defenders their trick points, so folding well is shared competence
  rather than part of the difficulty dial. **All five also play trick
  cards identically** (`playPolicy: 'cascade'`, #156): a weak bid is
  invisible to the other seats, a weak card is face up on the table and
  reads as a broken partner rather than an easy opponent. The dial is
  what a level is willing to *bid*.
- **A contract the arithmetic has already killed never gets played**
  (auto-SET, #178). When the bidding team's meld plus every trick point
  in the round — `MAX_TRICK_POINTS`, derived in `round.ts`, 250 today —
  still falls short of the bid, `isAutoSet` ends the round in the
  concede window, *ahead* of the fold model: `shouldConcede` is a fitted
  probability and this is not. It applies to the human bid winner too,
  who has no skill level, and the app says why (`AutoSetNotice`) rather
  than jumping to a summary for twelve tricks nobody played. Scoring
  reuses the existing concession path unchanged, and Python does the
  same thing in `Round._concede_phase`. Measured over 5000 paired deals:
  it fires on **7.2% of contracts**, and is worth **+1.20 points per
  deal** (95% CI +0.52 to +1.93) on top of the shipped fold model, which
  was already folding most of those hands — **+11.66** (95% CI +9.53 to
  +13.78) with the fold model off, which is the rule's own size.
- **Parity is enforced, not assumed.** `evaluatorModel.ts` and
  `evaluatorParity.fixture.ts` are generated by `export_evaluator.py`
  and never edited by hand. `evaluatorParity.test.ts` fails when the two
  sides compute different features; `export_evaluator.py --check` fails
  the Python suite when the committed TypeScript is stale. Both
  directions are needed — a stale model module and a stale fixture agree
  with each other perfectly.
- **The measurement harness doesn't ship.** `web/src/ab/` plays complete
  games through the same reducers and AI entry points the UI calls,
  minus React and the animation delays. Nothing outside the App's import
  graph reaches the bundle.

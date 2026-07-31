# Pinochle

A Partnership Pinochle engine and AI, built from scratch in Python.

## Status

The rules engine is complete: deal, bidding, 3-card pass, meld scanning,
trick-taking, round scoring, and multi-round games to ±1000. `Player`
now runs real **Proficient-tier** strategy (hand valuation via Base Bid,
positional/score-aware bidding, category-split passing, card-counting
trick play) rather than placeholder logic — see `pinochle_engine.py`'s
`__main__` block for self-checks. An interactive human-play layer
(`human_play.py`, `play_local.py`) lets a person play against the AI.
`GeneralStrategy` (Monte Carlo determinization + rollout, skill-level
1-5) and `RandomStrategy` (a thin wrapper that draws a random skill
level at creation) are implemented — see the strategy doc below.

## Contents

- [`ROADMAP.md`](ROADMAP.md) — phased plan from current state through
  Expert AI, the web/mobile client, and PWA distribution.
- [`TEAM.md`](TEAM.md) — team-lead agent roster, issue-label
  conventions, and the `/standup` / `/work-queue` workflow.
- [`CODING_STANDARDS.md`](CODING_STANDARDS.md) — naming, module
  layout, docstring style, and other implementation patterns already
  in use, documented so new code stays consistent with them.
- [`pinochle_rules.md`](pinochle_rules.md) — the rule set this engine
  implements, including house rules (3-card pass, ±1000 game
  thresholds).
- [`pinochle_expert_ai_strategy.md`](pinochle_expert_ai_strategy.md) —
  design spec for the General Strategy AI: Monte Carlo determinization +
  rollout for bidding, passing, and trick play, on top of the
  Proficient tier already implemented. Implemented as `GeneralStrategy`,
  a single `Player` subclass parameterized by a skill level 1-5 (issue
  #63) rather than a separate hardcoded tier — see Section 8. All of
  Section 9's open design questions are now resolved, with pointers to
  which child issue of #57 resolved each.
- [`pinochle_engine.py`](pinochle_engine.py) — the rules engine and
  Proficient AI: `Card`, `Deck`, `Player`, `Team`, `Trick`, `Round`,
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
  margin per team. Now that `GeneralStrategy` exists, this is the
  intended mechanism (per the strategy doc's Section 8 validation plan)
  for tuning its per-skill-level parameters against `Player`/
  `EasyPlayer` and against itself — not yet run at scale for that
  purpose, but the harness is ready.

## Running

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
python -m pytest -q                    # full test suite
```

## Architecture

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

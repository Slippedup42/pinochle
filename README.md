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
Expert-tier AI (Monte Carlo determinization + rollout) is designed but
not yet implemented — see the strategy doc below.

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
  design spec for the Expert-tier AI: Monte Carlo determinization +
  rollout for bidding, passing, and trick play, on top of the
  Proficient tier already implemented. Several open design questions
  are called out at the end and should be resolved before implementing
  the sections they affect.
- [`pinochle_engine.py`](pinochle_engine.py) — the rules engine and
  Proficient AI: `Card`, `Deck`, `Player`, `Team`, `Trick`, `Round`,
  `Game`, meld scoring, bid valuation, passing strategy, trick-play
  strategy.
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
  margin per team. Not yet useful for its intended purpose (comparing
  AI skill levels) until the Expert/GeneralStrategy tier lands, but
  runs today against `Player`/`EasyPlayer`.

## Running

```
python pinochle_engine.py   # rules engine self-checks + full-game sanity runs
python play_local.py        # play a full interactive game in the terminal
python tournament_sim.py --games 300   # Proficient-vs-Proficient sanity check (~50/50)
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

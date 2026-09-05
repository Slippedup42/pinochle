# Pinochle — web client

The product — React + TypeScript + Vite + Tailwind CSS. A complete game
against three AI opponents. Live at
<https://pinochle-house-rulez.netlify.app>. Run it locally with
`npm run dev`; **deploys are manual and merging does not ship** — see
"PWA / deployment" below.

The rules engine (`src/engine/`) is a TypeScript port of the Python
reference implementation (`../pinochle_engine.py`). Both sides are active
and neither is winding down: player-visible behaviour lands here, while
Python stays authoritative for ported rules constants and is where the AI
research and measurement run. The root [`README.md`](../README.md) and
[`CLAUDE.md`](../CLAUDE.md) describe that split; [`ROADMAP.md`](../ROADMAP.md)
has the sequencing.

## Running

```
npm install
npm run dev     # dev server
npm run build   # typecheck + production build
npm test        # vitest
```

## Structure

- `src/engine/` — the ported rules engine, one file per concern rather than
  one module with section breaks, each with a matching `*.test.ts`:
  `card.ts`, `melds.ts`, `bidding.ts`, `passing.ts`, `trick.ts`, `tracker.ts`,
  `round.ts`, `game.ts`, `misdeal.ts`, and `names.ts`/`teamNames.ts`. Those
  tests cover the same edge cases as the Python `__main__` self-checks (Double
  Run vs. Run, Double Pinochle vs. Pinochle, etc.) plus additional coverage.
  Alongside them: `skills.ts` (`SHIPPED_PARAMS`, the one AI configuration the
  product plays, and the five `SKILL_PARAMS` slots `src/ab/` measures with —
  there is no difficulty setting since #222), the shipped AI (`evaluator.ts`),
  and two generated fixture pairs that
  check this engine against the Python reference and are never hand-edited —
  `evaluatorModel.ts` + `evaluatorParity.*` from `../export_evaluator.py`, and
  `engineParity.*` from `../export_parity_scenarios.py` (described below).
- `src/App.tsx` — four lines; renders `<GameShell />`.
- `src/components/` — the UI and the reducers behind it. `GameShell.tsx` owns
  the start-menu/in-game split and the Options overlay; `gameFlowReducer.ts`
  drives a round end to end, with `auctionReducer.ts` and
  `trickPlayReducer.ts` owning the auction and trick phases.
- `src/persistence/` — localStorage autosave (`gameSave.ts`) and stored
  options.
- `src/ab/` — the measurement harness (issue #115). Not shipped: nothing under
  `src/` outside the App's import graph reaches the bundle. `stats.ts` is a
  third generated-fixture pair, `statsParity.*` from
  `../export_stats_parity.py` (#211). See below.

## Parity with the Python engine (`engineParity.*`)

`src/engine/` is a hand port, and until #125 each side was only ever checked
against itself. #118 is what that costs: `NEAR_RUN_VALUE` and
`NEAR_DOUBLE_PINOCHLE_VALUE` were ported at half value, so the browser named a
different trump suit than the reference for months, and it surfaced because
someone read both files side by side while working on something else.

`engineParity.fixture.ts` holds 40 complete rounds exactly as `pinochle_engine.py`
played them, and `engineParity.test.ts` replays the recorded cards through this
engine. Two things are deliberately **not** compared, and both look like the
obvious approach:

- **The deals.** Python shuffles with `random.Random`, the TS side reseeds
  `Math.random` via `makeRng`. Different PRNGs — the same seed does not produce
  the same deal and never will. So the deal is *pinned*, not generated.
- **The AI's decisions.** Python runs Monte Carlo rollouts, TS `hard`+ runs the
  evaluator distilled from them (#115). Divergence there is the design, so the
  auction result, the 3-card pass and every card played are pinned too.

What is compared is only what both sides must agree on: `scoreMelds` per hand
(total *and* breakdown), the winner and points of every trick, the +10
last-trick bonus, and `scoreRound`'s final number for both teams. Plus the
legal-move set at every follow, compared as a set rather than "was Python's card
allowed" — the one-directional version catches a filter that is *stricter* than
the reference but not one that is *looser*, and looser is the bug that reaches a
player, as a browser that lets you underplay a trick you were required to beat.

Regenerating, from the repo root (not `web/`):

```
python export_parity_scenarios.py --record   # replay the Python engine, rewrite both files
python export_parity_scenarios.py            # re-render the TS fixture from the committed JSON
python export_parity_scenarios.py --check    # fail if the committed fixture is stale
```

`--record` is on demand only. Recording replays the AI, so re-recording on every
run would turn any AI change into a red suite and a six-figure diff; rendering
is a pure function of the committed `parity_scenarios.json`, which is what
`--check` and `test_export_parity_scenarios.py` guard. That Python test also
replays every committed scenario back through the *Python* engine, so a rules
change on that side fails there rather than showing up here as an unexplained
TS failure.

## Parity of the statistics (`statsParity.*`, #211)

`src/ab/stats.ts` is the same kind of hand-port, of `ab_harness.py`'s
`binomial_two_sided_p`, `wilson_interval` and `bootstrap_mean_ci`, and it was
the last one with nothing behind it. It matters more than an uncovered module
usually would because these functions are not part of the product — they are
what the product's *decisions* were judged by. A divergence would not turn a
suite red; it would make a decision wrong, and the run that made it would read
exactly like a run that did not.

`statsParity.fixture.ts` is generated by `../export_stats_parity.py` and
`statsParity.test.ts` holds this module to it. The cases are chosen for where a
port slips rather than sampled: every documented contract (1.0 from a zero-trial
binomial, `[0, 1]` from a zero-trial Wilson, the two degenerate bootstrap
returns), the exact binomial's tails out to 1000 trials where the TS side works
in log space and Python does not, asymmetric `p` where the near-ties are real,
both Wilson clamps, and each bootstrap percentile index plus the clamp one past
the end. Agreement is relative to 1e-9; the measured disagreement across the
fixture is worst 1.5e-13, and the test asserts both that bound and that a 1e-6
error in any recorded number would be rejected.

Two things are pinned rather than compared, for the reasons above. The
resampling draws, because `random.Random.randrange` and
`Math.floor(rand() * n)` are different generators — so what is compared is the
interval construction, which is the hand-written part. And the default
arguments, recorded from Python's signatures: every case passes `p`, `z`,
`iters` and `alpha` explicitly while *both* harnesses call with none of them, so
`abRun.ts`'s `wilsonInterval(pairsA, decisivePairs)` needs its own check.

```
python export_stats_parity.py --record   # re-run the Python statistics, rewrite both files
python export_stats_parity.py            # re-render the TS fixture from the committed JSON
python export_stats_parity.py --check    # fail if either has drifted
```

Unlike the round recorder, this recording is pure, so `--check` also compares
the committed JSON against a fresh Python run — a change to a Python statistic
fails the Python suite naming the case rather than surfacing here days later.

## Measuring the AI (`src/ab/`)

> **Superseded, 2026-09-03 (#269). Every measurement in this section is
> kept for the reasoning it records, not as a statement about the AI this
> engine runs today. Re-measurement is tracked on #270.**

Read the tables below as decisions with their evidence attached, and not as
current fact. Four separate things have moved underneath them since they were
taken, and the fourth is the one that will be misread.

**The scoring itself was wrong for the life of the project.** #273 (2026-08-31)
corrected `score_melds` in both engines: a Run absorbs the Royal Marriage inside
it, so a bare trump run melds **150, not 190**. Every hand holding a trump run
had scored 40 too many since the first commit, which means every game in every
run recorded here was scored wrong — on both arms, so the comparisons were fair,
but the margins are denominated in a currency that has since been corrected.
That invalidates this record far more broadly than the difficulty dial does.

**The difficulty dial is gone.** #222 collapsed five engine levels onto the one
configuration `SHIPPED_PARAMS` names, and #269 deleted the two results below
whose arms were levels rather than policies — the five-capacity trump-recall
ladder and the `capacity --high expert --low easy` head-to-head. What survives
still says things like "`hard` and above now run `'distilled'`; `easy` and
`medium` keep the thresholds". That was true when it was written. A level name
now means a slot in `src/ab/` that `installPolicies` can seat a policy on, not a
tier a player could pick — see `SkillLevel` in `skills.ts`.

**Four behaviour changes have landed with no A/B behind any of them**, by
standing instruction that paired measurement waits until the queue is drained
(#270):

- **#256** — endgame protection: a team within 250 of winning, against
  opponents below 450, passes the whole auction.
- **#277** — the bid valuation restructured into three stages, and **known to be
  miscalibrated**. Mean ceiling 270 → 344, hands clearing `OPENER_THRESHOLD`
  27% → 56%, auto-SET 6.6% → 12.6%. The suspected cause is a double count:
  stage 2's `+130` stands in for trick potential and partner meld while #277's
  `computeTrickPotential` prices trick potential directly. It is deliberately
  left uncalibrated pending #270.
- **#280** — both pass priority lists reworked; the trump tiers now send a
  spread rather than duplicates.
- **#283** — the 400 bid cap removed.

So the bidding underneath every table below is not the bidding this engine does
today, and #277 alone changes which hands open at all.

**The headline +227 is a much smaller number now, and that is not a
regression.** This is the specific error the notice exists to prevent, and the
explanation is written next to the figure itself rather than only here — see
"Why the +227 above reads +22 today". The short form: the static arm the
evaluator was measured against has been fixed repeatedly since, so the gap
closed from the bottom. Nothing about the evaluator got worse.

**Descriptive statistics are superseded too**, and are recorded here only so
they are not later cited as current. Taken 2026-09-02, between #273 and #277:
mean winning bid 304.5, mean ceiling 269.9, 26.8% of hands clearing
`OPENER_THRESHOLD`, mean game length 5.0 hands, 23.8% baseline pass-out rate.
Every one of those was invalidated by #277 the following day. The figures in
#283's commit message are later, but they are descriptive statistics too and
not an A/B.

If you are here holding a fresh measurement, put it on #270. Do not diff it
against a number on this page and call the difference a regression: a published
figure here and a fresh one today are not measuring the same engine, the same
bidder, or the same scoring.

`chooseBid` runs one of two policies, selected by `SKILL_PARAMS.bidPolicy`
(`src/engine/skills.ts`): the hand-tuned thresholds that predate epic #104, or
the evaluator distilled from the Python rollout AI. Issue #115 had to decide
whether the second is worth switching on, which `ab_harness.py` cannot answer
because both sides are TypeScript.

`headlessGame.ts` plays complete games without React, calling the same reducers
and the same AI entry points `GameFlow.tsx` calls, in the same order, with the
delays and the rendering removed. `abRun.ts` pairs them the way `ab_harness.py`
does — identical deals derived from (seed, round) so they cannot drift, seats
mirrored, significance over pairs rather than games, split pairs discarded, and
a bootstrap interval on score margin because games-won alone is too coarse.
`stats.ts` is a direct port of that module's three statistics.

```
node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts selftest --pairs 100
node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts ab --pairs 1000
node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts fold --pairs 1000
node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts play --pairs 1000
node node_modules/jiti/lib/jiti-cli.mjs src/ab/cli.ts latency --positions 4000
```

Run `selftest` before believing any of them: one policy against itself must find
nothing, and here it must find *exactly* nothing — with the same policy in all
four seats the mirrored orientations are the same game relabelled, so every pair
splits and every paired margin is zero. `ab.test.ts` asserts that in the suite,
for every arm of every dial. `--policy` picks which arm doubles up:
`static`/`distilled` are the bidding pair, `simple`/`cascade` the trick-play one.

What it found, over 1000 pairs / 2000 games: distilled swept 211 deals to
static's 50 (739 split), 95% CI 75.6%–85.2% of decisive deals, p < 1e-4, and
+227 score margin per deal with a 95% CI of +198 to +257. The evaluator takes a
third fewer contracts and makes 63.7% of them against static's 54.6% — declining
the `DEFENSIVE_PUSH_FLOOR` raise, which is what the static rule does on almost
any hand, is worth more than the contracts it gives up. Cost: +872 B gzipped,
and a p95 per decision of 72 µs (Node) / 495 µs (Chrome at 375×812), against the
600 ms the auction already waits before each AI bid. `hard` and above now run
`'distilled'`; `easy` and `medium` keep the thresholds. **That +227 is not what
this comparison measures today, and the reason is not a regression in the
evaluator — read the paragraphs immediately below before quoting it.**

Two bounds on that conclusion. The evaluator only governs the opening decision
and the defensive push — the ordinary raise ladder and the 330/340 constants in
`chooseBid` are untouched, and the two policies return a different bid on 6.5%
of real auction positions, which is the ceiling on what the model can be
credited with. And every seat in the harness is an AI, so this says the policy
is stronger, not that it is a better partner for a human.

**Why the +227 above reads +22 today.** #255 first noticed this on 2026-08-30,
reading +18 per deal (CI -3 to +39) where #115 had published +227, and filed it
as unexplained on #227. It is explained now. The same comparison, re-measured on
2026-09-01 with `selftest` clean on both arms — every deal split, paired margin
exactly +0 — comes back an order of magnitude smaller:

| seed | margin per deal | 95% CI |
| --- | --- | --- |
| 1 | **+22** | +2 to +43 |
| 2 | **+45** | +27 to +66 |

**It is not the harness.** #153's `playPolicy` result was re-run in the same
session and reproduced at **+159 per deal** (CI +140 to +178, p < 1e-4) against
its published +121 — same direction, larger. A drifted ruler does not reproduce
one headline result and destroy the other.

**What moved is the static arm, not the evaluator.**

| | #115 | 2026-09-01 |
| --- | --- | --- |
| distilled make-rate | 63.7% | 68.6% / 69.4% |
| **static make-rate** | **54.6%** | **67.5% / 67.2%** |
| contract volume | distilled takes **a third fewer** | 6–7% fewer |

#115's stated mechanism was that the static rule raises on almost any hand via
`DEFENSIVE_PUSH_FLOOR`, and that declining those cheap contracts was worth more
than the contracts given up. Static does not do that any more. #177's
partner-passed floor, #180's reach-not-clear, #206, #200/#257's opening rung,
#255's third-bidder floor and #256's endgame rule between them tightened the
static bidder by roughly thirteen points of make-rate where distilled gained
five. **The evaluator's advantage did not evaporate; the baseline it was beating
was fixed.** A reader who finds +227 without this paragraph will conclude the
model regressed, and that is the wrong conclusion.

(`skills.ts`'s `SHIPPED_PARAMS` docstring still calls this gap unexplained and
open on #227. It is left alone deliberately: it was accurate when written, and
this section is the explanation it was waiting for.)

### What #126 changed about those numbers

The #126 audit found that `chooseBid` opened at 300 unconditionally from the
first seat to speak, a rule the Python reference does not have (see
`bidding.ts`). It applied to both sides of the #115 run, so the comparison was
fair — but it meant neither policy was ever *asked* the opening question in a
real auction, and the +227 above is the two rules judged on the defensive push
and the raise ladder alone.

Re-measured with the opening decision restored, on the same 1000 pairs:
distilled swept 122 deals to static's 88 (790 split), p = 0.02, margin **+62
per deal with a 95% CI of +41 to +82**. Same direction, a third of the size.
Both sides now take fewer and better contracts (distilled 4439 at 70.8% made,
static 5423 at 66.0%), which is what removing a rule that bought a cheap
contract on every deal should do. `hard` and above keep `'distilled'`.

The parity fix itself was A/B'd the same way, with the two ported formulas
`legacy` on one side and `fixed` on the other, over 1000 pairs:

    fixed swept 226, legacy 88 (686 split), p < 1e-4
    margin +176 per deal, 95% CI +147 to +206
    contracts 4998 vs 6080, made 65.1% vs 57.5%, avg bid 328 vs 315

Split by fix, the bidding one carries all of it (+179, CI +150 to +209) and the
`defenderLead` one is a null result (-3, CI -9 to +3, p = 0.85, 972 of 1000
pairs split) — it ships as parity with the reference engine, not as a strength
claim. The `parity` dial those runs needed is not in the tree: it was a
temporary fourth field on `SkillParams` plus a `PARITY_AB_POLICIES` pair, added
for the measurement in the shape `FOLD_AB_POLICIES` already uses and removed
before the fix was committed, since a permanent switch for "play the port bug"
is not a difficulty setting.

### The trick-play dial (`playPolicy`, #153)

Card play was the one phase never measured — #105, #115, #123 and #126 are all
bidding or folding — so every heuristic in `tracker.ts` was there on reasoning
alone. `SkillParams.playPolicy` is the field that fixed that, and epic #152's
remaining children are each a change to it that has to be measured before it
ships.

It has two arms, and both shipped when it was introduced: `'cascade'` is the
ported Proficient strategy (`chooseLeadCard`'s safe-card cascade,
`chooseFollowCard`'s tiers) and `'simple'` was `easy`'s shortcut — lead the
lowest non-trump non-counter, follow with the lowest legal card. (#156 moved
`easy` onto the cascade; `'simple'` is now an A/B arm only, and the section
below says why it is kept.) The field is an extraction of the
`handValuation === 'meld_only'` test that used to gate card play inside
`tracker.ts`, and `SKILL_PARAMS` reproduces that mapping exactly, so introducing
it changed no behaviour. Splitting it off `handValuation` is what makes #156
("one card-play strategy at every level") expressible at all: that flag also
governs *bidding* valuation, so while the two shared it, changing easy's card
play meant changing how easy bids in the same breath.

`PLAY_AB_POLICIES` is the pair `cli.ts play` installs. Over 1000 pairs / 2000
games, cascade swept 158 deals to simple's 37 (805 split), 95% CI 74.9%–85.9%,
p < 1e-4, **+121 score margin per deal, 95% CI +103 to +138** — cascade makes
68.5% of its contracts against simple's 64.5% on the same deals and the same
bids. Re-run at #152's 5000 pairs it reads **+120, CI +112 to +127** (759–159,
4082 split), which is the same number at five times the sample. That is a
reading of the gap the dial spans, not a decision; acting on it was #156's job.

### Feeding partner the lowest counter (#154)

The first change measured through that dial, and the smallest in epic #152.
`chooseFollowCard`'s partner-is-winning tier called `maxByRank` on the King/10 it
was about to donate, so it threw the **10** and kept the King. A, 10 and K are
each worth exactly 10 points (`pinochle_rules.md:140`), so both cards bank the
same score and the only difference is which one is left in hand — and the 10
loses to nothing but an Ace. It is now `minByRank`, in `feedPartner`.

The open question was the Ace. The tier deliberately skips it (`avoid donating a
live Ace unless forced`), but "play your lowest legal point" read literally
orders K → 10 → A, which puts the Ace in when it is the only counter held. So
three arms were run rather than two — identical bidders, identical folders,
differing only in this tier:

| over 5000 pairs / 10 000 games | margin per deal | 95% CI | swept | p |
| --- | --- | --- | --- | --- |
| lowest **excl. A** vs old `maxByRank` | **+3.55** | +2.05 to +5.16 | 28–11 | 0.010 |
| lowest **incl. A** vs old `maxByRank` | +0.41 | −1.73 to +2.54 | 44–38 | 0.58 |
| lowest **excl. A** vs lowest **incl. A** | **+3.55** | +2.02 to +5.09 | 30–16 | 0.054 |

Repeated on a second seed: +3.31 (+1.75 to +4.97), +0.43 (−1.73 to +2.60) and
+3.06 (+1.43 to +4.71). **The exclusion shipped.** The including-A variant is a
null against the *old* behaviour and loses to the exclusion by very nearly the
whole size of the fix — donating the Ace gives back everything spending the King
wins, which is the thing reasoning could not settle. #101 is the precedent for
recording that as a result rather than re-running until it moves.

Two things worth carrying forward. The effect is real but two orders of magnitude
below the dial's own span (#153's +121, #115's +227), because the tier only fires
when partner is winning, the trick is not a forced beat, and two counters are
legal — so at 1000 pairs the same comparison reads +2.67 with a CI of +0.51 to
+4.92 and a sign test of p = 1.0 on two decisive deals. 1000 pairs is the wrong
size for the rest of #152's children; 5000 is. And games-won is useless at this
scale: 4961 of 5000 pairs split even where the margin interval is clean, which is
exactly the null this project has been burned by before and the reason margin is
the headline number.

The three-arm comparison needed a throwaway `'feed-high'` / `'feed-low-ace'` pair
on the `PlayPolicy` union plus a temporary `cli.ts feed` command, added in the
shape the section below describes and deleted before the fix was committed — the
same call #126 and #153 made, since a permanent "feed the wrong card" switch is
not a difficulty setting.

### One card-play strategy at every level (#156)

Trick play is now identical at all five skill levels. `easy` was the one row on
`'simple'`; it is on `'cascade'` with everyone else, and the change is a single
field of `SKILL_PARAMS` — the branches in `tracker.ts` were untouched, because
#153 had already made this a data change rather than a code one.

The reason is about what a player can see, not about strength. Paul: *"humans
get really mad if you play this last part wrong, but bidding they never know
what you have."* A weak bid is invisible — nobody else sees the hand it was made
on — while a weak card is face up on the table, and it does not read as an easy
opponent, it reads as a partner who is broken. So card play joins `foldPolicy`
as shared competence, and a level's strength stays in `bidPolicy`.

What `easy` keeps is `handValuation: 'meld_only'`, so it still values a hand on
meld alone and still bids like `easy`. That separation is the whole point of
#153 splitting the two fields: while one flag carried both, this change was not
expressible without rewriting how easy bids, and the measurement would have had
two causes.

Measured behind *easy's own* bidding rather than through `cli.ts play`, which
runs the two card rules behind `distilled` — both sides the easy row verbatim,
differing in `playPolicy` alone, over 5000 pairs / 10 000 games:

| seed | margin per deal | 95% CI | swept | split | p |
| --- | --- | --- | --- | --- | --- |
| 1 | **+228** | +216 to +241 | 1251–225 | 3524 | < 1e-4 |
| 7 | **+221** | +209 to +233 | 1186–220 | 3594 | < 1e-4 |

Cascade makes 37.0% of its contracts against simple's 32.8% from the same bids
on the same deals (average bid 251 on both sides, folding at the same rate). Both
arms self-tested to *exactly* nothing first — every pair split, paired margin 0.

Roughly twice the +120 the same two rules show behind `distilled` bidding, and
the reason is that `easy` is set on 63% of its contracts where the distilled
bidder is set on 31%. Card play matters most in the rounds a bidder has no
business being in, which is precisely the tier that used to play cards worst. It
is also the largest effect epic #152 has measured, an order of magnitude above
#154's +3.55 — the shortcut was not a difficulty setting, it was bad play.

That leaves `'simple'` referenced by no `SKILL_PARAMS` row and both `tracker.ts`
branches unreachable in a real game. **It is kept anyway**, in
`PLAY_AB_POLICIES` and documented at `PlayPolicy` in `skills.ts`, on the
precedent `FoldPolicy` set with `'never'`: the harness needs two levels
differing in exactly one field, and this is the baseline every remaining child
of #152 is judged against. Deleting it as dead code would leave a one-member
union and take the ruler away days after #153 built it.

### Fixing the forced-beat comparison (#155)

`Trick.legalMoves` forces a seat to beat the best **lead-suit** card on the table
whenever it can, and does not care who played it — so a seat is regularly
compelled to overtake its own partner. `chooseFollowCard`'s first tier is what
decides which card to take with, and until this issue that tier was gated on

    legalMoves.every((c) => c.rankValue > winner.card.rankValue)

`rankValue` is rank-only and suit-blind, and `currentWinner` returns a **trump**
whenever one has been played. So a partner who had ruffed in with the 9 of trump
— the lowest `rankValue` there is — read as beatable by every Queen in hand: the
forced-beat tier fired, and the seat threw its cheapest card into a trick its own
side had already won. The feed-partner tier underneath, which #154 had just
finished tuning, never ran. The condition is now `Card.beats(winner.card, trump)`
— trump over non-trump, rank within the suit.

The blast radius is small and worth stating exactly, because it is what sizes the
result. The fixed reading is strictly weaker than the old one (no card of the
lead suit beats a trump at any rank), so the only positions that change are those
where a trump was winning and the comparison fired anyway. Of *those*, only the
ones where **partner** holds that trump change the card actually played:
pinochle's rank order (9 J Q K 10 A) puts every non-counter strictly below every
counter, so on the opponent side "lowest legal card" and "lowest non-counter,
else lowest counter" are the same card and the tiers agree.

That last point is also why the selection rule this issue specifies —

1. beat with a non-counter (Q, J, 9) if any legal beater is one;
2. else the lowest counter that cannot itself be beaten — **not implemented**,
   it needs #157's outstanding-card memory and is #158's job, left as a gap
   rather than approximated;
3. else the lowest counter

— picks the same card as the `minByRank` it replaces. `chooseForcedBeat` spells
it out anyway, so the preference is a tested property rather than a side effect
of `RANK_VALUE`, and so #158 inserts one branch instead of re-deriving the rule.

Measured with a throwaway `'legacy-beat'` arm on `PlayPolicy` plus a temporary
`cli.ts beat` command, in the shape the section below describes and deleted
before the fix was committed, over 5000 pairs / 10 000 games:

| | margin per deal | 95% CI | swept | p |
| --- | --- | --- | --- | --- |
| seed 1 | **+1.81** | +0.86 to +2.77 | 12–4 | 0.077 |
| seed 2 | **+1.77** | +0.93 to +2.64 | 7–1 | 0.070 |

The margin interval excludes zero on both seeds and the sign test reaches
significance on neither, off sixteen and eight decisive deals in 5000 —
which is precisely the reading #154's methodology note exists to prevent being
mistaken for a null. Half the size of #154, and #154 was already two orders of
magnitude under the dial's own span, because the divergence needs four things at
once: partner ruffs in, this seat still holds the lead suit, `legalMoves` forces
a beat, and the legal set holds both a counter and a non-counter. When it does
fire it is worth a whole counter.

`pinochle_engine.py` carries the identical comparison, in `choose_follow_card`
and again in the expert follow path — this is a faithful port of a reference bug,
not a porting error. Fixing it there is its own issue on the Python side, the way
#164 followed #154.

### The bidder's opening lead, and the trump it does not hold back (#159)

Epic #152's largest proposed change, and the only one that reasons about a
*future* trick: the bidder should assume it holds the most trump and play to win
the last one (`LAST_TRICK_BONUS`, `round.ts`). It bundles two independent ideas,
so both were measured separately — which turned out to matter, because they point
in opposite directions.

**The opening lead.** The bidder must lead trump on trick 1 (rule #82) and leads
its Ace if it has one. Without an Ace it led `maxByRank`, which is the **10** —
ten points handed to whichever opponent holds the Ace, in exchange for drawing
one round of trump. It now leads the highest *non-counter* trump instead,
cascading Q → J → 9: the Queen drags out a King and an Ace while donating
nothing, and can leave the bidder's own 10 as the boss trump. Over 5000 paired
deals / 10 000 games against shipped `cascade`, differing in nothing else:

| seed | margin per deal | 95% CI | swept | make-rate, Q vs 10 |
| --- | --- | --- | --- | --- |
| 1 | **+7.61** | +5.67 to +9.59 | 56–14 | 71.23% vs 70.81% |
| 2 | **+7.66** | +5.53 to +9.82 | 52–17 | 70.89% vs 70.52% |
| 3 | **+9.83** | +7.79 to +11.95 | 67–7 | 71.01% vs 70.49% |

Both metrics move the same way, which is the check #126 exists to force — a
policy that buys margin by missing contracts is not obviously better. Make-rate
is up on all three seeds by about 0.4 points; that gap sits inside the per-seed
Wilson intervals (seed 1: 71.23% [70.65, 71.81] against 70.81% [70.23, 71.38]),
so the claim being made is only that it does not *fall*. Roughly twice #154's
+3.55 and still two orders of magnitude below the dial's own span (#153's +121),
which is the size a single card-play rule comes in at.

**Holding trump back did not ship.** The other half of the plan — after the
opening, lead side suits and keep trump back to ruff a counter-heavy trick — is a
straight loss, on margin and on make-rate together:

| arm, 5000 pairs, seed 1 | margin per deal | 95% CI | swept | make-rate vs cascade |
| --- | --- | --- | --- | --- |
| never lead trump after the opening | **−13.63** | −16.85 to −10.60 | 43–103 | 70.28% vs 70.86% |
| that, plus the Queen opening | −4.88 | −8.56 to −1.31 | 92–109 | 70.72% vs 70.81% |

Roughly additive: the Queen's +7.6 does not cover the hold-back's −13.6.

The reason is that **the AI already holds trump back, and this removes the one
exception worth keeping.** Instrumenting `offenseTrumpLead` over 300 headless
games, it is reached 9651 times on a bidding-side lead: 3444 of those are
all-trump hands with no other legal lead, 421 lead a trump Ace, and the other
5786 lead a side suit while still holding trump. The Ace is the *only* trump the
offense ever chooses to lead — a boss card that takes the trick and draws a round
of trump in the same move — and suppressing it is the whole of the −13.63.

That instrumentation also settled a result that looked like a harness bug. Two
hold-back arms were run, one suppressing every trump Ace and one suppressing only
*secured* Aces, and they returned bit-identical numbers over 10 000 games. They
are the same policy in practice: of those 421 Ace leads, the Ace was still
unsecured on **zero**. Trick 1 is a mandatory trump lead and the beat-if-possible
rule flushes the twin out of the round, so by the time the bidding side is on lead
again its trump Ace is always secured — the `isUnsecuredAce` distinction that
matters so much elsewhere in the cascade cannot arise here at all.

So the epic's last-trick plan splits. The opening lead is a measured win and
ships. "Then alternate and hold trump back" is already what the code does, apart
from an exception worth 13.6 points a deal, and removing that exception loses;
`LAST_TRICK_BONUS` is still never explicitly played for, and the lever for it is
not which trump the offense *leads* but which trump `chooseFollowCard` spends —
follow-side work, and a separate issue.

Both arms ran behind `distilled` bidding and `installPolicies` writes both
`SkillParams` rows explicitly, so these numbers do not depend on where the
shipped dial sits — but note that after #156 every level runs `'cascade'`, so
this opening lead reaches all five, `easy` included.

The table above was measured before #155 and #156 merged, and both of those
change card play, so it was re-run on the merged tree rather than assumed:

| seed | margin per deal | 95% CI | swept | make-rate, Q vs 10 |
| --- | --- | --- | --- | --- |
| 1 | **+7.61** | +5.70 to +9.54 | 56–15 | 71.23% vs 70.81% |
| 2 | **+7.24** | +5.12 to +9.42 | 52–19 | 70.89% vs 70.55% |

Seed 1 is unchanged to two decimals with one deal moving from split to decisive.
That is what a change confined to the opening lead should do against a fix
confined to the follow tiers (#155) and a dial move that does not touch either
(#156) — but it is cheap to check and expensive to assume.

The four throwaway arms (`open_q`, `hold_all`, `hold_ace`, `last_trick`) on the
`PlayPolicy` union, the `LEAD_AB_ARMS` map, the `cli.ts lead` / `leaddump` /
`acetier` commands and the `offenseTrumpLead` counters were added for the
measurement in the shape the section below describes and deleted before the fix
was committed — the same call #126, #153 and #154 made.

### The partner-passed bid floor (#177)

The first measurement in this file that is not about *strength*. Bids move in
tens; `chooseBid`'s partner-passed floor was **321**, written as `320 + 1` to
encode "strictly above `OPENER_THRESHOLD`" by someone thinking in ceiling points
rather than in bids. `OPENER_THRESHOLD` and `DEFENSIVE_PUSH_FLOOR` really are
points — thresholds a hand's valuation is compared against, where 321 is a
perfectly ordinary number — and the floor sits one line away from them but is an
actual bid placed on the table. It became `PARTNER_PASSED_FLOOR = 330`, and
#180 then took it to **320** — see "Reach, not clear" below.

What it cost while it was wrong, over 20 000 headless auctions: **11 553 of
40 200 bids placed — 28.7% — were not multiples of 10**, and 18.3% of deals
settled on a contract of exactly 321. The floor branch is not a corner case; it
fires in about 28% of auctions. And one off-grid bid is not one bad bid, because
it reseeds `currentBid`: from 321 the ladder runs 331, 341, 351, and
`BiddingControls` gates its Bid button on `amount % 10 === 0`, so the panel shows
the human "Minimum: 331" — a number the +/− buttons, which step in tens, cannot
produce. Typing 340 by hand works. Nothing says so.

**Why 330 and not 320** was #179's reading, since both are legal and the code
and its comment disagreed about which was meant. The rule (#93/#95) is that a
seat whose partner has passed is buying the contract alone and must *clear* the
opener threshold, not merely equal it — and `chooseBid` said exactly that one
tier up, in the other direction: it wanted `ceiling > OPENER_THRESHOLD` when the
partner had passed against `ceiling >= OPENER_THRESHOLD` when they had not. 320
would make the floor "at least 320" and leave that strict `>` arbitrary. So 330,
on the rule, not on the arithmetic. #180 overturned that reading; the paragraphs
below are the state at the time, kept because the numbers are still the record.

Measured with a throwaway `partnerPassedFloor` field on `SkillParams` plus a
temporary `cli.ts floor --baseline N` command, added in the shape the section
below describes and deleted before the fix was committed — the same call #126,
#153, #154 and #159 made. 5000 pairs / 10 000 games per row, A = 330:

| vs 321 (the fix) | margin per deal | 95% CI | swept | p |
| --- | --- | --- | --- | --- |
| seed 1 | −2.89 | −5.37 to −0.39 | 37–56 | 0.061 |
| seed 2 | −0.57 | −2.85 to +1.72 | 29–47 | 0.051 |
| seed 3 | −2.27 | −4.85 to +0.28 | 39–61 | 0.035 |
| seed 4 | −2.71 | −5.04 to −0.55 | 31–50 | 0.045 |

Negative on all four seeds, excluding zero on two of them, ~2 points per deal in
a game to 1000. Read it as a small real cost rather than a null: the sign never
flips and the sign test sits at p ≈ 0.05 pointing the same way. The mechanism is
not subtle — 321 is nine points cheaper to commit to than 330, so the old value
took slightly more contracts (23 885 vs 23 352) at the same make rate. **Shipped
anyway.** A bid the human cannot make is not a strategy setting, and two points
per deal is the price of the ladder being legal.

| vs 320 (the other reading) | margin per deal | 95% CI | swept | p |
| --- | --- | --- | --- | --- |
| seed 1 | **−9.82** | −14.85 to −4.98 | 148–170 | 0.239 |
| seed 2 | **−6.76** | −11.35 to −2.12 | 140–171 | 0.089 |
| seed 3 | **−10.68** | −15.56 to −5.94 | 130–193 | 0.0005 |
| seed 4 | **−12.10** | −16.96 to −7.43 | 126–196 | 0.0001 |

That one is not small and it is not ambiguous: four seeds, four intervals
excluding zero, ~10 points per deal — larger than #159's +7.61 and #154's +3.55,
both of which shipped on their numbers. **320 plays better than 330.** It was
left unshipped deliberately, because it is a different question: #177 is a
legality fix, both candidates are legal, and lowering the floor changes what
#93/#95's rule *means* rather than correcting how it is spelled. Deciding that
on a strength number alone would settle a design rule in passing under cover of
a bug fix. It wanted its own issue, and this table is the evidence that opened
it (#180).

Controls, run first as the section below requires: `selftest --policy distilled`
split all 200 pairs with a paired margin of exactly 0, and so did the floor arm
against itself (`floor --baseline 330`), which is the same check for the new
dial. The dial's ability to *see* a change is carried by the 320 rows rather than
by a deliberately-bad arm — four intervals that clean is not what a field which
is written but never read produces.

### Reach, not clear (#180)

Paul's call, 2026-08-02: **a seat whose partner has passed must reach the opener
threshold, not clear it.** So `PARTNER_PASSED_FLOOR` is 320, and the `>` / `>=`
asymmetry one tier up is gone — `chooseBid`'s static verdict now asks
`ceiling >= OPENER_THRESHOLD` in both branches, because the only thing that
asymmetry ever encoded was the "clear" intent that has now been retired.

That second half is a **behaviour change the ~10-per-deal table above did not
measure.** It lets a hand whose ceiling is exactly 320 open where it previously
declined, and ceilings move in tens, so it is a whole rung of hands rather than a
rounding edge. And `main` had moved: #178's auto-SET ends ~7% of contracts before
the first lead and #158 shipped, both of which change which deals reach trick
play. Everything below is a re-baseline, not a comparison against the older rows.

**The two halves live on opposite sides of the `bidPolicy` gate**, which is the
first thing this measurement found and the thing a reviewer should check by eye:

- The **floor** is read unconditionally, so it moves every level whose bidding
  reaches `chooseBid`'s Base Bid path — `medium` through `expert`. (`easy` short-
  circuits into `meldOnlyBid` and never sees it.)
- The **ceiling comparison** is only ever passed to `worthContract` as its
  `staticVerdict`, and a `'distilled'` level discards that argument. So the
  collapse is *inert* on `hard`, `proficient` and `expert`, and only `medium`
  ("Apprentice") plays differently for it.

So the three arms were run under both policies. Side A is current `main`
(330 + `>`); 5000 paired deals / 10 000 games per row.

**`'distilled'` — `hard`, `proficient`, `expert`, and the default seats:**

| seed | (a) vs constant-only 320 | (b) vs the full change | (c) constant-only vs full |
| --- | --- | --- | --- |
| 1 | **−9.95** (−14.91 to −5.13) | **−9.95** (−14.91 to −5.13) | 0.00 (0.00 to 0.00) |
| 2 | **−8.08** (−12.63 to −3.30) | **−8.08** (−12.63 to −3.30) | 0.00 (0.00 to 0.00) |
| 3 | **−11.05** (−15.90 to −6.17) | **−11.05** (−15.90 to −6.17) | 0.00 (0.00 to 0.00) |

(a) and (b) are not merely close, they are bit-identical, and (c) is exactly zero
with every pair split and identical contract counts on both sides. That is the
prediction from reading `worthContract` — confirmed as a number rather than
asserted. All three (a)/(b) intervals exclude zero and land on the ~10 the old
four-seed table gave, so the constant survived re-baselining onto #178/#158.

**`'static'` — `medium`, the only level the collapse can reach:**

| seed | (a) vs constant-only 320 | (b) vs the full change | (c) constant-only vs full |
| --- | --- | --- | --- |
| 1 | **−25.90** (−31.22 to −20.77) | **−30.63** (−36.70 to −24.94) | **−3.57** (−6.14 to −0.97) |
| 2 | **−26.63** (−31.82 to −21.49) | **−32.22** (−37.89 to −26.49) | **−5.21** (−7.93 to −2.60) |
| 3 | **−28.39** (−33.55 to −23.28) | **−31.99** (−37.62 to −26.39) | **−3.93** (−6.39 to −1.53) |

**The collapse does not fight the constant; it adds to it.** (b) is larger than
(a) on every seed, and (c) — the two changes head to head, which is the only row
that isolates the comparison — excludes zero on all three, worth another 3.6 to
5.2 points a deal in the same direction. Column (c) is reported rather than
averaged into (b) precisely because the reverse result would have been the
interesting one.

Why `'static'` moves three times as far as `'distilled'`: the threshold rule is
a blunter instrument, so it is more exposed to where the threshold sits.
Make-rate moves with margin on every row (68.4% → 70.7% on static seed 1,
70.5% → 71.4% on distilled seed 1), which is the check #126 exists to force —
the cheaper floor is buying contracts it makes, not contracts it is set on.

Controls, run first: the arm against itself split every pair at a paired margin
of exactly **0.00** under both policies, with identical contract counts. That
control is also what caught the one real trap in this rig. A bidding A/B has to
carry its two arms on two skill levels, and #157 keys `TRUMP_MEMORY_CAPACITY` on
the *level* rather than on `SkillParams` — `hard` remembers 6 trump, `expert` 10
— so the first self-test came back one decisive pair and −1 per deal instead of
0.00. #158 measured that same gap at ~6 points a deal. The rig pins both arms to
one capacity for the run; without that, every number above would have had a
trick-play difference folded into it.

The throwaway rig was a `PartnerPassedRule` field on `SkillParams` naming the
*whole* rule (`clear` / `floor-only` / `reach`) rather than #179's floor number,
a `bidFloorAbPolicies` factory, a capacity equaliser and a `cli.ts floor --a X
--b Y --policy P` command — all deleted before committing, the same call #126,
#153, #154 and #159 made. Naming the rule rather than the number is what makes
column (c) exist at all: an arm carrying only the constant cannot measure the
comparison, and would have shipped the collapse unmeasured.

### The bid that only a human can see is wrong (#206)

The dial has a blind spot, and this is the case that found it. Everything in
`src/ab/` plays AI against AI. A rule that is only wrong when a *human* sits at
the table is one the harness cannot fail on, however many deals it runs.

`chooseBid`'s partner-raise branch demanded `ceiling >= 340` and then bid
`currentBid + minIncrement`. In an all-AI auction that is not observably broken:
the competitive branch's `Math.max(ceiling, 330)` walks the ladder to 330, so
`+ minIncrement` lands on 340 by arithmetic accident. Over 4000 AI-vs-AI
auctions on `hard`, 123 deals place a bid over one's own partner and **all 123
are exactly 340** — min, median and max identical. There is no distribution to
look at and nothing to flag.

A human's bid is not on that ladder. Paul, playing the deployed PWA, bid 260 as
the partner of an AI holding a 360 ceiling and was raised to 270 — the AI
bidding against its own team for ten points, having just certified the hand as
worth a 340 contract. That is the whole defect, and only the human seat can
produce it.

**What this costs the measurement programme is worth stating plainly.** Three
separate bidding constants have now been wrong in the same way — #177's
`320 + 1`, #180's clear-versus-reach, and this — and none of the three were
caught by an A/B. They were caught by reading the code, and this one by playing
the game. The harness measures which of two rules wins; it does not measure
whether a rule does what its own constant says. Those are different questions and
only the first has a tool.

The fix is `PARTNER_RAISE_FLOOR`, the same shape as `PARTNER_PASSED_FLOOR`: the
ceiling gate decides *whether* to raise, the floor decides *what* to raise to,
and both are 340. Passing stays available, so the change alters what a raise says
rather than how often one happens.

Verification, in place of an A/B that would have measured nothing: a seeded
4000-deal auction sweep on each of `easy`/`medium`/`hard` — 12,000 auctions —
produces a **bit-identical fingerprint** of every settled contract and winner
before and after. The change provably reaches only auctions with a human in a
seat, which is exactly the population the harness cannot reach.

`easy` is deliberately outside all of this. `meldOnlyBid` has no partner tracking
of any kind, so it never enters the branch and answers the plain next rung;
`bidding.test.ts` excludes it from the property with that reason attached, so the
exclusion does not later read as an oversight.

The other half of Paul's report — that a seat should not pass and let the
opponents buy it cheap after both partners have bid — needed no change and is
recorded so it does not get re-fixed. `Math.max(ceiling, 330)` already makes a
seat whose partner has bid push the opponents to 330 on any hand at all; probed
with a ceiling-190 hand, it answers 270/290/310/330 and only passes at 330.

### "Cannot be beaten", and the first place skill decides a card (#158)

The last child of epic #152, and the one that makes #157's trump memory do
something. #155 wrote the forced-beat rule as three tiers and could only build
two of them:

1. beat with a non-counter (Q, J, 9) if one is legal — take the trick for free;
2. else the lowest counter that **cannot itself be beaten**;
3. else the lowest counter.

Tier 2 needs to know what is still outstanding, so it was left as a documented
gap. It is now `isBoss` in `tracker.ts`, and the same predicate answers the
leading half of the rule that was already there under the name `isSafe`: a
counter that is provably boss is safe to lead, one that is not is not.

**"Cannot be beaten" can only ever mean cannot be beaten *in suit*.** Whether an
opponent is void and holds a trump is unknowable — `PlayTracker` records what was
played, not who is out of what — and no amount of counting fixes it. So the claim
is never "this wins the trick", it is "nobody takes it with a bigger card of this
suit", which is the loss the rule exists to avoid: spending a King into a trick an
opponent's Ace then takes gives away 20 points rather than 10.

Where the information comes from is the one thing a level name still
decides — how much trump a seat can remember:

- **Side suits** are exact at every level. #157 scoped its cap to trump, so
  `PlayTracker` still counts perfectly and an `easy` seat answers a side-suit
  question exactly as an `expert` does.
- **Trump** comes from that seat's `TrumpMemory`, capacity `2 × skill level`.

Unknowns resolve conservatively **by construction rather than by a branch**.
`TrumpMemory.seenCount` can only ever *under*-report — forgetting removes
sightings and never invents them — and an under-report makes `isBoss` answer
"beatable". A seat that cannot remember therefore plays as though the card can be
beaten, which is what #158 asks for, and there is no code path where an unknown
becomes an assumed best case. `newTrumpMemories` protects the same invariant from
the other end: a seat is seeded with the *other three* seats' meld and never its
own, because `isBoss` counts the hand separately and a seat fed its own melded
King would count one physical card twice and manufacture certainty.

Two positions changed, and two deliberately did not:

- **Forced to beat in a side suit.** With only counters legal, the cheapest one
  that will still be standing goes in. When nobody is left to play the tier
  collapses to the cheapest counter, because nothing is outstanding — a property
  of the position, not of the counting, so the fourth seat cannot be made worse.
- **Forced to overtrump.** A trump is already winning and `Trick.legalMoves` has
  restricted the seat to beaters (rule 3 when trump was led, rule 5 over a ruff).
  The trump branch had no notion of a forced beat at all and answered this with
  "surrender the lowest point trump". The issue's own worked example — both trump
  Aces gone makes the 10 boss, then the Kings after the 10s — is a *trump*
  example, so tier 2 could not be built as specified without one.
- **A plain ruff is left alone.** Void in the lead suit with no trump yet on the
  table, every trump in hand "beats" the winner but the rules restricted nothing.
  That position keeps its existing tiers.
- **`trumpSecure` still reads the exact count.** "Is every trump accounted for"
  is a different question from "can this card be beaten", and #157 recorded the
  exact `PlayTracker` as load-bearing for the parity fixtures. Degrading it is
  its own issue with its own measurement.

**The measurement.** `cli.ts safe --level L` puts the counted rule at level `L`
against an `'off'` baseline. The baseline never constructs a `TrumpMemory`, so it
is the *same opponent at every level* — which is what makes two runs at different
capacities comparable to each other and not just to zero. Self-tests first: both
arms found exactly nothing against themselves (200 pairs, every pair split, paired
margin 0.00), and the two arms were confirmed to return different cards from one
fixed position before any number was believed (`A♥` against `K♥`, pinned in
`tracker.test.ts`).

**Measured against auto-SET (#178), which landed while this was in review.**
That rule ends a mathematically dead contract before the first lead, and it fires
on **6.8–6.9% of contracts** — roughly one in fourteen — so it changes which
deals reach trick play at all, and every number below was re-run on top of it
rather than carried over. #177's bid-floor fix (321 → 330) is in the same
re-run. Both arms of every row carry `autoSetPolicy: 'forced'`, and the harness
reports the same auto-SET rate on each side, which is the check that the two
arms are being dealt the same population.

Two recall settings were run against auto-SET, and that is where the claim
rests. `easy` and `expert` here are `ab/` slots and not tiers (#222):
`TRUMP_MEMORY_CAPACITY` is keyed on the level rather than on `SkillParams`
(#157), so seating one unchanged rule on two levels is how the recall behind it
is varied. Both rows are `'counted'` against the same `'off'` baseline, 5000
paired deals / 10 000 games per cell:

| level | trump remembered | seed 1 margin (95% CI) | seed 2 margin (95% CI) |
| --- | --- | --- | --- |
| easy | 2 of 12 | **+3.71** (+0.46 to +6.90) | **+4.07** (+0.96 to +7.26) |
| expert | 10 of 12 | **+8.93** (+5.86 to +11.90) | **+7.93** (+5.06 to +10.83) |

Both intervals exclude zero, and the effect is if anything slightly *larger*
under auto-SET than it was without it — the same two cells on the pre-#178
baseline read +3.29 and +8.69 on seed 1. That direction makes sense: the
contracts auto-SET removes are ones the bidding side could not have made however
it played, so they were dead weight in the average rather than deals the rule was
winning.

Make-rate moves with margin rather than against it on every post-rebase cell
(expert, seed 1: 71.54% against the baseline's 71.26%), which is the check #126
exists to force.

Size in context: roughly the same as #159's opening lead (+7.6 to +9.8), four to
five times #155's forced-beat fix (+1.8), and still two orders of magnitude under
the dial's own span (#153's +121). Cost on the bundle is +1.58 kB raw / +0.55 kB
gzipped (259.05 kB to 260.63 kB, measured against the tree this branch
rebased onto).

Shipped **enabled**, and never as a difficulty notch: the rule is identical
wherever it runs — #156's settlement that trick play is shared competence
stands — and only the recall behind it differs, which is exactly #157's model.
Since #222 every seat is `SHIPPED_SKILL`, so in a real game that recall is 10 of
12 for all four players. `'off'` survives as the A/B arm, like `'simple'` and
`'never'`.

`pinochle_engine.py` has no trump-memory model at all, so this is not a ported
behaviour that has drifted; porting it is its own issue on the Python side, the
way #164 followed #154.

Unlike the throwaway arms #153–#159 built and deleted, `safe` and `capacity`
stay in `cli.ts`. `capacity` seats one unchanged rule on two levels, so what it
measures is recall itself. The head-to-head it was built for asked whether the
skill dial was worth having; #215 answered that by removing the dial and #222
carried it out, so **that result is deleted from this file (#269)** rather than
left to read as a live comparison between tiers that no longer exist. The
command is not deleted, and should not be: `TRUMP_MEMORY_CAPACITY` is still a
real parameter, and this is still the only way to put a number on what it buys.

### Checking that a dial can see a change

A self-test proves a dial reports nothing when nothing differs. It does not
prove the dial can see anything, and those fail differently: a policy field that
is written but never read passes `selftest` perfectly and then returns a null
result for every change ever made through it. So before trusting a new dial,
point it at a policy that is known to be bad and confirm the harness says so.

The procedure, which is deliberately not in the tree — #126 established it with
the temporary `parity` dial it removed before committing, on the grounds that a
permanent "play badly" switch is not a difficulty setting:

1. Add a throwaway arm to the policy union in `skills.ts` — for trick play,
   `'highest'`.
2. Give it a one-line implementation at the top of the branch it is testing. For
   #153 that was `return maxByRank(hand)` in `chooseLeadCard` and
   `return maxByRank(legalMoves)` in `chooseFollowCard`: always play the highest
   card available, which dumps counters into opponents' tricks and strips your
   own trump control.
3. Copy the real policy map, change that one field on side B, and add a
   temporary `cli.ts` command that runs it.
4. Run it at the size a real measurement uses, then delete all four edits.

What #153 got, 1000 pairs / 2000 games: cascade swept 224 deals to highest's 11
(765 split), 95% CI 91.8%–97.4% of the 235 decisive deals, p < 1e-4, **+202
score margin per deal, 95% CI +184 to +220**. Highest is set on 32.4% of its
contracts against cascade's 24.9% from the same bids on the same deals. A dial
that can separate those by 202 points and separate a policy from itself by
exactly 0 is one a null result from can be believed.

### What the opener puts on the table (`openingPolicy`, #204)

Paul, playing the deployed PWA, reported that too many hands settle under 300
when almost all of them should land between 320 and 350. Measured over 4000
AI-vs-AI auctions on `hard`, he was right and the distribution is stranger than
the complaint: **41.1% settle at 250 and 51.7% at 320–350, with 0% anywhere in
between.** Nothing in this engine ever settles at 260–310, because
`PARTNER_PASSED_FLOOR` and the `Math.max(ceiling, 330)` in `chooseBid`'s
competitive branch mean that once a raise ladder starts at all it clears 320. So
"under 300" is exactly and only "the contract was never contested".

Two causes, and only one of them is about aggression. 13.6% of deals are passed
out and the dealer eats `FORCED_BID`. The other 27.4% are the one worth naming:
**the opener never puts a number above the opening rung on the table.**
`chooseBid` asks two separable questions — *should* I open, and *at what level* —
and has only ever acted on the first, answering the second with `OPENING_BID`.
A seat holding a 400-ceiling hand opens at 250 and, if the other three pass, buys
the contract for 250. On those deals the winner's ceiling ran median 310, p75
370, and 44.5% of them were worth 320 or more.

`openingPolicy: 'walk'` is the fix, and it does not survive measurement.

**The arm was deleted by #221 and this section is what is left of it.** It
shipped wired-live and flag-off from #204, was never selected by a shipped
`SKILL_PARAMS` row, and met all four of #215's retirement conditions — three
seeds recorded, decisively negative, nothing selecting it, nothing baselined
against it. Gone with it: `WALK_CONFIDENCE`, `openingLevelFor`, `shouldBid`'s
confidence-threshold parameter, `OPENING_AB_POLICIES`, and the `opening` and
`--policy walk` CLI commands, so the runs below are no longer reproducible from
this tree — they are reproducible from `8048d4b..`, the commit range #204
landed in. `OpeningPolicy` is now a one-member type. The numbers stay because
retiring the code is not retracting the result: a reader who wonders whether
this engine has ever tried naming a higher opening level should find the answer
here rather than an absence.

The dial is deliberately narrow. It is consulted only after `worthContract` has
already returned true, so both arms open on an identical set of deals and pass on
an identical set — `bidding.test.ts` asserts that directly. The only thing that
differs is the price, which is what makes the result readable: a loss here means
naming a higher number buys contracts that get set, and cannot be confounded
with a change in how often the AI bids at all.

`opening`, 5000 pairs x 3 seeds, both arms `distilled`/`model`/`cascade`:

| seed | walk swept | fixed swept | split | margin/deal | 95% CI |
|---|---|---|---|---|---|
| 1 | 265 | 484 | 4251 | **-52** | -59 to -44 |
| 2 | 264 | 509 | 4227 | **-56** | -65 to -48 |
| 3 | 277 | 512 | 4211 | **-53** | -61 to -46 |

These numbers were taken before #206 merged and were re-run against it, the way
#158's table was re-run against #178. They did not move by a single point — same
-52, same -59 to -44 interval, same 265/484/4251 sweep — which is the full-game
confirmation of what #206's auction fingerprint already showed: a rule that only
fires with a human in a seat is inert in a harness that has none.

p < 1e-4 on every seed. The mechanism is in the summary rows: walk lifts the
average bid from 301 to 322 and its made rate falls from 73.2% to 69.2%, with
auto-SET hands rising from 7.1% to 9.9%. It is buying the distribution with
sets, at a bad exchange rate.

`WALK_CONFIDENCE` buys the loss back and cannot buy enough of it. A greedy walk
stops at the highest rung the model still tolerates, which is by construction the
marginal one — probability barely past a coin flip — so it lands on the worst
contract it is willing to hold, every deal. Requiring more confidence per rung
helps monotonically: -48 at 0.60, -43 at 0.70, -26 at 0.80, and -7 (CI -14 to
+0) at 0.90. But the only setting whose interval touches zero lifts the average
bid by 8 points, to 309, which is not the distribution the change was asked for.
Roughly three points of score margin per point of bid lift, the whole way down.
There is no free rung. The model was fitted to measured rollouts and it is right
that the cheap contract is a good price.

**The number that answers Paul's actual question is not in the A/B table.** A
paired A/B asks whether walk *beats* fixed, but in a real game every AI seat runs
the same policy, so the head-to-head penalty is not what a player experiences.
Running each arm against itself (`selftest`, 2000 pairs) gives the house feel
instead:

| all-`fixed` table | all-`walk` table |
|---|---|
| avg bid 301, set 26.3% | avg bid 322, set 30.5% |

That is the honest price of the distribution Paul asked for: symmetric, nobody
disadvantaged, contracts going down about one extra time in every 24. Whether
that is worse *play* or just a livelier game is a house-rules question and not a
measurement one — which is why #204 stayed `ready-for-human` and why the dial
shipped wired-live and flag-off (#101) rather than being argued either way. It
was never switched on, and #215 answered the house-rules question by retiring
the arm rather than by leaving it disabled indefinitely.

`bench/index.html` is the browser side of the latency measurement, served by
`npm run dev` at `/bench/` (it follows `base`, which is `/`). It is never an
input to `vite build`, so it cannot reach a player or the PWA precache.

## Claiming the rest (#208)

Paul's rule: if one seat holds all the trump and nobody else has any, stop
playing and give them the tricks. The idea is right and the wording is not, and
the gap between them is the interesting part of the change.

Trump can only be beaten by trump — so if no one else holds any, the claimer's
*trump* is unbeatable. That argument says nothing about the rest of their hand.
A seat holding every remaining trump plus two low hearts wins the trump tricks
and then has to lead a heart into three players who can beat it. Measured over
3000 played hands with the real AI:

| reading | fires on | correct |
|---|---|---|
| holds all remaining trump (the literal wording) | 59.4% | **no** — in 906 of the 1624 hands where it alone applies, the claiming team went on to lose a trick |
| hand is *nothing but* trump, nobody else has any | 7.8% | yes |
| **on lead, no card can be beaten** | 22.8% | yes — 0 misawards in 3000 hands |

The third is what shipped, on Paul's call. It is the same idea generalised past
trump: a card is unbeatable if it is trump and no one else holds trump, or if no
one holds a higher card of its suit — equal ranks included, since ties go to the
card led and the claimer is on lead. That covers the trump case, covers the
ordinary "I have the last two Aces and you have no trump" case, and triples the
coverage of the safe trump-only reading without giving up the guarantee.

**Being on lead is load-bearing, not incidental.** It is what lets the claimer
choose the suit every trick, so none of its cards ever meets anything above it. A
seat that is not on lead can be pulled into a suit it is void in with no trump to
answer, and loses the trick it was about to claim. Same reason the partner
holding trump kills the claim: the partner must overtrump if able, wins the
trick, and is then on lead holding beatable cards.

### Where it lives, and why not in the engine loop

`findClaim` is in `round.ts` next to `isAutoSet`, but `playTrickTakingPhase`
does **not** call it — and that is the part worth remembering.

That function is the parity-checked port of Python's trick loop.
`engineParity.test.ts` replays recorded Python rounds through it and asserts the
winner and points of every individual trick, and `pinochle_engine.py` has no
claim rule. Applying a TS-only shortcut inside it would make the parity
guarantee conditional on the shortcut never firing in a fixture — true today,
silently false the day someone adds a scenario. So the claim lives in
`trickPlayReducer`, which drives the interactive game, and the frozen loop stays
a faithful port.

It was briefly wired into `playTrickTakingPhase` during development, which is
how this was found: `round.test.ts`'s "the winner of each trick leads the next"
started failing about one run in six, because the loop stopped producing twelve
tricks.

### The property it rests on

The claim is safe only because it changes nothing. `round.test.ts` pins that
directly rather than by argument: 1500 dealt hands played out in full with the
real AI, and every time `findClaim` fires, the claiming seat must actually win
every remaining trick and the awarded points must equal the points collected. It
fires on ~340 of those hands and skips ~800 tricks, so the assertion is not
passing vacuously — the test asserts that too.

The same conservation shows up end-to-end: `TrickPlayFlow.test.tsx` plays a full
round through the component, hits a real claim, and still finds twelve trick
winners and 250 total points.

### The notice

`ClaimNotice` follows `AutoSetNotice` exactly, for the same reason it exists:
the rule alone would skip several tricks and jump to the round summary, and an
unexplained jump reads as the game losing cards rather than as a rule. So the
round does not hand off until it is acknowledged, and an unacknowledged claim
also blocks the #54 checkpoint — resuming from one would land on a summary for
tricks the player never saw.

The claimer's hand is shown face up, an AI's included. The message asserts that
none of those cards can be beaten, and the player is entitled to check it rather
than take it on trust; there is nothing left to conceal by then anyway.

## Portrait fit (#161)

The game has to fit a phone in portrait with no scrolling, and that is a
measurement rather than a look. `layout/index.html` + `src/layout/layoutProbe.tsx`
is the harness, served by `npm run dev` at `/layout/` on the same dev-only terms
as `bench/` above — not a `vite build` input, so it cannot reach a player.

`/layout/` loads every phase (auction, pass, meld, trick play, round summary,
game over) at every target viewport in an exactly-sized iframe and prints
`scrollHeight - innerHeight` and `scrollWidth - innerWidth` for each.
Non-positive is a pass. `/layout/?frame=1&phase=meld` renders one phase alone,
which is also the quickest way to look at a phase without playing to it.

Three things about it are load-bearing:

- **An iframe, not a resized window.** A desktop browser cannot produce a 390px
  viewport by resizing — that is what a phone's device pixel ratio hides. The
  iframe gives its document exactly the width it is handed. Frame mode also
  hides scrollbars, since desktop scrollbars take ~15px of layout width and a
  phone's overlay scrollbars take none.
- **`?insets=1`.** `env(safe-area-inset-*)` is always 0 in a browser tab, so the
  under-the-notch case an installed instance actually gets is invisible by
  default. That flag overrides the `--safe-*` variables in `index.css` with an
  iPhone-14-Pro-class portrait inset set, which is the real height budget.
- **The panel columns.** Overlays are `position: fixed` and so contribute
  nothing to document overflow — a modal taller than the screen would be
  clipped and unreachable while still measuring 0. The probe reports the
  overlay panel's own rect against the viewport for that reason.

Targets: 390x844 (the reported device), 360x640 (small Android), 430x932 (Pro
Max), each with and without insets. Landscape is not a target — the manifest is
`orientation: portrait` — but it stays usable, scrolling ~20-95px at 844x390.

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
- **There is no automatic deploy pipeline.** The app was served from GitHub
  Pages from 2026-07-31 until 2026-08-01, when that was removed by decision
  — GitHub is source control only and `.github/` no longer exists. It now
  lives on Netlify at <https://pinochle-house-rulez.netlify.app>, deployed
  manually. **A merged PR is not live.** To check what is actually deployed,
  ask the deploy which commit it was built from:

  ```
  curl -s https://pinochle-house-rulez.netlify.app/version.json
  ```
- **`version.json` is the build stamp (#237).** `vite.config.ts` emits it on
  every `vite build` with `{ commit, dirty, builtAt }` — short SHA from `git
  rev-parse`, whether the working tree had uncommitted changes, and an ISO
  timestamp. Outside a git checkout the commit falls back to `"unknown"` and
  `dirty` to `null` rather than the build failing, and `null` is used instead
  of `false` because a build that cannot see a repository cannot honestly
  claim the tree was clean. Two things keep it from going stale, and both
  matter: `netlify.toml` serves it `max-age=0, must-revalidate`, and Workbox's
  `globIgnores` keeps it out of the precache — precached, it would report
  whichever build the device last installed. It is not rendered anywhere; the
  reader is a person or an agent, not a player. There is no stamp under `npm
  run dev`, which serves no `dist`; `npm run preview` has one.
- **Deploying to Netlify (manual).** `netlify.toml` at the repo root sets
  `publish = "web/dist"` and nothing else build-related. The repo is
  deliberately **not** connected to Netlify's git integration — a
  push-triggered build would recreate the coupling that removing GitHub
  Pages took out. Netlify never builds this repo; you build locally and
  upload the result:

  ```
  cd web && npm ci && npm run build
  cd .. && npx netlify deploy --prod     # uploads web/dist as-is
  ```

  Run the deploy from the **repo root** — `publish` resolves relative to
  `netlify.toml`, so running it from `web/` looks for `web/web/dist`. For the
  same reason there is no `command` and no `NODE_VERSION` in that file: they
  would be dead config implying a build that never happens. Node 24 locally.
- **No SPA fallback redirect, on purpose.** `netlify.toml` sets no redirects.
  The usual `/* /index.html 200` rule exists for client-side routers, and
  this app has none — nothing imports `react-router`, nothing calls
  `pushState`. Every real URL is a file in `dist/`, so the rule would only
  turn genuine 404s into a 200 serving the app shell. Add it when a router
  lands, not before.
- `base` in `vite.config.ts` is `/`. If the build is ever served under a
  subpath (a project page at `example.com/pinochle/`, say), set `base` to
  that subpath or the built asset URLs will not resolve. This is the single
  most common way a working build serves a blank page. **The manifest's
  `id` / `start_url` / `scope` have to move with it** — they were left at
  the old GitHub Pages `/pinochle/` path after `base` went back to `/`, which
  meant an installed app launched into a 404 and the page at `/` fell outside
  its own manifest scope. Fixed in #143; the failure is invisible in a
  browser tab and only shows up once the app is installed.
- **Security headers** are set in `netlify.toml` for `/*`: a strict
  allowlist CSP (the bundle has no backend, no outbound requests, no forms,
  no third-party scripts and no `eval`, so `'unsafe-inline'` is not needed
  anywhere), plus `X-Content-Type-Options`, `Referrer-Policy`, and a
  `Permissions-Policy` denying device APIs the game never uses. Hashed
  `/assets/*` are cached immutably; `sw.js` is explicitly
  `max-age=0, must-revalidate`, since a stale service worker would pin a
  device to an old build.
- Whoever maintains the host should know: a static host that cannot set
  COOP/COEP response headers rules out `SharedArrayBuffer`, and therefore
  rules out multi-threaded WebAssembly. Single-threaded Wasm is unaffected.
  GitHub Pages could not set headers — **Netlify can**, via the `[[headers]]`
  block already in `netlify.toml`. They are deliberately left off: nothing
  uses either today, and COEP breaks cross-origin subresources for no gain.
  Turn them on only if browser-side rollouts are attempted for skills 4–5.
- To check the production build locally: `npm run build && npm run preview`,
  then open the printed local URL. Note that `preview` does **not** apply
  `netlify.toml`'s headers — it serves the files without them, so a CSP
  problem will not reproduce there.

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
  Alongside them: `skills.ts` (`SKILL_PARAMS`, the five-level difficulty
  dial), the shipped AI (`evaluator.ts`), and two generated fixture pairs that
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
  `src/` outside the App's import graph reaches the bundle. See below.

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

## Measuring the AI (`src/ab/`)

`chooseBid` runs one of two policies per skill level (`SKILL_PARAMS.bidPolicy`
in `src/engine/skills.ts`): the hand-tuned thresholds that predate epic #104, or
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
`'distilled'`; `easy` and `medium` keep the thresholds.

Two bounds on that conclusion. The evaluator only governs the opening decision
and the defensive push — the ordinary raise ladder and the 330/340 constants in
`chooseBid` are untouched, and the two policies return a different bid on 6.5%
of real auction positions, which is the ceiling on what the model can be
credited with. And every seat in the harness is an AI, so this says the policy
is stronger, not that it is a better partner for a human.

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

`bench/index.html` is the browser side of the latency measurement, served by
`npm run dev` at `/bench/` (it follows `base`, which is `/`). It is never an
input to `vite build`, so it cannot reach a player or the PWA precache.

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
  compare the asset hash in the served `index.html` against a local build:

  ```
  curl -s https://pinochle-house-rulez.netlify.app/ | grep -o 'src="/assets/[^"]*"'
  grep -o 'src="/assets/[^"]*"' dist/index.html
  ```
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

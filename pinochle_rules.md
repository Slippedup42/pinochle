# Partnership Pinochle — Rules Reference

This is the finalized rule set backing `pinochle_engine.py`. It corrects a
few errors found in the original spec and reflects the house-rule changes
made in this project (3-card pass, 1000/-1000 game thresholds).

## Players & Teams

- 4 players, fixed partnerships sitting across from each other.
- Player 0 & Player 2 = Team A. Player 1 & Player 3 = Team B.
- Seating order is clockwise; dealer rotates clockwise each round.

## The Deck

- 48 cards: two identical copies of **A, 10, K, Q, J, 9** in each of the
  4 suits (Spades, Diamonds, Clubs, Hearts).
- Each player is dealt 12 cards.

## Card Rank (highest to lowest)

```
Ace → 10 → King → Queen → Jack → 9
```

Note the 10 outranks the King — this is the one place Pinochle diverges
from standard card-game rank order.

## Misdeal / Reshuffle (House Rule)

- House rule, not part of the original historical ruleset — added for
  this project.
- After the deal, any player holding **5 or more nines** may request a
  reshuffle, checked at that player's own first bid turn (before they'd
  otherwise act in the auction).
- AI players always take the reshuffle when eligible: a hand that heavy
  in the lowest-value rank statistically plays like ~5 losing tricks
  with little meld, and a fresh deal is almost always better
  statistically. Human players are asked and may decline.
- Taking the reshuffle means a full redeal; the misdeal check restarts
  from scratch afterward (a new deal could hand 5+ nines to someone
  else, or the same player again).
- Applies uniformly across every game mode (human and AI-only alike) —
  it's a rule of the deal itself, not a UI-only convenience.

## Phase 1: Bidding

- Opening bid: **300**. Minimum raise: **10**, and every bid falls on the
  multiple-of-10 grid that raise implies — 300, 310, 320, never 305.
- Starting with the player left of the dealer, bidding rotates clockwise.
- On your turn: bid `current_bid + 10` (or more), or pass.
- Once you pass, you're out of the rotation for the rest of the auction.
- Bidding ends when 3 players have passed. The 4th is the **ContractWinner**.
- Edge case: if all 4 players pass without ever bidding, the dealer is
  forced to take the contract at a **forced bid of 250** — 50 below the
  opening rung. The discount is the point: the dealer never chose this
  contract, so they carry it more cheaply than anyone who chose to bid for
  one. (#200 briefly moved the opening bid down to 250, which flattened the
  discount to nothing; #257 put the opener back to 300 to restore it.)

## Phase 2: Trump & Passing

1. The ContractWinner declares the **TrumpSuit**.
2. The ContractWinner's partner passes **3 cards** to the ContractWinner.
3. The ContractWinner adds those to their hand, then passes **3 cards**
   back to their partner.
4. There is **no restriction** on which cards can be passed back — the
   ContractWinner may return any of their cards, including ones they
   just received. (An earlier draft of these rules incorrectly forbade
   this; it does not exist in standard Pinochle.)

## Phase 3: Melding

Meld is **not a player decision** — it's a pure scan of each hand once
trump is set. A card may count toward multiple *different* meld types
at once (e.g. a trump King is part of both a Run and a Royal Marriage),
but a single physical card can't be reused twice *within* the same
meld type — a second instance of a meld needs a second copy of the card.

### Class A — Trump & Marriage Melds

| Meld | Requirement | Points |
|---|---|---|
| Run | A, 10, K, Q, J of TrumpSuit | 150 |
| Double Run | Both copies of A, 10, K, Q, J of TrumpSuit | 1500 |
| Royal Marriage | K + Q of TrumpSuit | 40 |
| Common Marriage | K + Q of a non-trump suit | 20 |
| Dix | 9 of TrumpSuit | 10 |

Double Run **replaces** the single Run — it is not 2 × 150 = 300. If you
hold both copies of A, 10, K, Q, and J of TrumpSuit, you score 1500, not
300 (same convention as Double Pinochle and the Arounds doubles below).

### Class B — Pinochle Melds

| Meld | Requirement | Points |
|---|---|---|
| Pinochle | Q♠ + J♦ | 40 |
| Double Pinochle | Both Q♠ + both J♦ | 300 |

Double Pinochle **replaces** two single Pinochles — it is not
2 × 40 = 80. If you hold both Queens of Spades and both Jacks of
Diamonds, you score 300, not 80.

### Class C — Around Melds

| Meld | Requirement | Points | Double (both copies, all 4 suits) |
|---|---|---|---|
| Aces Around | 1 Ace of each suit | 100 | 1000 |
| Kings Around | 1 King of each suit | 80 | 800 |
| Queens Around | 1 Queen of each suit | 60 | 600 |
| Jacks Around | 1 Jack of each suit | 40 | 400 |

Doubles **replace** the single value (10×), they don't stack on top of it.

## Phase 4: Trick-Taking

12 tricks are played, one card per player per trick. The ContractWinner
leads the first trick; the winner of each trick leads the next.

Legal-move rules, applied in order:

1. **Lead**: the first player may play any card. This sets the LeadSuit.
2. **Follow suit**: if you hold a card of LeadSuit, you must play one.
3. **Beat if possible**: if following suit, you must play a higher rank
   of LeadSuit than the current highest LeadSuit card on the table, if
   you're able to.
4. **Trump if void**: if you have no LeadSuit card, you must play a
   TrumpSuit card if you hold one.
5. **Beat trump if possible**: if playing trump because you couldn't
   follow suit, you must play a higher TrumpSuit card than any trump
   already on the table, if able.
6. **Sluff**: if you have neither LeadSuit nor TrumpSuit cards, you may
   play anything.

### Trick Resolution

- If any TrumpSuit card was played, the highest trump wins the trick.
- Otherwise, the highest card of the LeadSuit wins.
- Ties (the same physical rank/suit played twice, e.g. two Aces of
  Spades) go to whichever copy was played **first**.
- The trick winner collects all 4 cards and leads the next trick.

### Claiming the rest ("the rest are mine")

A **house shortcut, not a rule of the game.** When the player on lead holds a
hand in which no card can be beaten, the remaining tricks are awarded to their
team instead of being played out, and the game shows the hand face up. This
saves the clicks; it never changes a score.

"Cannot be beaten" is stricter than "holds all the trump", and the difference is
the whole point:

- A **trump** card is unbeatable when no other seat holds any trump.
- A **side** card is unbeatable when no other seat holds a higher card of that
  suit. Equal rank is fine — the deck has two of each card and a tie goes to the
  one played first, which is the claimer's, because the claimer is on lead.

Holding every remaining trump is *not* sufficient. A seat with all the trump and
two low hearts wins the trump tricks and then has to lead a heart into three
players who can beat it. Measured over 3000 played hands, awarding on "holds all
the trump" would have handed over tricks the claiming team went on to lose in
906 cases.

Both conditions are checked only between tricks, for the seat about to lead:
being on lead is what lets the claimer choose the suit every time, so no card of
theirs ever meets anything above it.

**TypeScript only.** `pinochle_engine.py` plays every trick out. The shortcut is
outcome-neutral by construction, so the two engines still agree on every score —
and `playTrickTakingPhase`, which is what the parity tests replay Python rounds
through, deliberately does not apply it.

## Phase 5: Round Scoring

- Every **Ace, 10, and King** collected in tricks = 10 points each.
- Every **Queen, Jack, and 9** = 0 points.
- The team that wins the **12th (last) trick** gets a **+10 bonus**.
- Total trick points available per round: **250**.

### Contract Check

- Add each team's `meld_points + trick_points` for the round.
- If the bidding team's total is **less than** their bid, they score
  **−bid** for the round (they "go set").
- The defending team always scores their own meld + trick points,
  regardless of what happens to the bidding team.

## Game Win / Loss

- First team to reach **1000 points** (cumulative across rounds) wins,
  checked at the end of each round.
- If both teams cross 1000 in the same round, the **bidding team** wins
  the tie.
- If a team's cumulative score drops to **−1000 or lower**, the game
  ends immediately and the **other team wins**, regardless of that
  team's own score.

### Why 1000

**A house rule, and a one-sitting target.** The number is chosen so a game
is a handful of hands rather than an evening. Measured over 2000 games
(`pinochle_engine.py`, Proficient seats, deal seeds 1000-2999): a mean of
**4.52** hands to a win, median **4**, with **4.1%** finishing in two hands
or fewer. Four hands is the shape this is meant to have, so 1000 stays where
it is and is not a constant waiting to be tidied upward.

The consequence is that a **Double Run** (1500) beats the whole game on its
own, and that is known and accepted rather than an oversight. It needs no
contract to cash: the defending team always scores their own meld, so the
hand wins from either seat, before a card is led. It happened in 2 of the
2000 games — **0.10%** — which reads as a story about a hand rather than a
hole in the balance.

Moving the target later would not be a one-constant change. Both engines read
`GAME_WIN_SCORE`, but `win_probability.py` derives its `BUCKET_COUNT` from the
win/lose pair and its `WIN_PROBABILITY_TABLE` is a hard-coded 20×20 literal
that would have to be re-measured.

## Implementation Notes (for future chats picking this up)

### Which engine is the real one

There are two implementations of the rules above, and they are not
peers:

- **TypeScript, `web/src/engine/` — the shipped one.** The PWA is the
  product, and a rule that is wrong here is wrong for players. It is live
  at <https://pinochle-house-rulez.netlify.app>, but deploys are manual —
  merging to `main` does not publish anything, so a rules fix reaches
  players only once someone deploys.
- **Python, `pinochle_engine.py` — the reference implementation, and
  the research harness.** It implements all of the above end-to-end and
  is tested (deal integrity, legal-move filtering, meld edge cases,
  bidding/passing card counts, full multi-round games to a winner), and
  it is where offline strategy research runs. It is not an active
  target for *shipped rules behaviour* — new player-visible work lands
  in TypeScript — but it is not frozen either: the whole rollout/EV/
  distillation program lives here and is actively developed. See
  ROADMAP.md's "Settled questions" for the full statement of the split.

### The AI is real strategy, not placeholders

An earlier version of this section claimed `choose_bid`,
`choose_trump`, `choose_pass_cards`, and `choose_card` on `Player` were
placeholder logic — coin-flip bidding, most-cards-held trump, random
passing, first-legal-move play. That has not been true since the
Proficient tier landed. What they actually do:

- `choose_bid` — Proficient bidding on the layered Base Bid valuation
  (`best_base_bid` → `compute_competitive_adjustment` → `max_bid`'s
  cap), plus positional and score-context rules: the opener threshold,
  a forced open as third bidder, dealer protection when a partner
  dealing near 1000 is a target for a pass-out, the
  `DEFENSIVE_PUSH_FLOOR` response to a minimum opener, and backing off
  once a partner is carrying the auction.
- `choose_trump` — the same per-suit Base Bid comparison, so trump
  follows real speculative hand strength rather than raw card count.
- `choose_pass_cards` — role-aware (bidder vs. partner) and split by
  trump category (Spades/Diamonds vs. Hearts/Clubs), via
  `_bidder_pass_selection` / `_partner_pass_selection`.
- `choose_card` — `choose_lead_card` / `choose_follow_card`, reasoning
  over `PlayTracker`'s record of which of the two copies of each card
  have already been played.
- `decide_fold` — whether to concede the contract rather than play it
  out, asked of the bid winner after meld and before the first lead.
  Proficient always plays on, deliberately: conceding well needs a read
  on the tricks that this tier has no way to get.

The degenerate behaviours the old note described do still exist, as
explicit fallbacks for when a method is called with no context
(`context is None`, no `trump_suit`/`is_bid_winner`, no `trick`). They
keep the methods usable in isolation and keep older tests working; a
real `Round` never reaches them.

### Tiers and the skill dial

- `EasyPlayer` — additive subclass: meld-only hand valuation, static
  formula plus noise for bidding, flat per-card passing, lowest legal
  card when following.
- `GeneralStrategy` — one subclass parameterized by skill level 1–5
  (`GENERAL_STRATEGY_SKILL_PARAMS`), a dial rather than a branch to a
  different algorithm. Levels 4–5 spend a rollout budget; 1–3 run the
  static paths.
- `RandomStrategy` — draws a skill level once at construction; every
  move afterwards is ordinary `GeneralStrategy`.
- `pinochle_rollout.py` — the Monte Carlo determinization + playout
  sampler behind all of that: `bid_ev` / `bid_ev_differential`,
  `defend_ev`, `should_fold`, the auto-SET guard, and (via
  `win_probability.py`) an optional P(win the game) objective.

### How the AI reaches the browser

Full rollouts cannot run in a phone browser, so the expensive thinking
is done offline and only the conclusion ships:

`generate_rollout_dataset.py` (labelled real decisions) →
`fit_evaluator.py` (two logistic models, one for bidding and one for
folding) → `rollout_evaluator.json` → `export_evaluator.py` →
`web/src/engine/evaluatorModel.ts`, plus a parity fixture the TS suite
scores against the Python model so the two sides cannot drift.

On the TS side the decision entry points are `chooseBid` /
`chooseTrump` (`bidding.ts`), `choosePassCards` (`passing.ts`),
`chooseLeadCard` / `chooseFollowCard` (`tracker.ts`), and `shouldBid` /
`shouldConcede` (`evaluator.ts`). `SKILL_PARAMS` in `skills.ts` is the
dial: `hard` and above bid with the distilled evaluator, `easy` and
`medium` keep the hand-tuned constants, and **all five levels fold with
the model** — a fold costs the same as being set (`-bid`, meld
forfeited either way) and denies the defenders their trick points, so
it is strictly dominant and belongs to shared competence rather than to
the difficulty dial.

Any strategy change is judged on a paired A/B run over identical deals
with the seats mirrored, not on impressions: `ab_harness.py` in Python,
`web/src/ab/` in TypeScript.

### Misdeal rule: where it is implemented

- **TypeScript (shipped): implemented, for every game mode**, so the
  "applies uniformly across every game mode" line in the rule above is
  accurate for the engine players actually meet. The pure eligibility
  check is `web/src/engine/misdeal.ts` (`isMisdealEligible`,
  `MISDEAL_NINE_THRESHOLD = 5`); the check-each-seat-in-order /
  ask-the-human / auto-take-for-an-AI / redeal-and-recheck loop is
  UI-layer state in `gameFlowReducer.ts` + `GameFlow.tsx`, and
  `web/src/ab/headlessGame.ts` redeals the same way for AI-only harness
  games. (An earlier note predicted this would land in `round.ts` —
  it did not; `round.ts` picks up after trump is set.)
- **Python: still a gap.** `human_play.py`'s
  `InteractiveRound._check_misdeal` remains the only implementation.
  The core `Round.run()` used by AI-only games goes straight from
  `_deal()` into `_bidding_loop()`, so Python AI-vs-AI games and
  `tournament_sim.py` runs never reshuffle. Left alone on purpose:
  closing it would change every historical Python tuning baseline, for
  a rule the shipped engine already honours. That is a measurement
  cost, not a shortage of effort — the reason to leave it is that the
  Python side is still actively used for research, not that it is
  closed to change.

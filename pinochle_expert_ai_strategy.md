# Pinochle Expert AI — Strategy Design Guide

This document is a companion to `pinochle_rules.md`. Where the rules doc
defines what is *legal*, this doc defines what the **Expert-tier AI**
should do to play *well*. It captures design decisions made in a planning
session with the project's domain authority (20+ years playing Pinochle)
and should be treated as a spec to implement against — not a finished
algorithm. Several open questions are called out explicitly at the end;
resolve those before finalizing the affected sections.

Scope: this doc is about the **Expert** difficulty tier only. Easy and
Proficient are out of scope here and should not be changed based on this
document unless noted.

---

## 0. Core Architectural Principle: Determinization + Rollout

The Expert AI must never access hidden information (opponents' hands,
undealt cards). Instead, hand "worth" is estimated the way strong
Bridge/Skat engines do it: **Monte Carlo determinization**.

At any decision point, only condition on what is legally known at that
exact moment:

| Decision point | Known | Sampled (unknown, dealt randomly) |
|---|---|---|
| Bidding | Own 12 cards + bid history so far | Partner's 12 + both opponents' 12 (36 cards) |
| Return pass (Bidder) | Own 15 cards (12 + partner's 3) | Partner's remaining 9 + both opponents' 12 (33 cards) |
| Trick play | Everything played so far, hand sizes, void inferences | Remaining unseen cards only |

**Algorithm (bid-time example):**

```
for N samples (~100-200 for bid-time; can go higher post-pass):
    1. Randomly deal the unseen cards into partner / opp-left / opp-right
    2. Assume a candidate trump suit
    3. Simulate partner's forward pass using the REAL pass logic (Section 2)
       run against the sampled hand, not a simplified stand-in
    4. Simulate the bidder's return pass using the REAL return-pass logic (Section 3)
    5. Score the resulting meld
    6. Roll out all 12 tricks using the real trick-play logic (Section 4)
       for all four seats
    7. Record: made/set, team points, opponent points
average across samples → P(make bid), E[points]
```

This same machinery answers hand valuation, bidding EV, pass selection,
and the "realistic ceiling" problem (Section 6) — it is one mechanism,
not three separate hand-crafted formulas. **Fidelity matters**: the
rollout is only as good as the pass/trick-play logic it runs internally,
so Sections 2-4 need to be implemented for real (not simplified stubs)
before the Monte Carlo numbers can be trusted.

**Performance notes:**
- Auto-SET (Section 5) should be checked *before* running a trick-play
  rollout on a sampled deal — if a sample is already a guaranteed set,
  skip the 12-trick simulation entirely and just record the result.
- Bid-time sampling should stay cheap (~100-150 samples); the one-time
  post-pass hand evaluation can afford more (~300+).

**Not in scope for this rollout mechanism:** actual bluffing/deception.
Partnership Pinochle bidding is public and sequential, so there is
little to bluff about at the bid — see Section 7 for what deception
*does* apply to (trick play only, Expert-tier, last-resort).

---

## 1. Bid-Time Expected Value

Replace the static Base-Bid + Competitive-Adjustment formula (still fine
as the fast-path prior, and as the Easy/Proficient logic) with simulated
EV for Expert:

```
EV(bid) = P(make bid) × (meld + trick points) − P(fail) × bid
```

Choose the bid that maximizes EV rather than reading off a fixed table.
Competitive/blocking bids (bidding above your hand's standalone value to
deny the contract to opponents, or to push an opponent past their real
threshold) are not a separate mechanic — they fall out naturally by
computing EV for a slightly-higher-than-"optimal" bid and comparing.

### Reading opponents' bids (v2 / optional enhancement)

A player who bids confidently (opens freely, raises quickly) is
statistically more likely to hold a strong hand; a player who passes
early is more likely weak. This is legitimate public inference, not
cheating and not "bluffing" — it's exactly what a sharp human does.

Implementation: rather than dealing the 36 unknown cards uniformly at
random in the Monte Carlo sampler, weight the deal by each opponent's
bidding behavior so far (players who bid aggressively get sampled
stronger hands more often). This is a refinement to the sampling step
in Section 0, not a new system. **Treat as a v2 feature** — get the
uniform-random baseline working and validated first.

### Score-aware risk (human-motivated, likely low priority for AI)

Real players bid differently when trailing badly (~−1000) vs. leading
(~+1000) vs. close. This can be modeled as a multiplier on the required
P(make) threshold, driven by score differential and proximity to the
±1000 game bounds. Per project discussion, this matters far more for
human psychology than for AI (the AI has no reason to "feel" pressure)
— deprioritize relative to Sections 0-2 unless win-rate tournaments
show it matters empirically.

---

## 2. Forward Pass Logic (Partner → Bidder)

Trump is already declared when this decision is made. The partner is
choosing 3 cards to send, with full knowledge of trump suit.

### Tier 0 — always chase if missing

| Meld piece | Notes |
|---|---|
| Any card completing trump A/10/K/Q/J (Run/Marriage) | Trump-suit only |
| Q♠ or J♦ (Pinochle) | **Trump-independent** — always a candidate regardless of trump suit, since the physical cards are Q♠/J♦ specifically |
| Missing Ace (any suit) toward Aces Around | Only Aces — see exclusion below |

### Hard exclusion — Kings Around, Queens Around, Jacks Around

**Never chase these from zero, and never chase them based on partial
progress** (e.g., holding 3 Kings does *not* make requesting the 4th
worth a pass slot). Confirmed explicitly: soft correlations like "if I
hold 3 Kings, partner probably doesn't have trump-King but may hold a
Queen or two" are **not hardcoded** — they are exactly the kind of
belief the Monte Carlo rollout should surface on its own, by actually
simulating the real (non-chasing) pass logic across sampled deals. Do
not build a partial-progress heuristic for K/Q/J Around.

**Exception:** a King or Queen of the *trump* suit is still Tier 0 (it's
being counted for Marriage/Run, not for Kings/Queens Around). A Jack
that happens to be the trump suit's Jack (Run) or J♦ (Pinochle) is
likewise already covered by Tier 0 for those reasons — not because of
Jacks Around.

### Tier 1 — fallback shedding (only when Tier 0 has nothing to offer)

If none of the 3 required cards can come from Tier 0, prefer to ship a
card that (a) shortens the partner toward a void in a suit, and (b)
removes an *unprotected* count-card (a 10, or an Ace not part of a kept
marriage) rather than a card that would break the partner's own kept
meld.

Concrete case: partner holds 10-K-Q of a non-trump suit and nothing
Tier-0 eligible. Correct play: **keep K+Q** (preserves the partner's own
20-pt Common Marriage), **ship the 10** (it has zero meld value outside
of Run/Double Run, which are trump-only — a non-trump 10 is pure
liability; shipping it also starts a void).

**Resolved for v1 (issue #61, revised)**: this is not one fixed global
rule — it's a static-mode-vs-rollout-compare-mode split tied to skill
level (see #63's dial), implemented as an optional `rollout_evaluator`
callback on the shared `choose_forward_pass_cards` function
(`pinochle_engine.py`):

- **Static/no-rollout-budget skill levels** (no evaluator passed): Tier 1
  is a strict last resort — it only fills slots Tier 0 left empty, and
  never outranks a Tier 0 pick. This is intentionally not the smartest
  possible play; that gap is part of what makes low skill actually play
  worse.
- **Rollout-budget skill levels** (evaluator passed): no hardcoded
  ranking. Generate both the marginal Tier 0 candidate and the competing
  Tier 1 candidate, and let the determinization sampler (#59) score each
  via a mini pass-and-rollout EV comparison — whichever wins, wins. This
  lets higher skill levels discover the cases where shedding differently
  is actually correct, instead of following a fixed rule.

Documented as the current default/tunable, same as the knapsack-doubles
question in Section 3.

---

## 3. Return Pass Logic (Bidder → Partner)

Trigger: the Bidder now holds 15 cards (12 dealt + 3 received) and must
choose 3 to send back. **No restriction** on which cards can be
returned, including ones just received (confirmed in `pinochle_rules.md`).

### Objective

Reduce the Bidder's count-card liability, increase the Bidder's meld and
likely trick-winners. Concretely: **pass loser-points to partner.**

### Non-trump 10s are automatic ship candidates

Since meld only comes from A/K/Q/J, a non-trump 10 has **zero meld
value** and no path to matter except a Run/Double Run, which is
trump-only by definition. A non-trump 10 the Bidder is holding is a pure
liability (count value, no meld upside, and the Bidder has to protect it
through 12 tricks while also managing trump control as declarer). Any
non-trump 10 not needed for a Run should be a top candidate to return,
in either pass direction.

### Knapsack triage across competing melds

When a hand has more meld-in-progress than can fit in 12 cards, sort
candidate melds by point value descending and greedily lock cards to the
highest-value melds first. Cards not needed by any locked-in meld (or
only needed by the lowest-value meld once slots run out) become the
return-pass pool. Example: a hand that could complete Kings Around (80)
*and* Run (150) + Double Pinochle (300) + Aces Around (100) but lacks
slots for all of it should break the Kings Around and keep the higher
group.

**Resolved for v1 (issue #61)**: no — the greedy-by-value knapsack does
NOT break a complete single meld (e.g. a finished Aces Around) to chase a
Double of the same meld. `choose_return_pass_cards`
(`pinochle_engine.py`) locks melds highest-value-first and never reopens
a lock once made — a complete single meld that gets locked stays locked
for good. Documented as the current default/tunable; validating
double-vs-single tradeoffs empirically is left to future tournament-sim
tuning, not hand-coded here.

### Advanced: duplicate-card elimination plays (last resort, situational)

Because every rank/suit exists in two copies, a team can sometimes
coordinate control of a suit across *both* partner hands rather than one.
Example: Bidder holds trump = Hearts, plus both copies of A♦, plus Q♦
and 9♦. Passing A♦+Q♦ to a partner already holding K♦ completes the
partner's Marriage — then in trick play: draw trump first, lead the
Bidder's remaining A♦ (partner isn't forced to overtake since it would
only tie, so they can shed K♦/Q♦ instead and keep their own Ace), then
lead the worthless 9♦ purely to burn the lead — leaving partner's A♦
uncontested for a guaranteed trick. The same idea applies to passing a
duplicate trump Ace to set up a Queen-lead capture.

This should **not** be hand-coded as a rule ("pass an Ace when X"). It's
a planning-level play that only makes sense in specific duplicate-holding
configurations, and it depends entirely on the receiving trick-play logic
being able to execute the sequence (see Section 4's dependency note).
Instead: let the return-pass candidate generator include "pass a
duplicate meld-completing card" as a low-priority, rarely-triggered
option, and let the **rollout** discover whether it pays off by actually
simulating the resulting trick play and comparing scores against the
safer default. If the trick-play rollout can't find/execute this kind of
sequence, it will simply never look better than the safe default — which
is fine as a conservative default, but means this pattern won't be
captured until trick-play lookahead exists.

---

## 4. Trick-Play Strategy

### Bidder leading — draw trump

1. **If you hold a trump Ace, it is always your first lead — unconditionally.** No other trump-leading heuristic needed; the Ace is unbeatable by rank so leading it is risk-free and immediately clarifies whether the second Ace is still live (if it doesn't reappear, someone still holds it and the Bidder's count-cards remain at risk from it until confirmed dead).
2. If no trump Ace is held, this is a materially weaker hand — see open question below on "fold" behavior.
3. **Mandatory-beat is what makes trump-drawing forceful, not hopeful**: per `pinochle_rules.md`, a player following suit must play higher than the current highest card on the table if able. This means leading even a low trump can force out a hidden high trump from an opponent who is unable to simply follow with a lower card.

### Endgame sequencing — protect the last-trick bonus

The 12th trick carries a **+10 bonus** (per `pinochle_rules.md`). Once no
trump remains live among opponents and the Bidder holds a mix of losers
and leftover trump, **play losers first, hold trump back** — this
guarantees a trump card is still in hand to win the 12th trick and claim
the bonus.

### Following suit (general)

- **Third-hand-high** when it's your side's trick to win and no one has
  played high yet.
- **Duck when partner is already winning** the trick — don't spend a
  high card on a trick that's already secured.
- **Protect count cards** (A/10/K): don't sluff them into a hopeless
  trick when a zero-count card (9/J/Q) is available instead. This
  matters especially for the defending team, since every count card
  that lands in the Bidder's pile helps them make contract.
- **Trump-in judgment when void**: over-trump only when it secures the
  trick and is worth it; otherwise sluff/under-trump to conserve trump.

### Defending team (proposed default — see open question)

Defenders' incentive is generally inverted from the Bidder's: leading
trump helps the Bidder consolidate control, so defenders should
generally **avoid leading trump** and instead attack the Bidder's
weakest suit, forcing early ruffs that burn the Bidder's trump control.
This is the standard defensive counter-pattern in trick-taking games
generally, proposed here as a working default — **not yet explicitly
confirmed** by the domain authority for this project.

### Critical dependency: card-counting infrastructure

Everything above (trump-draw sequencing, "second Ace still live",
suit-exhaustion inferences) depends on tracking **which of the two
copies of each rank/suit have been played**, not just what's been played
in aggregate. **This has been asked about multiple times in design
discussion and not yet confirmed** — before implementing Section 4,
verify whether the existing cascade trick-play strategy already tracks
seen-cards per rank/suit, or whether that tracking needs to be built as
part of this work. This also gates whether the current trick-play logic
is purely reactive (best legal move this trick) or has any lookahead —
if purely reactive, Monte Carlo rollouts will systematically undervalue
sequenced plays like the elimination example in Section 3, on exactly
the hands where they'd matter most.

---

## 5. Auto-SET Rule

250 is the maximum possible trick points in any round (`pinochle_rules.md`).
Once passing completes and hands are melded, check before playing any
tricks:

```
if BiddingTeamMeld + 250 < Bid:
    → auto-SET, skip trick play entirely
    → Bidding team scores −Bid
    → Defending team scores their own meld only (no trick points awarded)
```

This is a hard mathematical prune (not a heuristic) and should run
before any Monte Carlo trick-play rollout on a sampled deal, since it
lets the simulator skip the expensive 12-trick playout whenever a sample
already guarantees a set.

**Design decision made:** on an auto-set hand, the defending team's
cumulative score reflects meld only, not meld + hypothetical tricks —
accepted as an intentional approximation.

---

## 6. Realistic Ceiling / P(make) — replaces any fixed-number cap

A fixed ceiling (e.g., "never bid above 250 trick points") is wrong in
both directions — it wrongly caps genuinely exceptional hands (one card
from a Double Run, 7 Aces, etc.) and doesn't catch merely-optimistic bids
that are technically legal but unrealistic (e.g., 100 meld + needing 250
of 250 possible trick points to hit a 350 bid). The correct replacement
is not a formula but the **output distribution of the Monte Carlo
rollout** from Section 0/1: use something like the 85th-90th percentile
of simulated trick points as the realistic ceiling for that specific
hand, and let P(make) from the same rollout drive bidding EV directly.

**OPEN QUESTION:** Should a simplified "realistic ceiling" number also
be exposed standalone (e.g., for a fast pre-filter before running full
EV, or as a human-readable debug value), or should this live purely
inside the P(make)/EV calculation with no separate interpretable output?

---

## 7. Deception — scope and limits

Partnership Pinochle bidding is public and sequential; there is little
room for "bluffing" there in the poker sense. What looks like bluffing
in bidding is really the Competitive Adjustment / blocking-bid logic
already covered in Section 1 — pushing an opponent past their real
threshold, not misrepresenting your own hand.

Genuine deception exists only in **trick play**, and only pays off
against an opponent (human or AI) capable of tracking cards and updating
beliefs from what's been played:

- **False-carding**: playing a card that misrepresents your holding in a
  suit to induce a bad read.
- **Fake voids**: discarding out of a suit strategically (when you have
  a choice) to make an opponent believe you're void.

**Scope this strictly to Expert tier**, and only after the card-counting
/ lookahead dependency in Section 4 exists — false-carding is wasted
sophistication without an opponent-model capable of noticing it, and
without your own tracking layer in place to know when a false-card would
even be believable. Not needed for Easy/Proficient.

---

## 8. AI Difficulty Tier Summary

| Tier | Hand worth | Bidding | Risk | Deception |
|---|---|---|---|---|
| Easy | Meld only, no trick-potential estimate | Static formula + noise | None | None |
| Proficient (current baseline) | Meld + heuristic trick-potential, no simulation | Static/refined formula | None | None |
| **Expert (this doc)** | Monte Carlo determinization + rollout (Section 0) | Simulated P(make) → true EV (Section 1) | Score-aware multiplier (optional, low priority) | False-carding vs. tracked opponents only (Section 7) |

**Validation plan:** build Expert as a separate strategy module/class so
Proficient stays untouched as a control group. Run large-N 2v2 tournament
simulations (Expert+Expert vs. Proficient+Proficient) as both the
acceptance test and the ongoing regression check — if a change doesn't
measurably move the win rate, it isn't actually an improvement. This is
also the mechanism for tuning any numeric parameters (sample counts,
percentile cutoffs, risk multipliers) rather than hand-picking them —
batch-simulate variants and let win rate pick the winner.

---

## 9. Open Design Questions — resolve before implementing the affected section

1. ~~**(Section 2)** Is Tier-1 forward-pass shedding strictly a last
   resort, or can it outrank a marginal Tier-0 pick?~~ **Resolved for
   v1** (issue #61): both, split by skill level via an optional
   `rollout_evaluator` callback — see Section 2.
2. ~~**(Section 3)** Does return-pass knapsack triage extend to
   doubles (e.g., break a complete single Around to chase its
   Double)?~~ **Resolved for v1** (issue #61): no, completed melds
   stay locked once knapsacked — see Section 3.
3. **(Section 4)** What does "fold" mean for a Bidder with no trump Ace —
   a bid-time signal (don't take the contract on such a hand) or a
   mid-hand behavioral shift (keep the contract, abandon the aggressive
   trump-draw plan)? Does the partner mirror this behavior when *they*
   lack the trump Ace?
4. **(Section 4)** Does the Bidder's partner run the same Ace-first
   trump-draw sequence when *they* end up on lead, or defer entirely to
   the Bidder's declared plan?
5. **(Section 4)** Confirm (or correct) the proposed defender default:
   avoid leading trump, attack the Bidder's weak suits, hoard trump to
   ruff.
6. **(Section 4 — critical, blocks several other sections)** Does the
   existing cascade trick-play strategy already track which of the two
   copies of each rank/suit have been played? Is it currently reactive
   (best legal move this trick) or does it have any lookahead? This gates
   the reliability of Monte Carlo rollouts on any hand where sequencing
   matters (Section 3's elimination-play example, Section 4's trump-draw
   logic).
7. **(Section 6)** Expose "realistic ceiling" as a standalone number, or
   keep it purely internal to the EV calculation?

---

## Appendix: Suggested Implementation Shape

- `ExpertPlayer` as a new subclass alongside the existing `Player`/
  `HumanPlayer` pattern — do not modify the Proficient-tier logic; it's
  the tournament control group.
- A determinization/sampler function, parameterized by decision point
  (bid-time / return-pass / trick-play), that deals unseen cards and
  invokes the *real* pass and trick-play logic — not simplified stand-ins
  — so rollout fidelity matches Section 0's requirement.
- Auto-SET check (Section 5) as a cheap guard at the top of the rollout,
  before any 12-trick simulation.
- Tier-0/Tier-1 candidate tables (Section 2) and the knapsack triage
  (Section 3) as shared, callable logic — used both by the real
  `choose_pass_cards` and by the sampler's internal simulated players,
  so there's exactly one implementation of "how a partner passes," not
  two that can drift apart. **Implemented (issue #61)** as
  `choose_forward_pass_cards` / `choose_return_pass_cards` in
  `pinochle_engine.py`, independent of any Player subclass — a future
  `ExpertPlayer` (#63) and the rollout sampler's internal simulated
  players both call into the same functions.

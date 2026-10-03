# Hand Valuation and the Pass — Paul's Written Account

This is `Rules Extended.odt` (Paul, last edited 2026-09-20), converted to
markdown by #326 and accepted as the authority on 2026-10-03. It is how a
hand is valued for bidding and which cards go in each 3-card pass.

**Why a separate file and not a section of `pinochle_rules.md`.**
`pinochle_rules.md` is the rules: what is legal and what scores. Nothing on
this page is a rule. A player may bid, or pass, any cards they like. This
page is **AI strategy**, which falls on the other side of the rules-vs-strategy
split #213 drew and `CLAUDE.md` records. Folding it into the rules file would
make the rules' source of truth carry tunable numbers that are judged by
paired A/B runs, not by rulings. `pinochle_rules.md` links here from its
Implementation Notes.

Where the engines do something different from what Paul wrote, the
difference is **flagged on this page and not resolved**. The engines and
this page stay as they are until someone decides which is right. Python
(`pinochle_engine.py`) is the reference engine. `web/src/engine/` ports it,
and `test_ported_constants.py` pins every shared number.

---

## Step 1 — Base Bid: what will this hand meld?

`compute_base_bid` / `computeBaseBid`. Speculative meld in the trump being
valued. It differs from the scored meld of `pinochle_rules.md` Phase 3 in
two lines: the near-run and the near-double pinochle.

| Meld | Value |
| --- | --- |
| Double Run (both copies of A, 10, K, Q, J of trump) | 1500 |
| Run (A, 10, K, Q, J of trump) | 150 |
| Near-run (missing exactly one of the five) | 120 |
| Royal Marriage (trump K+Q), each pair beyond what the run consumed | 40 |
| Common Marriage (non-trump K+Q), each | 20 |
| Dix (9 of trump), each | 10 |
| Double Pinochle (2x Q♠ + 2x J♦) | 300 |
| Near-double pinochle (3 of those 4 cards) | 225 |
| Single Pinochle (Q♠ + J♦) | 40 |
| Holding a pinochle and **no** K♠ at all | +20, **once**, even with a double pinochle |
| Aces / Kings / Queens / Jacks Around | 100 / 80 / 60 / 40 |
| Any Around doubled | x10 |

The original line for the K♠ bonus reads "If no KS then add 20 1x despite 2
KS". Read with the code, that means +20 paid once for the hand and never
once per pinochle, and only when the hand holds no K♠. The engines'
`PINOCHLE_NO_KING_OF_SPADES_BONUS` does exactly this.

Engines: every value above matches both engines.

## Step 1.5 — Trick potential: what will it take in tricks?

`compute_trick_potential` / `computeTrickPotential` (#277). All lines add up,
and each is counted per card.

| Line | Value |
| --- | --- |
| Every Ace, any suit (flat, a speculative ~2 tricks) | 20 |
| Every Ace **of trump**, on top of the flat Ace line | 20 (so a trump Ace is 40 in total) |
| Every trump card beyond the fourth | 20 |
| A non-trump 10 with both Aces of its suit in hand | 20 |
| An unmarried non-trump K or Q that **you will pass** | 20 (see below) |

**The trump-Ace line.** The original's "Trump: Run for every A, and every
Trump beyond 4 - 20" is *not* a per-Ace run bonus. The 2026-10-03 decision
reads it as two lines. Every trump Ace is worth 20 on top of its flat 20 as
an Ace. Every trump card past the fourth is worth 20. The Run itself stays
at its Step 1 value of 150 (120 as a near-run). These are the engines'
`TRUMP_ACE_VALUE` and `EXTRA_TRUMP_VALUE`.

**The protected-10 line.** The original's "Anywhere you have double A, the
10 counts as 20" applies only off trump. A trump 10 is a Run card and Step 1
has already priced it. The engines use the same predicate as the bidder's
pass, `_is_protected_ten` / `isProtectedTen` (#276).

### Unmarried K/Q: "and you will pass"

The original line reads: *"For every K or Q that is not a marriage and you
will pass – 20"*.

**What "not a marriage" means.** There is no K/Q of the other rank in the
same suit anywhere in the hand. This is a test on the suit, not on the card,
so K-K-Q pays the Common Marriage and nothing here. Trump K/Q are excluded,
because the Run and Royal Marriage lines price them.

**What "you will pass" means.** The 2026-10-03 decision reads it literally.
An unmarried K/Q is worth 20 when it goes into the pass and 0 when it is
kept. "Goes into the pass" depends on the seat, and the valuation speaks for
one seat only:

- The valuation is a **ceiling**. It is what the hand is worth to the
  player who would *hold the contract*. So the pass in question is the bid
  winner's **return pass** (bidder → partner), `_bidder_pass_selection(hand,
  trump, category, 3)` in Python and `bidderPassSelection` in TypeScript. It
  runs on the 12 dealt cards, at the trump being valued, under that trump's
  D/S or H/C category.
- The partner's forward pass (`_partner_pass_selection`) never enters. A
  hand is only valued for a contract it would hold, never for one its
  partner holds.
- The real return pass comes from 15 cards, after partner's three have
  arrived. Those three are unknown at bid time, so the dealt hand is the
  only honest input.
- Credit is per copy actually selected. K-K of a suit with one King passed
  pays 20.

In practice a loose K/Q is passed through the bidder's **spare K/Q** tier
(below), unless it is holding up an Around. It can also go out through the
**void** tier, as part of a short suit.

**What ships.** The literal reading is **not** what the engines ship. Since
#277 they pay every unmarried non-trump King `LOOSE_KING_VALUE` = 30 and
every unmarried non-trump Queen `LOOSE_QUEEN_VALUE` = 20, kept or passed.
#326 added the literal reading as an off-by-default arm:

- Python: `LOOSE_KQ_PASS_ONLY = False`, with the passed value
  `LOOSE_KQ_PASSED_VALUE = 20`. The `loose_kq_pass_only` keyword on
  `compute_trick_potential` / `compute_max_bid` / `best_base_bid` turns it
  on, and so does the per-seat `Player.loose_kq_pass_only`.
- TypeScript: the same two constants in `bidding.ts`, and the per-seat
  `SkillParams.looseKqPolicy` (`'flat'` ships, `'passOnly'` is the arm).
  The evaluator's ceiling feature follows the seat's policy.

Which reading ships is a paired-A/B question. The arm is waiting on #288's
valuation arm, and the shipped values do not move until that result is in.

## Step 2 — Competitive adjustment

The original does not cover this stage. The engines add
`compute_competitive_adjustment` (+80 baseline, +120 when behind by 600 or
more or on the run-plus-Aces-Around double-payoff shape, +60 when closing
out). `pinochle_rules.md` and that function's docstring hold its history.
Max Bid = Step 1 + Step 1.5 + Step 2, and nothing caps it (#283).

---

## The passes, as Paul wrote them

Paul titled this part "The passing rules that actually run in your game".
His lists are reproduced below as he wrote them. The diff against Python
(`_partner_pass_selection`, `_bidder_pass_selection`) follows each list.
TypeScript's `partnerPassSelection` / `bidderPassSelection` match Python,
and `passParity.test.ts` holds them together.

### Partner → bidder (`partnerPassSelection`)

Strict priority, taking cards until three are chosen:

1. Q♠ / J♦, but only when trump is Diamonds or Spades
2. Trump King, trump Queen (the royal marriage)
3. Trump A, 10, J, in that order
4. Any non-trump Ace, singletons first, keeping paired Aces together
5. Trump 9 (the dix)
6. Highest trump down
7. Void building: a whole short suit, if it fits the remaining slots
8. Any 9
9. Priority J, 10, Q, K

**Where Python differs (flagged, not resolved):**

- **P-1. Trump K/Q come before or after trump A/10/J.** Paul's list puts
  the royal marriage (2) ahead of A, 10, J (3). Python does the reverse.
  Its tier 2 is trump A/10/J and its tier 3 is trump K/Q. The docstring
  cites Paul's #280 reasoning: "really if you have enough Trump you might
  keep the Royal Marriage". Three slots often run out before tier 3, and
  A/10/J fill the Run's other ranks without breaking a K-Q pair the
  partner can still score.
- **P-2. The dix comes before or after the remaining trump.** Paul's list
  sends the trump 9 (5) before the "highest trump down" tier (6). Python
  does the reverse: whatever trump is left above the 9, highest first,
  then the dix. The code comment says the dix "scores its 10 for the team
  wherever it sits".
- **P-3. "Keeping paired Aces together."** Python sorts singleton
  non-trump Aces ahead of paired ones, which matches. But it fills slots
  one card at a time, so with one slot left it sends one Ace of a pair and
  splits it. Paul's wording reads as "never split a pair". Python only
  orders the pairs last.
- *Not a disagreement, recorded for completeness:* Python's trump tiers
  (2, 3 and highest-trump-down) send at most one card of each rank before
  any duplicate (`_take_spread`, Paul's 2026-09-02 "send a spread" rule).
  The list above is silent on duplicates.

### Bidder → partner (`bidderPassSelection`)

Roughly the reverse: what is safe to give away. Protected, and passed
last: trump, Q♠, J♦.

1. Q♠ / J♦ when trump is Hearts or Clubs
2. Spare King or Queen
3. Non-trump 10s (the original notes "what #276 is changing")
4. Non-trump J or 9 that doesn't break a marriage or an Around
5. Any unprotected non-Ace → any unprotected card → finally the protected
   cards
6. If you get here, you hold basically all trump and Aces, so pass trump
   9s and Js if trump is not Spades or Diamonds

**Where Python differs (flagged, not resolved):**

- **B-1. Python has a void-building tier that Paul's list lacks.** Python
  runs void building as tier 2, right after Q♠/J♦ and ahead of the spare
  K/Q. If every card of a non-trump suit can be passed (no Ace, no
  protected card, no piece of an A-A-10 group) and the suit fits the
  remaining slots, the whole suit goes. Paul's bidder list has no void
  tier at all. His partner list does.
- **B-2. Trump 9/J against "finally the protected cards".** Paul's step 5
  ends with "finally the protected cards", and step 6 (trump 9s and Js,
  H/C only) comes after it. Python places trump 9/J *before* the
  catch-all protected tier. Placed after, it could never run, because by
  then every remaining card is protected. This is probably the intent,
  but the written order says otherwise.
- *Already landed:* the 10s tier means **unprotected** 10s only, since #276
  merged. A 10 with both Aces of its suit in hand is held out of this tier
  and out of the void tier. It reaches the shed list only at "any
  unprotected non-Ace". The original's "what #276 is changing" note
  describes this.
- *Not a disagreement, recorded for completeness:* Python's "spare K or Q"
  is a K/Q that is not protected (Q♠ is protected, K♠ is not), breaks no
  marriage, and breaks no Around. A K/Q that is the only one of its rank
  holding up an Around stays in hand. The list above does not mention
  Arounds for this tier.

None of these differences has been changed on either side. Each one is a
call for Paul, tracked on #326.

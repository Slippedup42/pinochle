// Bidding — ported from pinochle_engine.py, but no longer downstream of it.
// #213 settled the split: Python stays authoritative for rules constants
// (card.ts, melds.ts, round.ts), while the auction *strategy* in this module
// is authoritative on the TS side. PARTNER_PASSED_FLOOR (#180) was measured
// here — 5000 paired deals on three seeds, in web/src/ab/. PARTNER_RAISE_FLOOR
// (#206) was reasoned rather than measured: the argument is what a raise says
// to a *human* partner, which has no referent in an all-AI Python game. It is
// reasoning because no harness in this project seats a human — every A/B run,
// on both sides, is AI-vs-AI, and ROADMAP.md carries "is a stronger AI a
// better partner for a human?" as a standing open question no measurement
// here can answer. The 330 competitive floor is likewise a TS-side decision.
// None of the three are ported back. The matching Python branches still hold
// their own bare literals; #213 traced that divergence and found it inert on
// every path that still consumes Python's bidding, so it is a decision to
// read, not a parity bug to fix.
//
// The Base Bid constants below are the exception and still track Python
// (#118). Python is not frozen either — it is the live AI-research and
// measurement platform — it simply does not rule this file.
//
// Two layers. Valuation, in three stages that each ask a different question
// of the same hand: computeBaseBid (what will it meld?) ->
// computeTrickPotential (what will it take? — #277) ->
// computeCompetitiveAdjustment (what is the scoreboard asking for?) -> the
// 400-cap / >300-meld-uncap rule (maxBid / cappedBid). bestBaseBid searches
// all 4 trump candidates and applies the cap to find the winning trump +
// ceiling.
// Decision: chooseBid/chooseTrump wrap that valuation with the stateful
// auction rules (endgame protection, 3rd-bidder-opens-cheap, when to raise
// vs. pass) - ported from Player.choose_bid / Player.choose_trump. This
// module only decides; it does not run an auction loop — that lives in
// components/auctionReducer.ts (#34), under gameFlowReducer.ts (#47).

import {
  type Card,
  GAME_WIN_SCORE,
  handCount,
  OPENING_BID,
  type Rank,
  Suit,
  suitLength,
  SUITS,
} from './card'
import { shouldBid } from './evaluator'
import { isProtectedTen } from './handShape'
import {
  MELD_ONLY_BID_NOISE,
  MELD_ONLY_TRICK_ESTIMATE,
  SHIPPED_SKILL,
  SKILL_PARAMS,
  type SkillLevel,
} from './skills'
import {
  AROUND_DOUBLE_MULTIPLIER,
  AROUND_VALUES,
  COMMON_MARRIAGE_VALUE,
  DIX_VALUE,
  DOUBLE_RUN_VALUE,
  PINOCHLE_DOUBLE_VALUE,
  PINOCHLE_SINGLE_VALUE,
  ROYAL_MARRIAGE_VALUE,
  RUN_RANKS,
  RUN_VALUE,
  scoreMelds,
} from './melds'
import { partnerOf, type TeamId, teamOf } from './round'
import type { PlayerIndex } from './trick'

// -- Base Bid — the hand-strength number bidding decisions are built on, and
// the two stages that sit on top of it. Distinct from scoreMelds: this is a
// *speculative* valuation (near-run, near-double-pinochle), not the actual
// guaranteed meld. ---------------------------------------------------------

// These two are ported from pinochle_engine.py, which CLAUDE.md names the
// reference implementation for this port and which is still authoritative
// here — valuation is a ported constant, unlike the auction floors below,
// which #213 put on the TS side. They read 60/60 here until
// #118 — a hand-port slip, not a deliberate divergence: every other constant
// in this block already matched Python exactly, and `bidding.test.ts`'s own
// case is titled "credits a near-run ... at 120" while asserting against the
// constant, so it passed at either value and documented the intent all along.
//
// The cost was not just undervaluing these shapes. `computeBaseBid` feeds
// `bestBaseBid`, which also *picks the trump suit* — so the browser could
// name a different trump than the reference engine on the very same hand.
export const NEAR_RUN_VALUE = 120
export const NEAR_DOUBLE_PINOCHLE_VALUE = 225
// A Queen of Spades that no spade marriage is asking for is a freer pinochle
// card, so a hand holding a pinochle and NO King of Spades at all is worth a
// little more (#277). Paid once for the hand, never per copy: a double
// pinochle with no K(S) adds 20 and not 40.
export const PINOCHLE_NO_KING_OF_SPADES_BONUS = 20

// -- Trick potential (#277). The stage between the Base Bid and the
// competitive adjustment: what the hand can win with cards rather than meld.
// computeBaseBid's comment has always said this belongs somewhere else and
// named the competitive adjustment as its home, but that layer only ever read
// the score, so until now nothing priced the tricks at all. It does now, and
// it is its own stage rather than more lines inside the Base Bid because the
// two answer different questions - what will this hand meld, and what will it
// take.
export const ACE_VALUE = 20 // every Ace, any suit, flat
// Per copy, and ON TOP of the flat Ace above, so a trump Ace is worth 40.
export const TRUMP_ACE_VALUE = 20
// Trump beyond the fourth card is length rather than shape.
export const TRUMP_LENGTH_BASELINE = 4
export const EXTRA_TRUMP_VALUE = 20
// See `isProtectedTen` in handShape.ts — the same rule the pass reads (#276).
export const PROTECTED_TEN_VALUE = 20
// A non-trump King with no Queen of its suit behind it, and vice versa.
export const LOOSE_KING_VALUE = 30
export const LOOSE_QUEEN_VALUE = 20
// Proficient AI draws randomly in this range each bid (partner-strength
// estimate). Not consumed by the pure valuation functions below — ported
// for parity with the Python constant block, same as there.
export const PARTNER_ESTIMATE_RANGE: readonly [number, number] = [50, 100]
export const MAX_BID_DEFAULT = 400
export const MAX_BID_MELD_THRESHOLD = 300

// -- The two static bidding thresholds. Both are guesses, and both are
// superseded by the fitted evaluator wherever `bidPolicy` reads `'distilled'`
// (see skills.ts), which since #222 is every seat a player meets. They are NOT
// dead: they still decide the raise ladder under both policies, and `'static'`
// is the baseline `BID_AB_POLICIES` seats. But anything that reads them outside
// `chooseBid`'s static branch is reading a rule the shipped opener does not
// follow. -----------------------------------------------------------------

// Minimum Base Bid to justify opening at all.
export const OPENER_THRESHOLD = 320
// Minimum ceiling to justify a defensive push against an opening bid (300
// again since #257, 250 in between under #200). Hands at or above this floor
// should almost always raise an opener, since even moderate hands can
// contribute toward making it with partner's help, and pushing deprives the
// opponent of a cheap contract.
// "Truly hopeless" hands (no meld, no aces — ceiling ~130) fall below this
// floor. It is a hand-strength threshold, not a bid level, so it did not move
// with the opener.
export const DEFENSIVE_PUSH_FLOOR = 200

// -- Endgame protection (#256). The one bidding rule that is about the *game*
// rather than about the hand: a team this close to 1000 banks its meld and
// lets the contract go, because the contract is worth little to it - the
// defending team scores its own meld either way (`pinochle_rules.md`, Contract
// Check) - while being set costs the whole bid and hands back a game that was
// one hand from over. Paul reported it from live play at 910-110, where a seat
// bid 390 on a good hand and needed 90 points it already held.
//
// Both thresholds are derived from `GAME_WIN_SCORE` so they follow the target
// if it ever moves; #243 records why moving it is expensive. 750 is "within
// 250 of going out", which one ordinary meld plus a share of the tricks
// reaches. 450 is "more than 550 away", more than the opponents can plausibly
// take off a single hand, so there is a next hand to fight it out in.
export const ENDGAME_SCORE_FLOOR = GAME_WIN_SCORE - 250
export const ENDGAME_OPP_SCORE_CAP = GAME_WIN_SCORE - 550
/**
 * The one hand check in the rule, and the only thing that puts a bid back on
 * the table while the trigger holds.
 *
 * This is the Max Bid **ceiling** — Base Bid plus the competitive adjustment,
 * capped — and not the Base Bid. In the score band this rule fires in,
 * `computeCompetitiveAdjustment` returns +100, so the effective bar is a Base
 * Bid a little over 100 and few hands fail it. That is a deliberate choice
 * rather than an oversight: Paul was shown the comparison and picked the
 * ceiling. If the rescue turns out to fire on hands that cannot carry
 * `OPENING_BID`, this number is what to revisit, not the choice of measure.
 */
export const ENDGAME_RESCUE_CEILING = 200

/**
 * The hand floor under the third bidder's positional open (#255).
 *
 * The seat that speaks after two passes with nobody having bid opens to deny
 * the last player a cheap contract. That used to happen on *any* hand at all,
 * which is what #255 was filed about: Paul's house rule from live play is that
 * a bid asserts a hand — "assume anyone bidding has 320 or they should not
 * bid."
 *
 * **This is 200 and not `OPENER_THRESHOLD`, and the difference was measured.**
 * A paired A/B on identical deals with the seats mirrored (`ab_harness.py`,
 * 800 pairs / 1600 games, run on the Python engine because that is the one
 * where this path fires — see `chooseBid`) put the floor at 320 and at 200
 * against the unfloored rule it replaces:
 *
 *   320: **−57 score margin per deal**, 95% CI −76 to −37, exact two-sided
 *        binomial p < 1e-4, sign test 34 sweeps to 83. Replicated on a second
 *        seed at −28/deal, CI −46 to −11, p = 0.0023.
 *   200: −7/deal, 95% CI −17 to +1, **not significant** (7 sweeps to 16,
 *        p = 0.09).
 *
 * So the positional open really is worth something, and all of what it is
 * worth lives in the 200–320 band — precisely the hands the house rule would
 * forbid. Paying 57 points a deal to enforce 320 here is not a trade worth
 * making; 200 still stops the seat opening on a hand with no meld and no aces,
 * which is what was actually seen at the table.
 *
 * The two numbers express different ideas and are deliberately not linked.
 * `OPENER_THRESHOLD` is "worth a contract". This is "not literally worthless".
 * Setting this to `OPENER_THRESHOLD` — or deriving it from it — would relink
 * two values that have just been measured apart, and the measurement above is
 * what the next person tempted to tidy it up should read first.
 *
 * Like `ENDGAME_RESCUE_CEILING` (which independently landed on 200 by
 * judgement rather than by measurement) this is the Max Bid **ceiling**, not
 * the Base Bid, and the comparison is `>=` — reached, not cleared — which is
 * the form that was measured.
 *
 * Both runs predate #242, which raised every hand holding a trump Run by 40,
 * and #273, which put it back — so on the run/marriage question the valuation
 * is once again the one that was measured. What #273 did change under these
 * figures is the >300-meld uncap in `maxBid`, since the scorer now pays 40
 * less on a run. The two mechanisms are independent and the gap between the
 * arms is far larger than either shift, so the direction stands; the exact
 * figures are of the valuation as it was that day.
 */
export const THIRD_BIDDER_FLOOR = 200

/**
 * The bid a seat must commit to once its partner has passed (#93/#95).
 *
 * Not a ceiling like the two above — it is an actual bid, placed on the table,
 * and **bids move in tens**. That distinction is what #177 was: this was
 * written as `320 + 1` to encode "strictly above OPENER_THRESHOLD", which is
 * the right *intent* and an impossible *bid*. Once any seat bid 321 the whole
 * ladder went off-grid (331, 341, ...) and `BiddingControls` — which gates its
 * Bid button on `amount % 10 === 0` — displayed a minimum the human could not
 * reach with the +/- buttons. That is why this constant exists at all, and it
 * is the part of it that is not negotiable: whatever value sits here has to be
 * a legal bid.
 *
 * *Which* legal bid was a design question, and #180 settled it — **reach the
 * opener threshold, do not clear it.** #179 shipped 330 on the other reading:
 * a seat whose partner has passed is buying the contract outright, so it should
 * be worth more than the hand that would open with help still to come, and the
 * strict `>` that `chooseBid`'s static verdict applied to the ceiling one tier
 * up was that same intent spelled a second way. Paul's call (2026-08-02) is
 * that bidding alone is a reason to *demand* the threshold, not a reason to
 * demand ten points past it — so the floor is the threshold's own value, and
 * the asymmetry that existed only to encode "clear" goes with it: the static
 * verdict now asks `ceiling >= OPENER_THRESHOLD` whether or not the partner has
 * passed.
 *
 * Still spelled as its own constant rather than as `OPENER_THRESHOLD`, because
 * the two are different kinds of number that presently coincide — that one is a
 * ceiling a valuation is compared against, this one is a bid placed on the
 * table. #177 is what conflating them costs.
 *
 * The measurement is what raised the question, and it survived re-baselining
 * onto #178 and #158: 320 plays 8-11 points per deal ahead of 330 on the
 * `'distilled'` levels and 26-32 on `'static'`, over 5000 paired deals on each
 * of three seeds (`web/README.md`, "The partner-passed bid floor").
 */
export const PARTNER_PASSED_FLOOR = 320
/**
 * The bid a seat must commit to when it raises **over its own partner** (#206).
 *
 * Read `PARTNER_PASSED_FLOOR` above first; this is the same kind of number and
 * it was the same kind of bug. `340` has always been in `chooseBid`, gating the
 * one branch where a seat bids over a bid its own team already holds — but it
 * gated the *ceiling* and the seat then bid `currentBid + minIncrement`. So the
 * rule read "I need a hand worth a 340 contract to do this" and the action was
 * "raise my partner by ten". The constant never reached the table.
 *
 * That is #177 exactly, one branch over, and it hid for the same reason: in an
 * all-AI auction it is invisible. The competitive branch's `Math.max(ceiling,
 * 330)` means the ladder arrives at 330 and `+ minIncrement` lands on 340 by
 * arithmetic accident, so a 4000-deal AI-vs-AI sweep shows every such bid at
 * exactly 340 and nothing wrong. **The human seat is what exposes it**, because
 * a human's bid is not on the AI ladder: bid 260 as the partner of an AI holding
 * a 360 ceiling and it answers 270, having just required a 340-worthy hand to
 * say so.
 *
 * Paul's call (2026-08-20), and his reasoning is the rule's justification rather
 * than a preference laid on top of it: raising your own partner costs your team
 * points and gains it nothing, so the only thing that can justify it is holding
 * substantially more than your partner's bid already showed. A raise that means
 * that should say it. Ten points does not say it — it just looks like the AI
 * bidding against itself, which is what made the table confusing to read.
 *
 * The alternative is to pass, and the ceiling gate is what keeps that available:
 * a seat that cannot support 340 still backs off rather than being talked into a
 * commitment it cannot make. This changes what a raise *says*, not how often one
 * happens.
 */
export const PARTNER_RAISE_FLOOR = 340

/** Remove up to `count` cards matching suit/rank from `pool` in place; returns how many were removed. */
function claim(pool: Card[], suit: Suit, rank: Rank, count = 1): number {
  let removed = 0
  for (const c of [...pool]) {
    if (removed >= count) break
    if (c.suit === suit && c.rank === rank) {
      pool.splice(pool.indexOf(c), 1)
      removed++
    }
  }
  return removed
}

export interface BaseBidResult {
  total: number
  breakdown: Record<string, number>
  /** Leftover cards not claimed by any Base Bid component, handed to the adjustment layer. */
  pool: Card[]
}

/**
 * Pure hand-value Base Bid: the meld you have, plus the Run and
 * Double-Pinochle proximity bonuses. Every line here is about *meld* - what
 * the hand will put face up. What the hand can win in tricks is priced one
 * stage later, in computeTrickPotential, and the score context one stage
 * after that in computeCompetitiveAdjustment.
 *
 * #277 moved the flat Ace line out to that middle stage and deleted the
 * "3 different Aces" bonus, which paid 60 with hearts or clubs trump and 50
 * otherwise. No rule of pinochle makes three Aces worth more when hearts are
 * trump than when spades are, nothing in the repo ever explained the
 * asymmetry, and Paul's rewrite of the valuation omits it.
 */
export function computeBaseBid(hand: readonly Card[], trump: Suit): BaseBidResult {
  const n = (suit: Suit, rank: Rank) => handCount(hand, suit, rank)
  const pool = [...hand]
  const breakdown: Record<string, number> = {}

  // -- Run / near-run ---------------------------------------------------
  const runCount = Math.min(...RUN_RANKS.map((r) => n(trump, r)))
  const missingRanks = RUN_RANKS.filter((r) => n(trump, r) === 0)
  const nearRun = runCount === 0 && missingRanks.length === 1

  let runValue = 0
  if (runCount === 2) {
    runValue = DOUBLE_RUN_VALUE
    for (const r of RUN_RANKS) claim(pool, trump, r, 2)
  } else if (runCount === 1) {
    runValue = RUN_VALUE
    for (const r of RUN_RANKS) claim(pool, trump, r, 1)
  } else if (nearRun) {
    runValue = NEAR_RUN_VALUE
    for (const r of RUN_RANKS) claim(pool, trump, r, 1)
  }
  if (runValue) breakdown['Run/near-run'] = runValue

  // -- Royal marriage: only the marriages a run has not already absorbed ---
  // A Run needs the trump K and Q to exist at all, so it consumes them and
  // only a *second* K+Q pays on top (#273 - see `scoreMelds`, which now
  // applies the same subtraction, and `pinochle_rules.md`'s Phase 3 note for
  // why the Royal Marriage is the one meld that works this way). A Double Run
  // consumes both copies of each and leaves nothing.
  //
  // The near-run estimate counts as one run in waiting for this purpose: it is
  // priced as though the missing card arrives, and a run that arrives would
  // take a K and a Q with it. #268 confirmed that branch was right all along
  // and it is unchanged here.
  const royalCount = Math.min(n(trump, 'K'), n(trump, 'Q'))
  const consumedByRun = runCount ? runCount : nearRun ? 1 : 0
  const extraRoyals = Math.max(0, royalCount - consumedByRun)
  const marriageValue = extraRoyals * ROYAL_MARRIAGE_VALUE
  // Cards inside the run were already claimed above; this takes any
  // King/Queen beyond it out of the leftover pool.
  claim(pool, trump, 'K', extraRoyals)
  claim(pool, trump, 'Q', extraRoyals)
  if (marriageValue) breakdown['Royal Marriage'] = marriageValue

  // -- Common marriage ----------------------------------------------------
  let commonValue = 0
  for (const suit of SUITS) {
    if (suit === trump) continue
    const cm = Math.min(n(suit, 'K'), n(suit, 'Q'))
    if (cm) {
      commonValue += cm * COMMON_MARRIAGE_VALUE
      claim(pool, suit, 'K', cm)
      claim(pool, suit, 'Q', cm)
    }
  }
  if (commonValue) breakdown['Common Marriage'] = commonValue

  // -- Dix -----------------------------------------------------------------
  const dixCount = n(trump, '9')
  if (dixCount) {
    breakdown['Dix'] = dixCount * DIX_VALUE
    claim(pool, trump, '9', dixCount)
  }

  // -- Pinochle / near-double-pinochle -------------------------------------
  const qsCount = n(Suit.Spades, 'Q')
  const jdCount = n(Suit.Diamonds, 'J')
  const pinCount = Math.min(qsCount, jdCount)
  const totalPieces = qsCount + jdCount
  let pinochleValue = 0

  if (pinCount === 2) {
    pinochleValue = PINOCHLE_DOUBLE_VALUE
    claim(pool, Suit.Spades, 'Q', 2)
    claim(pool, Suit.Diamonds, 'J', 2)
  } else if (totalPieces === 3) {
    pinochleValue = NEAR_DOUBLE_PINOCHLE_VALUE
    claim(pool, Suit.Spades, 'Q', qsCount)
    claim(pool, Suit.Diamonds, 'J', jdCount)
  } else if (pinCount === 1) {
    pinochleValue = PINOCHLE_SINGLE_VALUE
    claim(pool, Suit.Spades, 'Q', 1)
    claim(pool, Suit.Diamonds, 'J', 1)
  }
  if (pinochleValue) breakdown['Pinochle/near-double'] = pinochleValue

  // A Queen of Spades doing no marriage work is a freer pinochle card, so a
  // hand that holds a pinochle at all and has no King of Spades to pair
  // against gets a little more (#277). Once for the hand: the reason is about
  // the absent King, and there is only one absence however many Queens sit
  // behind it. `pinochleValue` is the "holds a pinochle" test rather than
  // `pinCount`, and the two agree - the near-double branch needs three of the
  // four pieces, which cannot be reached without at least one of each.
  let noKsBonus = 0
  if (pinochleValue && n(Suit.Spades, 'K') === 0) {
    noKsBonus = PINOCHLE_NO_KING_OF_SPADES_BONUS
    breakdown['Pinochle (no King of Spades)'] = noKsBonus
  }

  // -- Arounds ---------------------------------------------------------------
  let aroundValue = 0
  for (const [rank, base] of Object.entries(AROUND_VALUES) as ['A' | 'K' | 'Q' | 'J', number][]) {
    const c = Math.min(...SUITS.map((s) => n(s, rank)))
    if (c === 2) {
      aroundValue += base * AROUND_DOUBLE_MULTIPLIER
      for (const s of SUITS) claim(pool, s, rank, 2)
    } else if (c === 1) {
      aroundValue += base
      for (const s of SUITS) claim(pool, s, rank, 1)
    }
  }
  if (aroundValue) breakdown['Arounds'] = aroundValue

  const total =
    runValue + marriageValue + commonValue + dixCount * DIX_VALUE + pinochleValue + noKsBonus + aroundValue

  return { total, breakdown, pool }
}

export interface TrickPotentialResult {
  total: number
  breakdown: Record<string, number>
}

/**
 * What this hand can win with cards rather than with meld - the stage between
 * the Base Bid and the competitive adjustment (#277). Six lines, all additive,
 * all counted per card unless said otherwise:
 *
 *   +ACE_VALUE           per Ace, any suit
 *   +TRUMP_ACE_VALUE     per Ace of trump, ON TOP of the line above
 *   +EXTRA_TRUMP_VALUE   per trump card past TRUMP_LENGTH_BASELINE
 *   +PROTECTED_TEN_VALUE per non-trump 10 with both Aces of its suit in hand
 *   +LOOSE_KING_VALUE    per non-trump King with no Queen of its suit
 *   +LOOSE_QUEEN_VALUE   per non-trump Queen with no King of its suit
 *
 * A trump Ace collecting both Ace lines, and so being worth 40, is deliberate:
 * Paul kept the two as separate rules and the card really is doing two jobs -
 * it is a certain trick like any Ace, and it is the card that controls the
 * trump suit.
 *
 * "Not part of a marriage" is read exactly as Paul defined it: no matching K/Q
 * of the same suit anywhere in the hand. It is a property of the suit rather
 * than of the individual card, so K-K-Q of one suit pays the marriage and
 * nothing here - the spare King has a Queen behind it and is not loose by this
 * test. Arounds are not consulted: a King with no Queen of its suit is loose
 * whether or not it is also part of Kings Around, because the Around already
 * paid for a different thing.
 *
 * Trump honours are excluded from the last two lines because the Run and Royal
 * Marriage lines in the Base Bid have already priced them, and trump 10s from
 * the protected-10 line for the same reason.
 */
export function computeTrickPotential(hand: readonly Card[], trump: Suit): TrickPotentialResult {
  const breakdown: Record<string, number> = {}

  const aceCount = hand.filter((c) => c.rank === 'A').length
  if (aceCount) breakdown['Aces (flat, 20/ea)'] = aceCount * ACE_VALUE

  const trumpAces = handCount(hand, trump, 'A')
  if (trumpAces) breakdown['Ace of trump'] = trumpAces * TRUMP_ACE_VALUE

  const extraTrump = Math.max(0, suitLength(hand, trump) - TRUMP_LENGTH_BASELINE)
  if (extraTrump) breakdown['Trump length (beyond 4)'] = extraTrump * EXTRA_TRUMP_VALUE

  const protectedTens = hand.filter((c) => isProtectedTen(hand, trump, c)).length
  if (protectedTens) breakdown['10 behind both Aces'] = protectedTens * PROTECTED_TEN_VALUE

  let looseKings = 0
  let looseQueens = 0
  for (const suit of SUITS) {
    if (suit === trump) continue
    const kings = handCount(hand, suit, 'K')
    const queens = handCount(hand, suit, 'Q')
    if (kings && !queens) looseKings += kings
    if (queens && !kings) looseQueens += queens
  }
  if (looseKings) breakdown['Unmarried Kings'] = looseKings * LOOSE_KING_VALUE
  if (looseQueens) breakdown['Unmarried Queens'] = looseQueens * LOOSE_QUEEN_VALUE

  const total = Object.values(breakdown).reduce((sum, v) => sum + v, 0)
  return { total, breakdown }
}

export interface CompetitiveAdjustmentResult {
  value: number
  breakdown: Record<string, number>
}

/**
 * Score-context-driven adjustment on top of Base Bid, meant to protect
 * the FINAL score clearing the bid - not a hand-shape estimate.
 *
 *   +160 if: behind by 600+ points, OR the hand has a rare double-payoff
 *            shape (missing only the trump Ace for a Run, while already
 *            holding an Ace in each of the other 3 suits - landing that
 *            one card would complete BOTH the Run and Aces Around at once,
 *            worth pushing harder for)
 *   +100 if: within 300 of winning AND opponent is 500+ from winning
 *            (push to close the game out while they're far behind)
 *   +130 otherwise (baseline)
 */
export function computeCompetitiveAdjustment(
  hand: readonly Card[],
  trump: Suit,
  myScore = 0,
  oppScore = 0,
): CompetitiveAdjustmentResult {
  const breakdown: Record<string, number> = {}

  const missingRanks = RUN_RANKS.filter((r) => handCount(hand, trump, r) === 0)
  const nearRunMissingAce =
    missingRanks.length === 1 &&
    missingRanks[0] === 'A' &&
    RUN_RANKS.filter((r) => r !== 'A').every((r) => handCount(hand, trump, r) >= 1)
  const hasOther3Aces = SUITS.filter((s) => s !== trump && handCount(hand, s, 'A') >= 1).length === 3
  const doublePayoffShape = nearRunMissingAce && hasOther3Aces

  const behind600 = oppScore - myScore >= 600

  let value: number
  if (behind600 || doublePayoffShape) {
    value = 160
    breakdown['Competitive adj (behind 600+ / Run+AcesAround double-payoff)'] = value
  } else if (myScore >= GAME_WIN_SCORE - 300 && oppScore <= GAME_WIN_SCORE - 500) {
    value = 100
    breakdown['Competitive adj (closing out the game)'] = value
  } else {
    value = 130
    breakdown['Competitive adj (baseline)'] = value
  }

  return { value, breakdown }
}

export interface MaxBidResult {
  total: number
  breakdown: Record<string, number>
}

/**
 * Base Bid + trick potential + competitive adjustment = Max Bid (the ceiling),
 * before the 400-cap / >300-meld-uncap rule is applied. The three stages are
 * what the hand melds, what it takes, and what the scoreboard is asking for;
 * only the last of them is not about the cards.
 */
export function computeMaxBid(hand: readonly Card[], trump: Suit, myScore = 0, oppScore = 0): MaxBidResult {
  const { total: baseTotal, breakdown: baseBreakdown } = computeBaseBid(hand, trump)
  const { total: trickTotal, breakdown: trickBreakdown } = computeTrickPotential(hand, trump)
  const { value: adjTotal, breakdown: adjBreakdown } = computeCompetitiveAdjustment(hand, trump, myScore, oppScore)
  const breakdown = { ...baseBreakdown, ...trickBreakdown, ...adjBreakdown }
  return { total: baseTotal + trickTotal + adjTotal, breakdown }
}

/**
 * Bid ceiling for this hand/trump: 400 by default, uncapped (null) if
 * actual guaranteed meld (scoreMelds, not the padded Base Bid) exceeds 300.
 */
export function maxBid(hand: readonly Card[], trump: Suit): number | null {
  const { total: actualMeld } = scoreMelds(hand, trump)
  if (actualMeld > MAX_BID_MELD_THRESHOLD) return null
  return MAX_BID_DEFAULT
}

export function cappedBid(hand: readonly Card[], trump: Suit, baseBidValue: number): number {
  const cap = maxBid(hand, trump)
  if (cap === null) return baseBidValue
  return Math.min(baseBidValue, cap)
}

export interface BestBidResult {
  trump: Suit
  total: number
  breakdown: Record<string, number>
}

/**
 * Searches all 4 trump candidates, returns the best {trump, capped
 * ceiling, breakdown}. Ceiling = Base Bid + Competitive adjustment, then
 * the 400-cap / >300-meld-uncap rule is applied.
 */
export function bestBaseBid(hand: readonly Card[], myScore = 0, oppScore = 0): BestBidResult {
  let best: BestBidResult | null = null
  for (const t of SUITS) {
    const { total, breakdown } = computeMaxBid(hand, t, myScore, oppScore)
    const capped = cappedBid(hand, t, total)
    if (best === null || capped > best.total) {
      best = { trump: t, total: capped, breakdown }
    }
  }
  // SUITS always has 4 entries, so best is always assigned above.
  return best as BestBidResult
}

// -- Auction decision wrapper — given the current bid, the minimum legal
// raise, and the auction's running state, decide whether to open/raise/
// pass. Sits on top of bestBaseBid/maxBid above: those answer "what's this
// hand worth," this answers "given what's happened in the auction so far,
// do I act on that valuation." --------------------------------------------

export interface BidRecord {
  readonly player: PlayerIndex
  readonly amount: number
}

/**
 * Running state of the current auction, assembled by whatever drives the
 * bidding loop (see pinochle_engine.py's `Round._bidding_loop` for the
 * reference shape) and handed to chooseBid on each active player's turn.
 */
export interface AuctionContext {
  /** Has anyone bid yet this auction (as opposed to only passes so far)? */
  readonly everBid: boolean
  /** Passes seen so far, before this player's turn. */
  readonly passesSoFar: number
  /** Every bid placed this auction, in order. */
  readonly bidHistory: readonly BidRecord[]
  readonly dealer: PlayerIndex
  /** Cumulative game score per team, going into this round. */
  readonly scores: Record<TeamId, number>
  /** Players who have passed so far this auction. Used to detect when a
   * partner has passed so the remaining bidder knows to raise its floor to
   * `PARTNER_PASSED_FLOOR`. (This comment said 320 while the code said 321 —
   * the #177 disagreement. Naming the constant is what stops it recurring.) */
  readonly passedPlayers: readonly PlayerIndex[]
}

/**
 * Meld-only bid valuation for skill 1 (easy). Mirrors EasyPlayer's
 * approach from Python: uses actual `scoreMelds` (not speculative Base
 * Bid), adds a flat trick-point constant plus uniform noise, then applies
 * the minimal positional filter. No endgame protection, no partner-bid-count
 * tracking, no score-differential awareness — pure "meld value + guess".
 */
function meldOnlyBid(
  hand: readonly Card[],
  currentBid: number,
  minIncrement: number,
  context: AuctionContext,
): number | null {
  const bestMeldValue = Math.max(...SUITS.map((t) => scoreMelds(hand, t).total))
  const noise = (Math.random() * 2 - 1) * MELD_ONLY_BID_NOISE
  const ceiling = bestMeldValue + MELD_ONLY_TRICK_ESTIMATE + noise
  const nextBid = currentBid + minIncrement
  if (!context.everBid) {
    return ceiling >= OPENING_BID ? OPENING_BID : null
  }
  return nextBid <= ceiling ? nextBid : null
}

/**
 * Proficient bidding logic, built on Base Bid plus positional and
 * score-context rules. Falls back to the old coin-flip placeholder if
 * called without a context (keeps old call sites/tests working).
 *
 * @param skill Which `SKILL_PARAMS` slot to read `handValuation` and
 *   `bidPolicy` from. Defaults to `SHIPPED_SKILL`, which is what every seat in
 *   a real game plays; only `src/ab/` passes anything else.
 *   Defaults to 'hard' (base_bid, the current Proficient behavior).
 *
 * Decision tiers:
 *   - Endgame protection (#256), ahead of everything else and of both bid
 *     policies: my team is within 250 of going out and the opponents are
 *     more than 550 away, so pass the whole auction and bank the meld. The
 *     one exception opens at OPENING_BID to save a partner who is dealing.
 *   - No one has bid yet this auction:
 *     1. 3rd bidder (2 passes already, no one's bid) - open to deny the
 *        last player a cheap contract, but only on a hand that reaches
 *        THIRD_BIDDER_FLOOR (#255). This used to open on anything at all
 *        below a score of 800. The floor is 200, not OPENER_THRESHOLD, and
 *        the constant carries the A/B that says why.
 *     2. Otherwise, open only if the hand is worth the contract.
 *   - My team currently holds the bid:
 *     - Partner has already bid twice this auction - back off, they're
 *       carrying it.
 *     - Partner just raised over my own earlier bid - commit to
 *       PARTNER_RAISE_FLOOR (340) if my ceiling supports it, else back off.
 *       Never a ten-point nudge over one's own partner (#206).
 *     - Otherwise my own (or partner's) bid already stands - no need to
 *       raise myself.
 *   - The opponents currently hold the bid: raise to current + minIncrement
 *     if that's within my ceiling (relaxed to at least 330 once my partner
 *     has bid, since a partner bid is a signal worth backing), else pass.
 */
export function chooseBid(
  player: PlayerIndex,
  hand: readonly Card[],
  currentBid: number,
  minIncrement: number,
  context?: AuctionContext,
  skill: SkillLevel = SHIPPED_SKILL,
): number | null {
  if (context === undefined) {
    return Math.random() < 0.6 ? null : currentBid + minIncrement
  }

  if (SKILL_PARAMS[skill].handValuation === 'meld_only') {
    return meldOnlyBid(hand, currentBid, minIncrement, context)
  }

  const myTeam = teamOf(player)
  const opponentTeam = (1 - myTeam) as TeamId
  const myScore = context.scores[myTeam]
  const oppScore = context.scores[opponentTeam]

  const { trump, total: baseBid } = bestBaseBid(hand, myScore, oppScore)
  const cap = maxBid(hand, trump)
  const ceiling = cap === null ? baseBid : Math.min(baseBid, cap)

  const partner = partnerOf(player)
  const partnerIsDealer = partner === context.dealer
  const partnerPassed = context.passedPlayers.includes(partner)
  const partnerHasBid = context.bidHistory.some((b) => b.player === partner)

  // Endgame protection (#256) sits in front of every other bidding rule and in
  // front of both bid policies: when the trigger holds, `shouldBid` is never
  // consulted, because what the cards are worth has stopped being the
  // question. The default is to pass the *entire* auction — not merely decline
  // to open — on any hand, opening or over an opponent or over a partner, and
  // both seats on the team do it. If the dealer is an opponent the auction
  // passes out and they are stuck at `FORCED_BID`, which is the outcome this
  // rule is happy to buy.
  //
  // The single exception is a partner who is dealing, because then passing out
  // sticks *us* with a contract nobody chose. Reading only the one opponent is
  // a seat-order fact and not a simplification: the auction opens left of the
  // dealer and rotates clockwise (`initAuctionState`), so a partner-of-the-
  // dealer seat is `dealer + 2` and speaks second — after exactly one opponent
  // and before both the other opponent and the dealer. There is no later turn
  // at which this seat knows more, because to still be in the auction it would
  // have had to bid.
  //
  // This replaces the old dealer-protection tier outright — `partnerIsDealer
  // && myScore >= 850 && oppScore < 500`, open on anything — which it
  // supersedes on thresholds, adds the hand floor whose absence was half of
  // #255, and asks whether the opponent ahead of us actually passed rather
  // than assuming it.
  if (myScore >= ENDGAME_SCORE_FLOOR && oppScore < ENDGAME_OPP_SCORE_CAP) {
    const opponentHasBid = context.bidHistory.some((b) => teamOf(b.player) !== myTeam)
    const seatBeforeMe = ((player + 3) % 4) as PlayerIndex
    const rescueDealingPartner =
      partnerIsDealer &&
      !opponentHasBid &&
      context.passedPlayers.includes(seatBeforeMe) &&
      ceiling > ENDGAME_RESCUE_CEILING
    return rescueDealingPartner ? OPENING_BID : null
  }

  // When partner has already passed they cannot come back in (#93), so a bid
  // here is one this hand must carry alone — which means committing to
  // PARTNER_PASSED_FLOOR (320), the opener threshold itself (#180: reach it,
  // do not clear it). That raises the *bid floor*, not the hand's ceiling: the
  // ceiling still reflects what the cards are actually worth, so a hopeless
  // hand declines rather than being talked into a 320 it cannot make.
  const minBidAfterPartnerPass = Math.max(PARTNER_PASSED_FLOOR, currentBid + minIncrement)

  // "Is this hand worth committing to a contract at `level`?" — the single
  // question `OPENER_THRESHOLD` and `DEFENSIVE_PUSH_FLOOR` were each a crude
  // answer to (#114). On a `'distilled'` skill level it goes to the evaluator
  // fitted to 2000 measured rollout decisions, which sees the level being
  // committed to rather than only the hand's ceiling — the same 200-ceiling
  // hand is a different proposition at 310 than at 400, and a threshold on the
  // ceiling alone cannot express that. On a `'static'` level it is the old
  // comparison, passed in by the caller so the two rules stay side by side and
  // #115 can measure one against the other.
  const distilled = SKILL_PARAMS[skill].bidPolicy === 'distilled'
  const worthContract = (level: number, staticVerdict: boolean): boolean =>
    distilled
      ? shouldBid({
          hand,
          bid: level,
          ourScore: myScore,
          theirScore: oppScore,
          partnerHasBid,
          partnerHasPassed: partnerPassed,
        })
      : staticVerdict

  if (!context.everBid) {
    // One comparison, whether or not the partner has passed (#180). This read
    // `partnerPassed ? ceiling > OPENER_THRESHOLD : ceiling >= OPENER_THRESHOLD`
    // — the second place "a lone bidder must *clear* the threshold" was written
    // down, the first being PARTNER_PASSED_FLOOR itself. With that intent
    // retired the two branches say the same thing, so they are one. The level
    // being committed to still differs: a partner-passed seat opens at the
    // floor rather than at OPENING_BID.
    //
    // The level named here is the floor and nothing else, on purpose and not
    // for want of asking. #204 split "should I open" from "at what level" and
    // built `openingPolicy: 'walk'` to answer the second by stepping up while
    // the seat's own policy still liked the next rung; over 5000 pairs on each
    // of three seeds it lost 52-56 points per deal, and requiring more
    // confidence per rung only bought the loss back by declining to walk. The
    // arm was deleted by #221; the numbers stay in `web/README.md` under "What
    // the opener puts on the table". Re-opening the question means re-running
    // the measurement, not restoring the loop.
    const floorLevel = partnerPassed ? minBidAfterPartnerPass : OPENING_BID
    const opens = worthContract(floorLevel, ceiling >= OPENER_THRESHOLD)

    // 3rd bidder opens cheap — with a hand floor under it (#255).
    if (context.passesSoFar === 2) {
      if (myScore > 800) {
        return opens ? floorLevel : null
      }
      if (opens) return floorLevel
      // The positional arm: the seat's own policy has said the hand is not
      // worth a contract, and this used to put `OPENING_BID` on the table
      // anyway to deny the last player a cheap one. It still does — but only
      // on a hand that reaches `THIRD_BIDDER_FLOOR`, not on a lone 9.
      //
      // The floor is 200 rather than the house rule's 320 because the two were
      // measured against each other and 320 cost 57 points a deal; the reason
      // lives on `THIRD_BIDDER_FLOOR` and should be read before it is tidied
      // up to `OPENER_THRESHOLD`.
      //
      // Two things a reader should know before treating this as the whole of
      // #255's third path, because they are what the measurement found:
      //
      // The `!partnerPassed` half of this arm cannot be reached. `passesSoFar`
      // counts every pass of the auction and never resets, so `!everBid &&
      // passesSoFar === 2` means exactly two seats have spoken and both
      // passed. `auctionReducer` opens left of the dealer and advances one
      // seat at a time, so those two are `dealer + 1` and `dealer + 2`, this
      // seat is `dealer + 3`, and its partner is `dealer + 1` — already
      // passed, every time. Confirmed over 1162 arrivals at this tier in
      // headless games across `medium`/`hard`/`expert`: `partnerPassed` was
      // true on all 1162. So this floor guards a state the auction cannot
      // produce, and it changes no decision this engine makes today.
      //
      // It is kept rather than deleted as dead code, deliberately. The
      // seat-order argument above is a fact about `auctionReducer`'s rotation,
      // not about `chooseBid`, and if that rotation ever changes — a seat
      // allowed back into the auction, a different opening seat — deleting
      // this arm would silently reinstate opening-on-anything. The floored
      // branch is the cheap net; `biddingSim.test.ts`'s seat-order test is
      // what keeps the two in step.
      //
      // The live instance of #255's third path is Python's, where
      // `Player.choose_bid` has this tier with no hand check on either arm and
      // no partner condition, and it fires. That one moves in this commit too.
      if (partnerPassed) return null
      return ceiling >= THIRD_BIDDER_FLOOR ? OPENING_BID : null
    }

    // Normal opener threshold (4th bidder / dealer — partner has already
    // had their turn, so no pass-out protection needed).
    return opens ? floorLevel : null
  }

  // Someone has already bid this auction.
  const lastBidder = context.bidHistory[context.bidHistory.length - 1].player
  const bidIsOurs = teamOf(lastBidder) === myTeam

  if (bidIsOurs) {
    const partnerBidCount = context.bidHistory.filter((b) => b.player === partner).length
    const myOwnBids = context.bidHistory.filter((b) => b.player === player).map((b) => b.amount)

    if (partnerBidCount >= 2) return null // partner's carrying it, back off

    if (lastBidder === partner && myOwnBids.length > 0 && currentBid > myOwnBids[myOwnBids.length - 1]) {
      // Partner raised over my own earlier bid, so this seat is being asked
      // whether to bid over a contract its own team already holds. The ceiling
      // gate decides *whether* (#206 left it exactly where it was); the floor
      // decides *what*, and it is the same number, because a raise that cannot
      // reach PARTNER_RAISE_FLOOR is not worth making at all.
      if (ceiling < PARTNER_RAISE_FLOOR) return null
      return Math.max(PARTNER_RAISE_FLOOR, currentBid + minIncrement)
    }

    return null // our own bid already stands, no need to raise ourselves
  }

  // Opponent currently holds the bid.
  let competitiveCeiling = partnerHasBid ? Math.max(ceiling, 330) : ceiling
  if (cap !== null) {
    competitiveCeiling = Math.min(competitiveCeiling, cap)
  }

  const nextBid = currentBid + minIncrement

  // Defensive push (#78): when opponent opened at the minimum (OPENING_BID —
  // 300 again since #257), respond unless the hand is truly hopeless. The gate
  // is `currentBid <= OPENING_BID`, so it follows the opening rung wherever it
  // goes: it now fires on a bid of 300 and stops at 310, where last week it
  // fired at 250 and stopped at 260. One rung later in absolute terms, the
  // same rung relative to the auction. The static
  // rule is a ceiling floor (DEFENSIVE_PUSH_FLOOR) on the reasoning that the
  // opening rung is the absolute floor and is almost always raised — even a
  // moderate hand can contribute toward making it with partner's help, and
  // pushing deprives the opponent of a cheap contract. The distilled rule asks the evaluator about the level actually
  // being pushed to; declining here is not the end of the auction, it just
  // falls through to the ordinary raise ladder below.
  const pushLevel = partnerPassed ? Math.max(nextBid, PARTNER_PASSED_FLOOR) : nextBid
  if (currentBid <= OPENING_BID && worthContract(pushLevel, ceiling >= DEFENSIVE_PUSH_FLOOR)) {
    return pushLevel
  }

  // When partner passed, the bid must reach OPENER_THRESHOLD regardless of
  // ceiling — so PARTNER_PASSED_FLOOR (320), not the next rung of the ladder.
  if (partnerPassed && nextBid < PARTNER_PASSED_FLOOR) {
    return competitiveCeiling >= PARTNER_PASSED_FLOOR ? PARTNER_PASSED_FLOOR : null
  }
  return nextBid <= competitiveCeiling ? nextBid : null
}

/**
 * Uses the same per-suit Base Bid comparison as chooseBid, so trump
 * selection reflects real speculative hand strength rather than raw card
 * count. For skill 1 (easy), picks the suit with the highest actual meld.
 *
 * @param skill Which `SKILL_PARAMS` slot to read `handValuation` from —
 *   `'meld_only'` picks the highest-melding suit instead. Defaults to
 *   `SHIPPED_SKILL`.
 */
export function chooseTrump(hand: readonly Card[], skill: SkillLevel = SHIPPED_SKILL): Suit {
  if (SKILL_PARAMS[skill].handValuation === 'meld_only') {
    let best: Suit = Suit.Spades
    let bestValue = -1
    for (const t of SUITS) {
      const { total } = scoreMelds(hand, t)
      if (total > bestValue) {
        best = t
        bestValue = total
      }
    }
    return best
  }
  const { trump } = bestBaseBid(hand)
  return trump
}

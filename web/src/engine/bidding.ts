// Bidding — ported from pinochle_engine.py (frozen Python reference).
//
// Two layers. Valuation: computeBaseBid (guaranteed + speculative hand
// value) -> computeCompetitiveAdjustment (score-context) -> the 400-cap /
// >300-meld-uncap rule (maxBid / cappedBid). bestBaseBid searches all 4
// trump candidates and applies the cap to find the winning trump + ceiling.
// Decision: chooseBid/chooseTrump wrap that valuation with the stateful
// auction rules (dealer protection, 3rd-bidder-opens-cheap, when to raise
// vs. pass) - ported from Player.choose_bid / Player.choose_trump. This
// module only decides; it does not run an auction loop (that's a future
// Round orchestrator, see round.ts's module docstring).

import type { SkillLevel } from '../persistence/options'
import { type Card, GAME_WIN_SCORE, OPENING_BID, type Rank, Suit, SUITS } from './card'
import { shouldBid } from './evaluator'
import { MELD_ONLY_BID_NOISE, MELD_ONLY_TRICK_ESTIMATE, SKILL_PARAMS } from './skills'
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

// -- Base Bid — the hand-strength number bidding decisions are built on.
// Distinct from scoreMelds: this is a *speculative* valuation (near-run,
// near-double-pinochle, remaining-card trick-taking potential, partner
// estimate), not the actual guaranteed meld. ------------------------------

// These two are ported from pinochle_engine.py, which CLAUDE.md names the
// frozen reference implementation for this port. They read 60/60 here until
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
export const ACE_VALUE = 20
// Proficient AI draws randomly in this range each bid (partner-strength
// estimate). Not consumed by the pure valuation functions below — ported
// for parity with the Python constant block, same as there.
export const PARTNER_ESTIMATE_RANGE: readonly [number, number] = [50, 100]
export const MAX_BID_DEFAULT = 400
export const MAX_BID_MELD_THRESHOLD = 300

// -- The two static bidding thresholds. Both are guesses, and both are
// superseded by the fitted evaluator on every skill level whose `bidPolicy` is
// `'distilled'` (see skills.ts). They are NOT dead: `'static'` is still what
// proficient and expert run, until #115's A/B says which policy wins. Anything
// that reads them outside `chooseBid`'s static branch is reading a rule that
// half the dial no longer follows. ---------------------------------------

// Minimum Base Bid to justify opening at all.
export const OPENER_THRESHOLD = 320
// Minimum ceiling to justify a defensive push against an opening bid of 300.
// Hands at or above this floor should almost always raise a 300 opener,
// since even moderate hands can contribute toward making 300 with partner's
// help, and pushing deprives the opponent of a cheap contract. "Truly
// hopeless" hands (no meld, no aces — ceiling ~130) fall below this floor.
export const DEFENSIVE_PUSH_FLOOR = 200

/**
 * The bid a seat must commit to once its partner has passed (#93/#95).
 *
 * Not a ceiling like the two above — it is an actual bid, placed on the table,
 * and **bids move in tens**. That distinction is what #177 was: this was
 * written as `320 + 1` to encode "strictly above OPENER_THRESHOLD", which is
 * the right *intent* and an impossible *bid*. Once any seat bid 321 the whole
 * ladder went off-grid (331, 341, ...) and `BiddingControls` — which gates its
 * Bid button on `amount % 10 === 0` — displayed a minimum the human could not
 * reach with the +/- buttons.
 *
 * Why 330 and not 320. The rule this encodes is that a hand bidding alone must
 * *clear* the opener threshold, not merely equal it: with no partner left to
 * speak, the seat is buying the contract outright, so it should be worth more
 * than the hand that would open with help still to come. `chooseBid`'s static
 * verdict one tier up already says so in the other direction — it asks for
 * `ceiling > OPENER_THRESHOLD` when the partner has passed against
 * `ceiling >= OPENER_THRESHOLD` when they have not. 320 would make the floor
 * "at least 320", which collapses that distinction and makes the strict `>` on
 * the ceiling arbitrary. The next legal bid above 320 is 330.
 *
 * That settles what the rule *means*. It does not settle which value plays
 * better, and those turned out to differ: 320 measures ~10 points per deal
 * ahead of 330 over 5000 paired deals, replicated on four seeds (`web/README.md`,
 * "The partner-passed bid floor"). #177 is a legality fix and both candidates
 * are legal, so that is left as an open strategy question rather than settled
 * in passing by a bug fix.
 */
export const PARTNER_PASSED_FLOOR = 330

function handCount(hand: readonly Card[], suit: Suit, rank: Rank): number {
  return hand.reduce((count, c) => count + (c.suit === suit && c.rank === rank ? 1 : 0), 0)
}

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
 * Pure hand-value Base Bid: meld you have, plus the Run/Double-Pinochle
 * proximity bonuses, plus flat Ace value. Deliberately excludes
 * remaining-card trick-taking potential and partner estimate - those
 * live in computeCompetitiveAdjustment instead, since they're about
 * context/speculation rather than what the hand itself guarantees.
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

  // -- Royal marriage: only the "extra" (2nd) marriage beyond run/near-run
  const royalCount = Math.min(n(trump, 'K'), n(trump, 'Q'))
  let marriageValue = 0
  if (runValue > 0) {
    if (royalCount === 2) {
      marriageValue = ROYAL_MARRIAGE_VALUE
      claim(pool, trump, 'K', 1)
      claim(pool, trump, 'Q', 1)
    }
  } else {
    marriageValue = royalCount * ROYAL_MARRIAGE_VALUE
    claim(pool, trump, 'K', royalCount)
    claim(pool, trump, 'Q', royalCount)
  }
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

  // -- Aces, flat, ~2 tricks worth each -----------------------------------
  const aceCount = hand.filter((c) => c.rank === 'A').length
  const aceValue = aceCount * ACE_VALUE
  breakdown['Aces (flat, 20/ea)'] = aceValue

  // -- 3 different Aces bonus (near-Aces-Around, suit diversity) -----------
  const distinctAceSuits = SUITS.filter((s) => n(s, 'A') >= 1).length
  let threeAcesValue = 0
  if (distinctAceSuits === 3) {
    threeAcesValue = trump === Suit.Hearts || trump === Suit.Clubs ? 60 : 50
    breakdown['3 different Aces bonus'] = threeAcesValue
  }

  const total =
    runValue +
    marriageValue +
    commonValue +
    dixCount * DIX_VALUE +
    pinochleValue +
    aroundValue +
    aceValue +
    threeAcesValue

  return { total, breakdown, pool }
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
 * Base Bid + Competitive adjustment = Max Bid (the ceiling), before the
 * 400-cap / >300-meld-uncap rule is applied.
 */
export function computeMaxBid(hand: readonly Card[], trump: Suit, myScore = 0, oppScore = 0): MaxBidResult {
  const { total: baseTotal, breakdown: baseBreakdown } = computeBaseBid(hand, trump)
  const { value: adjTotal, breakdown: adjBreakdown } = computeCompetitiveAdjustment(hand, trump, myScore, oppScore)
  const breakdown = { ...baseBreakdown, ...adjBreakdown }
  return { total: baseTotal + adjTotal, breakdown }
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
   * partner has passed so the remaining bidder knows to raise the floor to
   * 320. */
  readonly passedPlayers: readonly PlayerIndex[]
}

/**
 * Meld-only bid valuation for skill 1 (easy). Mirrors EasyPlayer's
 * approach from Python: uses actual `scoreMelds` (not speculative Base
 * Bid), adds a flat trick-point constant plus uniform noise, then applies
 * the minimal positional filter. No dealer-protection, no partner-bid-count
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
 * @param skill Skill level from options — controls hand-valuation formula.
 *   Defaults to 'hard' (base_bid, the current Proficient behavior).
 *
 * Decision tiers:
 *   - No one has bid yet this auction:
 *     1. Dealer-protection: my partner is dealer and my score makes them
 *        a target for a "pass out and stick them with FORCED_BID" play -
 *        always open regardless of hand.
 *     2. 3rd bidder (2 passes already, no one's bid) - always open to
 *        deny the last player a cheap contract, unless my score is high
 *        enough (>800) that I'd rather play it safe and only open if the
 *        hand is worth the contract.
 *     3. Otherwise, open only if the hand is worth the contract.
 *   - My team currently holds the bid:
 *     - Partner has already bid twice this auction - back off, they're
 *       carrying it.
 *     - Partner just raised over my own earlier bid - match it if my
 *       ceiling supports at least 340, otherwise back off.
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
  skill: SkillLevel = 'hard',
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
  const partnerPassed = context.passedPlayers.includes(partner)
  const partnerHasBid = context.bidHistory.some((b) => b.player === partner)

  // When partner has already passed they cannot come back in (#93), so a bid
  // here is one this hand must carry alone — which means committing to
  // PARTNER_PASSED_FLOOR (330), the first legal bid clearing OPENER_THRESHOLD.
  // That raises the *bid floor*, not the hand's ceiling: the ceiling still
  // reflects what the cards are actually worth, so a hopeless hand declines
  // rather than being talked into a 330 it cannot make.
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
    // Dealer-protection, restored from `Player.choose_bid` by the #126 audit.
    // This tier was dropped in aeb97b3 — the same hand-port slip that took
    // NEAR_RUN_VALUE/NEAR_DOUBLE_PINOCHLE_VALUE to 60/60 (#118) — and replaced
    // with "the first two seats always open at 300 regardless of hand". Since
    // the auction starts with nobody having passed, that rule fired on the very
    // first seat of every deal, so the opener threshold below was effectively
    // unreachable and no opening decision was ever a hand judgement.
    const partnerIsDealer = partner === context.dealer
    if (partnerIsDealer && myScore >= 850 && oppScore < 500) {
      return OPENING_BID
    }

    // With partner passed the bid must clear OPENER_THRESHOLD (so, 330), so the
    // static rule wants the ceiling strictly above the opener threshold rather
    // than merely level with it. (Ceilings move in tens, so the two differ only
    // at exactly 320.)
    const openingLevel = partnerPassed ? minBidAfterPartnerPass : OPENING_BID
    const opens = worthContract(
      openingLevel,
      partnerPassed ? ceiling > OPENER_THRESHOLD : ceiling >= OPENER_THRESHOLD,
    )

    // 3rd bidder opens cheap.
    if (context.passesSoFar === 2) {
      if (myScore > 800) {
        return opens ? openingLevel : null
      }
      // Positional, not a hand judgement: with partner still to speak this
      // seat opens on anything to deny the last player a cheap contract, so
      // neither policy is consulted.
      return partnerPassed ? (opens ? openingLevel : null) : OPENING_BID
    }

    // Normal opener threshold (4th bidder / dealer — partner has already
    // had their turn, so no pass-out protection needed).
    return opens ? openingLevel : null
  }

  // Someone has already bid this auction.
  const lastBidder = context.bidHistory[context.bidHistory.length - 1].player
  const bidIsOurs = teamOf(lastBidder) === myTeam

  if (bidIsOurs) {
    const partnerBidCount = context.bidHistory.filter((b) => b.player === partner).length
    const myOwnBids = context.bidHistory.filter((b) => b.player === player).map((b) => b.amount)

    if (partnerBidCount >= 2) return null // partner's carrying it, back off

    if (lastBidder === partner && myOwnBids.length > 0 && currentBid > myOwnBids[myOwnBids.length - 1]) {
      // partner raised over my own earlier bid
      return ceiling < 340 ? null : currentBid + minIncrement
    }

    return null // our own bid already stands, no need to raise ourselves
  }

  // Opponent currently holds the bid.
  let competitiveCeiling = partnerHasBid ? Math.max(ceiling, 330) : ceiling
  if (cap !== null) {
    competitiveCeiling = Math.min(competitiveCeiling, cap)
  }

  const nextBid = currentBid + minIncrement

  // Defensive push (#78): when opponent opened at the minimum (300), respond
  // unless the hand is truly hopeless. The static rule is a ceiling floor
  // (DEFENSIVE_PUSH_FLOOR) on the reasoning that 300 is the absolute floor and
  // is almost always raised — even a moderate hand can contribute toward making
  // 300 with partner's help, and pushing deprives the opponent of a cheap
  // contract. The distilled rule asks the evaluator about the level actually
  // being pushed to; declining here is not the end of the auction, it just
  // falls through to the ordinary raise ladder below.
  const pushLevel = partnerPassed ? Math.max(nextBid, PARTNER_PASSED_FLOOR) : nextBid
  if (currentBid <= OPENING_BID && worthContract(pushLevel, ceiling >= DEFENSIVE_PUSH_FLOOR)) {
    return pushLevel
  }

  // When partner passed, the bid must clear OPENER_THRESHOLD regardless of
  // ceiling — so PARTNER_PASSED_FLOOR (330), not a bid one point over 320.
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
 * @param skill Skill level — controls trump selection formula. Defaults
 *   to 'hard' (base_bid, current Proficient behavior).
 */
export function chooseTrump(hand: readonly Card[], skill: SkillLevel = 'hard'): Suit {
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

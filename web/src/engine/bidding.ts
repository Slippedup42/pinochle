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

import { type Card, GAME_WIN_SCORE, OPENING_BID, type Rank, Suit, SUITS } from './card'
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

export const NEAR_RUN_VALUE = 120
export const NEAR_DOUBLE_PINOCHLE_VALUE = 225
export const ACE_VALUE = 20
// Proficient AI draws randomly in this range each bid (partner-strength
// estimate). Not consumed by the pure valuation functions below — ported
// for parity with the Python constant block, same as there.
export const PARTNER_ESTIMATE_RANGE: readonly [number, number] = [50, 100]
export const MAX_BID_DEFAULT = 400
export const MAX_BID_MELD_THRESHOLD = 300
// Minimum Base Bid to justify opening at all.
export const OPENER_THRESHOLD = 320

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
}

/**
 * Proficient bidding logic, built on Base Bid plus positional and
 * score-context rules. Falls back to the old coin-flip placeholder if
 * called without a context (keeps old call sites/tests working).
 *
 * Decision tiers:
 *   - No one has bid yet this auction:
 *     1. Dealer-protection: my partner is dealer and my score makes them
 *        a target for a "pass out and stick them with FORCED_BID" play -
 *        always open regardless of hand.
 *     2. 3rd bidder (2 passes already, no one's bid) - always open to
 *        deny the last player a cheap contract, unless my score is high
 *        enough (>800) that I'd rather play it safe and only open if my
 *        ceiling clears OPENER_THRESHOLD.
 *     3. Otherwise, open only if my ceiling clears OPENER_THRESHOLD.
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
): number | null {
  if (context === undefined) {
    return Math.random() < 0.6 ? null : currentBid + minIncrement
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

  if (!context.everBid) {
    // Dealer-protection.
    if (partnerIsDealer && myScore >= 850 && oppScore < 500) {
      return OPENING_BID
    }

    // 3rd bidder opens cheap.
    if (context.passesSoFar === 2) {
      if (myScore > 800) {
        return ceiling >= OPENER_THRESHOLD ? OPENING_BID : null
      }
      return OPENING_BID
    }

    // Normal opener threshold.
    return ceiling >= OPENER_THRESHOLD ? OPENING_BID : null
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
  const partnerHasBid = context.bidHistory.some((b) => b.player === partner)
  let effectiveCeiling = partnerHasBid ? Math.max(ceiling, 330) : ceiling
  if (cap !== null) {
    effectiveCeiling = Math.min(effectiveCeiling, cap)
  }

  const nextBid = currentBid + minIncrement
  return nextBid <= effectiveCeiling ? nextBid : null
}

/**
 * Uses the same per-suit Base Bid comparison as chooseBid, so trump
 * selection reflects real speculative hand strength rather than raw card
 * count.
 */
export function chooseTrump(hand: readonly Card[]): Suit {
  const { trump } = bestBaseBid(hand)
  return trump
}

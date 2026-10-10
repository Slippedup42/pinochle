// `pushPolicy`: a seat contesting an opponent's bid may bid past its own
// ceiling to push the opponent up a rung. `'off'` ships and must not move.

import { afterEach, describe, expect, it } from 'vitest'
import {
  type AuctionContext,
  bestBaseBid,
  chooseBid,
  PUSH_QUALITY_MAX_SLACK,
  pushQuality,
} from './bidding'
import { Card, type Rank, Suit } from './card'
import { SHIPPED_PARAMS, SHIPPED_SKILL, SKILL_PARAMS, type SkillParams } from './skills'

const H = Suit.Hearts
const C = Suit.Clubs
const D = Suit.Diamonds
const S = Suit.Spades

function hand(...specs: [Rank, Suit][]): Card[] {
  const seen = new Map<string, number>()
  return specs.map(([rank, suit]) => {
    const key = `${rank}${suit}`
    const copy = (seen.get(key) ?? 0) + 1
    seen.set(key, copy)
    return new Card(suit, rank, copy as 1 | 2)
  })
}

// Seven hearts and three Aces: a steady, long-trump hand (quality 1).
const STEADY = hand(
  ['A', H], ['A', H], ['10', H], ['K', H], ['Q', H], ['J', H], ['9', H],
  ['A', C], ['K', C], ['9', C],
  ['10', D], ['9', S],
)

// Four of each of two suits, no Ace: nothing long, nothing to take tricks with.
const FLAT = hand(
  ['K', H], ['Q', H], ['J', H], ['9', H],
  ['K', C], ['Q', C], ['J', C], ['9', C],
  ['K', D], ['Q', D], ['J', D], ['9', D],
)

function opponentHolds(currentBid: number, scores = { 0: 0, 1: 0 } as AuctionContext['scores']): AuctionContext {
  return {
    everBid: true,
    passesSoFar: 0,
    bidHistory: [{ player: 1, amount: currentBid }],
    dealer: 3,
    scores,
    passedPlayers: [],
  }
}

const restore: SkillParams = SKILL_PARAMS[SHIPPED_SKILL]
afterEach(() => {
  SKILL_PARAMS[SHIPPED_SKILL] = restore
})
function seat(pushPolicy: SkillParams['pushPolicy']) {
  SKILL_PARAMS[SHIPPED_SKILL] = { ...SHIPPED_PARAMS, pushPolicy }
}

describe('pushQuality', () => {
  it('is 1 for a long-trump Ace-heavy hand and 0 for a flat one', () => {
    expect(pushQuality(STEADY, H)).toBe(1)
    expect(pushQuality(FLAT, H)).toBe(0)
  })
})

describe('chooseBid with pushPolicy', () => {
  const { total } = bestBaseBid(STEADY)
  // Smallest standing bid whose next rung is strictly above the ceiling.
  const stand = Math.max(310, Math.floor(total / 10) * 10)
  const nextRung = stand + 10

  it('the fixture sits just under its ceiling, so the rule has something to decide', () => {
    expect(nextRung).toBeGreaterThan(total)
    expect(nextRung - total).toBeLessThanOrEqual(10)
  })

  it("'off' declines a rung above the ceiling - the shipped behaviour", () => {
    seat('off')
    expect(chooseBid(0, STEADY, stand, 10, opponentHolds(stand))).toBeNull()
  })

  it("'slack20' takes that rung, and declines one more than 20 past the ceiling", () => {
    seat('slack20')
    expect(chooseBid(0, STEADY, stand, 10, opponentHolds(stand))).toBe(nextRung)
    expect(chooseBid(0, STEADY, stand + 30, 10, opponentHolds(stand + 30))).toBeNull()
  })

  it("'slack40' reaches two rungs further than 'slack20'", () => {
    seat('slack40')
    expect(chooseBid(0, STEADY, stand + 20, 10, opponentHolds(stand + 20))).toBe(nextRung + 20)
    expect(chooseBid(0, STEADY, stand + 40, 10, opponentHolds(stand + 40))).toBeNull()
  })

  it("'quality' gives a steady hand the full lift and a flat hand none", () => {
    seat('quality')
    const steadyStand = stand + PUSH_QUALITY_MAX_SLACK - 10
    expect(chooseBid(0, STEADY, steadyStand, 10, opponentHolds(steadyStand))).toBe(steadyStand + 10)
    const flat = bestBaseBid(FLAT).total
    const flatStand = Math.max(310, Math.floor(flat / 10) * 10)
    expect(chooseBid(0, FLAT, flatStand, 10, opponentHolds(flatStand))).toBeNull()
  })

  it('never pushes when either team is within reach of going out', () => {
    seat('slack40')
    // The ceiling itself moves with the score (the competitive adjustment), so
    // the standing bid is re-derived at this score rather than reused.
    const nearOut = { 0: 0, 1: 760 } as AuctionContext['scores']
    const ceilingNear = bestBaseBid(STEADY, 0, 760).total
    const standNear = Math.max(310, Math.floor(ceilingNear / 10) * 10)
    expect(chooseBid(0, STEADY, standNear, 10, opponentHolds(standNear, nearOut))).toBeNull()
  })
})

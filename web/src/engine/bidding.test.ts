import { describe, expect, it } from 'vitest'
import { Card, Suit } from './card'
import {
  ACE_VALUE,
  bestBaseBid,
  cappedBid,
  computeBaseBid,
  computeCompetitiveAdjustment,
  computeMaxBid,
  maxBid,
  MAX_BID_DEFAULT,
  NEAR_RUN_VALUE,
} from './bidding'

const trump = Suit.Spades
const RUN_RANKS = ['A', '10', 'K', 'Q', 'J'] as const

describe('computeBaseBid', () => {
  it('scores a full trump Run at 150 plus its aces', () => {
    const hand = RUN_RANKS.map((r) => new Card(trump, r, 1))
    const { total, breakdown } = computeBaseBid(hand, trump)
    expect(breakdown['Run/near-run']).toBe(150)
    expect(breakdown['Aces (flat, 20/ea)']).toBe(ACE_VALUE)
    expect(total).toBe(150 + ACE_VALUE)
  })

  it('credits a near-run (missing exactly one rank) at 120', () => {
    const hand = RUN_RANKS.filter((r) => r !== 'J').map((r) => new Card(trump, r, 1))
    const { breakdown } = computeBaseBid(hand, trump)
    expect(breakdown['Run/near-run']).toBe(NEAR_RUN_VALUE)
  })

  it('does not credit near-run when missing two or more ranks', () => {
    const hand = [new Card(trump, 'A', 1), new Card(trump, '10', 1), new Card(trump, 'K', 1)]
    const { breakdown } = computeBaseBid(hand, trump)
    expect(breakdown['Run/near-run']).toBeUndefined()
  })

  it('scores a Double Run at 1500 and claims all cards from the pool', () => {
    const hand = RUN_RANKS.flatMap((r) => [new Card(trump, r, 1), new Card(trump, r, 2)])
    const { breakdown, pool } = computeBaseBid(hand, trump)
    expect(breakdown['Run/near-run']).toBe(1500)
    expect(pool).toHaveLength(0)
  })

  it('only credits the extra Royal Marriage once a Run/near-run is already counted', () => {
    // Full run + a spare K/Q pair (2nd marriage) -> +40 on top of the run.
    const hand = [
      ...RUN_RANKS.map((r) => new Card(trump, r, 1)),
      new Card(trump, 'K', 2),
      new Card(trump, 'Q', 2),
    ]
    const { breakdown } = computeBaseBid(hand, trump)
    expect(breakdown['Run/near-run']).toBe(150)
    expect(breakdown['Royal Marriage']).toBe(40)
  })

  it('credits the Royal Marriage at full value when there is no run at all', () => {
    const hand = [new Card(trump, 'K', 1), new Card(trump, 'Q', 1)]
    const { breakdown } = computeBaseBid(hand, trump)
    expect(breakdown['Royal Marriage']).toBe(40)
    expect(breakdown['Run/near-run']).toBeUndefined()
  })

  it('credits near-double-pinochle at 225 for 3 of the 4 pieces', () => {
    const hand = [
      new Card(Suit.Spades, 'Q', 1),
      new Card(Suit.Spades, 'Q', 2),
      new Card(Suit.Diamonds, 'J', 1),
    ]
    const { breakdown } = computeBaseBid(hand, Suit.Hearts)
    expect(breakdown['Pinochle/near-double']).toBe(225)
  })

  it('always includes the flat Aces line even at zero', () => {
    const hand = [new Card(Suit.Hearts, '9', 1)] // non-trump 9: no Dix, no melds at all
    const { breakdown, total } = computeBaseBid(hand, trump)
    expect(breakdown['Aces (flat, 20/ea)']).toBe(0)
    expect(total).toBe(0)
  })

  it('awards the 3-different-aces bonus at 50 for D/S trump and 60 for H/C trump', () => {
    const handWithoutTrumpAce = [
      new Card(Suit.Diamonds, 'A', 1),
      new Card(Suit.Clubs, 'A', 1),
      new Card(Suit.Hearts, 'A', 1),
    ]
    const { breakdown: spadesBreakdown } = computeBaseBid(handWithoutTrumpAce, Suit.Spades)
    expect(spadesBreakdown['3 different Aces bonus']).toBe(50)

    const handHC = [
      new Card(Suit.Spades, 'A', 1),
      new Card(Suit.Diamonds, 'A', 1),
      new Card(Suit.Clubs, 'A', 1),
    ]
    const { breakdown: heartsBreakdown } = computeBaseBid(handHC, Suit.Hearts)
    expect(heartsBreakdown['3 different Aces bonus']).toBe(60)
  })
})

describe('computeCompetitiveAdjustment', () => {
  it('defaults to the +130 baseline', () => {
    const { value, breakdown } = computeCompetitiveAdjustment([], trump)
    expect(value).toBe(130)
    expect(breakdown['Competitive adj (baseline)']).toBe(130)
  })

  it('gives +160 when behind by 600 or more', () => {
    const { value, breakdown } = computeCompetitiveAdjustment([], trump, 0, 600)
    expect(value).toBe(160)
    expect(breakdown['Competitive adj (behind 600+ / Run+AcesAround double-payoff)']).toBe(160)
  })

  it('gives +160 for the Run+AcesAround double-payoff shape even when not behind', () => {
    const hand = [
      new Card(trump, '10', 1),
      new Card(trump, 'K', 1),
      new Card(trump, 'Q', 1),
      new Card(trump, 'J', 1),
      new Card(Suit.Diamonds, 'A', 1),
      new Card(Suit.Clubs, 'A', 1),
      new Card(Suit.Hearts, 'A', 1),
    ]
    const { value } = computeCompetitiveAdjustment(hand, trump, 0, 0)
    expect(value).toBe(160)
  })

  it('gives +100 when close to winning and the opponent is far behind', () => {
    const { value, breakdown } = computeCompetitiveAdjustment([], trump, 750, 400)
    expect(value).toBe(100)
    expect(breakdown['Competitive adj (closing out the game)']).toBe(100)
  })
})

describe('maxBid / cappedBid', () => {
  it('caps at 400 when actual meld is 300 or below', () => {
    const hand = [new Card(trump, 'K', 1), new Card(trump, 'Q', 1)] // Royal Marriage = 40
    expect(maxBid(hand, trump)).toBe(MAX_BID_DEFAULT)
    expect(cappedBid(hand, trump, 900)).toBe(MAX_BID_DEFAULT)
  })

  it('uncaps (null) when actual guaranteed meld exceeds 300', () => {
    const hand = [
      new Card(Suit.Spades, 'Q', 1),
      new Card(Suit.Spades, 'Q', 2),
      new Card(Suit.Diamonds, 'J', 1),
      new Card(Suit.Diamonds, 'J', 2),
    ] // Double Pinochle = 300, not > 300
    expect(maxBid(hand, Suit.Hearts)).toBe(MAX_BID_DEFAULT)
  })

  it('leaves the bid unclamped below the cap', () => {
    const hand = [new Card(trump, 'K', 1)]
    expect(cappedBid(hand, trump, 350)).toBe(350)
  })
})

describe('bestBaseBid', () => {
  it('picks the trump suit with the highest capped ceiling', () => {
    const hand = [
      ...RUN_RANKS.map((r) => new Card(Suit.Hearts, r, 1)),
      new Card(Suit.Spades, '9', 1),
      new Card(Suit.Diamonds, '9', 1),
    ]
    const { trump: bestTrump } = bestBaseBid(hand)
    expect(bestTrump).toBe(Suit.Hearts)
  })

  it('matches computeMaxBid + cappedBid for the winning trump', () => {
    const hand = [new Card(Suit.Clubs, 'K', 1), new Card(Suit.Clubs, 'Q', 1), new Card(Suit.Diamonds, 'A', 1)]
    const { trump: bestTrump, total } = bestBaseBid(hand, 100, 50)
    const { total: rawTotal } = computeMaxBid(hand, bestTrump, 100, 50)
    expect(total).toBe(cappedBid(hand, bestTrump, rawTotal))
  })
})

import { describe, expect, it, vi } from 'vitest'
import { Card, OPENING_BID, Suit } from './card'
import {
  ACE_VALUE,
  type AuctionContext,
  bestBaseBid,
  cappedBid,
  chooseBid,
  chooseTrump,
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

describe('chooseTrump', () => {
  it('picks the same trump bestBaseBid would', () => {
    const hand = [
      ...RUN_RANKS.map((r) => new Card(Suit.Hearts, r, 1)),
      new Card(Suit.Spades, '9', 1),
      new Card(Suit.Diamonds, '9', 1),
    ]
    expect(chooseTrump(hand)).toBe(Suit.Hearts)
  })
})

describe('chooseBid', () => {
  // Weak hand: a lone off-trump 9. Ceiling stays well under
  // OPENER_THRESHOLD no matter which suit bestBaseBid picks as trump.
  const weakHand = [new Card(Suit.Hearts, '9', 1)]

  // Base Bid 170 (Run 150 + 1 Ace worth 20) -> ceiling 300 at the default
  // 0/0 score adjustment (+130 baseline). Below OPENER_THRESHOLD (320).
  const runOnlyHand = RUN_RANKS.map((r) => new Card(Suit.Hearts, r, 1))

  // Base Bid 210 (Run 150 + extra Royal Marriage 40 + Ace 20) -> ceiling
  // 340 at the default 0/0 adjustment (+130 baseline). Clears both
  // OPENER_THRESHOLD (320) and the 340 raise-support gate.
  const strongHand = [
    ...RUN_RANKS.map((r) => new Card(Suit.Hearts, r, 1)),
    new Card(Suit.Hearts, 'K', 2),
    new Card(Suit.Hearts, 'Q', 2),
  ]

  const baseContext = (overrides: Partial<AuctionContext> = {}): AuctionContext => ({
    everBid: false,
    passesSoFar: 0,
    bidHistory: [],
    dealer: 2,
    scores: { 0: 0, 1: 0 },
    ...overrides,
  })

  describe('without a context (fallback)', () => {
    it('passes when the coin flip lands under 0.6', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.1)
      expect(chooseBid(0, weakHand, 300, 10)).toBeNull()
      vi.restoreAllMocks()
    })

    it('raises by minIncrement when the coin flip lands at/over 0.6', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.9)
      expect(chooseBid(0, weakHand, 300, 10)).toBe(310)
      vi.restoreAllMocks()
    })
  })

  describe('no one has bid yet', () => {
    it('opens when the ceiling clears OPENER_THRESHOLD', () => {
      // Player 0's partner is player 2 (0<->2 seating); use dealer 1 so
      // dealer-protection (which keys off the partner being dealer)
      // doesn't fire here.
      const context = baseContext({ dealer: 1 })
      expect(chooseBid(0, strongHand, OPENING_BID - 10, 10, context)).toBe(OPENING_BID)
    })

    it('passes when the ceiling does not clear OPENER_THRESHOLD', () => {
      const context = baseContext({ dealer: 1 })
      expect(chooseBid(0, runOnlyHand, OPENING_BID - 10, 10, context)).toBeNull()
    })

    it('always opens (dealer-protection) when partner is dealer and my score is >= 850 with opponent under 500', () => {
      // Player 0's partner is player 2 (0<->2 seating).
      const context = baseContext({ dealer: 2, scores: { 0: 850, 1: 400 } })
      expect(chooseBid(0, weakHand, OPENING_BID - 10, 10, context)).toBe(OPENING_BID)
    })

    it('does not trigger dealer-protection when the opponent score is not under 500', () => {
      const context = baseContext({ dealer: 2, scores: { 0: 850, 1: 500 } })
      expect(chooseBid(0, weakHand, OPENING_BID - 10, 10, context)).toBeNull()
    })

    it('3rd bidder (2 passes so far) always opens cheap when my score is not above 800', () => {
      const context = baseContext({ dealer: 1, passesSoFar: 2, scores: { 0: 0, 1: 0 } })
      expect(chooseBid(0, weakHand, OPENING_BID - 10, 10, context)).toBe(OPENING_BID)
    })

    it('3rd bidder falls back to the normal threshold once my score is above 800', () => {
      // oppScore kept above 500 so the "closing out the game" competitive
      // adjustment bucket (+100) doesn't kick in and change the ceiling -
      // this test is purely about the passes_so_far===2 threshold gate.
      const context = baseContext({ dealer: 1, passesSoFar: 2, scores: { 0: 850, 1: 600 } })
      expect(chooseBid(0, weakHand, OPENING_BID - 10, 10, context)).toBeNull()
      expect(chooseBid(0, strongHand, OPENING_BID - 10, 10, context)).toBe(OPENING_BID)
    })
  })

  describe('my team currently holds the bid', () => {
    it('backs off once my partner has bid twice this auction', () => {
      const context = baseContext({
        everBid: true,
        bidHistory: [
          { player: 2, amount: 300 },
          { player: 1, amount: 310 },
          { player: 2, amount: 320 },
        ],
      })
      expect(chooseBid(0, strongHand, 320, 10, context)).toBeNull()
    })

    it('matches a partner raise over my own earlier bid when the ceiling supports it', () => {
      const context = baseContext({
        everBid: true,
        bidHistory: [
          { player: 0, amount: 300 },
          { player: 1, amount: 310 },
          { player: 2, amount: 320 },
        ],
      })
      expect(chooseBid(0, strongHand, 320, 10, context)).toBe(330)
    })

    it('backs off a partner raise over my own earlier bid when the ceiling does not support it', () => {
      const context = baseContext({
        everBid: true,
        bidHistory: [
          { player: 0, amount: 300 },
          { player: 1, amount: 310 },
          { player: 2, amount: 320 },
        ],
      })
      expect(chooseBid(0, weakHand, 320, 10, context)).toBeNull()
    })

    it('leaves its own standing bid alone (last bidder was me, not partner)', () => {
      const context = baseContext({
        everBid: true,
        bidHistory: [
          { player: 1, amount: 300 },
          { player: 0, amount: 310 },
        ],
      })
      expect(chooseBid(0, strongHand, 310, 10, context)).toBeNull()
    })
  })

  describe('the opponents currently hold the bid', () => {
    it('raises when the next bid is within my ceiling', () => {
      const context = baseContext({ everBid: true, bidHistory: [{ player: 1, amount: 300 }] })
      expect(chooseBid(0, strongHand, 300, 10, context)).toBe(310)
    })

    it('passes when the next bid exceeds my ceiling', () => {
      const context = baseContext({ everBid: true, bidHistory: [{ player: 1, amount: 300 }] })
      expect(chooseBid(0, runOnlyHand, 300, 10, context)).toBeNull()
    })

    it('relaxes the ceiling to at least 330 once my partner has bid', () => {
      const withoutPartnerBid = baseContext({ everBid: true, bidHistory: [{ player: 1, amount: 320 }] })
      expect(chooseBid(0, runOnlyHand, 320, 10, withoutPartnerBid)).toBeNull()

      const withPartnerBid = baseContext({
        everBid: true,
        bidHistory: [
          { player: 2, amount: 300 },
          { player: 1, amount: 320 },
        ],
      })
      expect(chooseBid(0, runOnlyHand, 320, 10, withPartnerBid)).toBe(330)
    })
  })
})

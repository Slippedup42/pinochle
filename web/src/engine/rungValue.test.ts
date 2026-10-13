// The rung-value model (`rungValue.ts`): what a raise is worth, and the
// decision it makes. The tables are fitted, so these tests pin the *shape* a
// sensible table has - holding a contract gets worse as the level rises,
// defending one gets better - and the decisions that follow from it, not the
// fitted numbers.

import { describe, expect, it } from 'vitest'
import { bestBaseBid, chooseBid, type AuctionContext } from './bidding'
import { Card, Deck, Suit } from './card'
import { RUN_RANKS } from './melds'
import {
  defendValue,
  rungDecision,
  rungFeatures,
  stopProbability,
  takeValue,
  thirdSeatOpens,
  thirdSeatScore,
} from './rungValue'
import { RUNG_FEATURES, RUNG_LEVELS } from './rungValueModel'
import { SHIPPED_SKILL, SKILL_PARAMS } from './skills'
import type { PlayerIndex } from './trick'

const H = Suit.Hearts

// Seven hearts, three Aces: long trump and tricks.
const STRONG = [
  ...RUN_RANKS.map((r) => new Card(H, r, 1)),
  new Card(H, 'A', 2),
  new Card(H, 'K', 2),
  new Card(Suit.Spades, 'A', 1),
  new Card(Suit.Clubs, 'A', 1),
  new Card(Suit.Clubs, 'K', 1),
]
// Nothing: no Ace, no meld, nine of nothing.
const WEAK = [
  new Card(H, '9', 1),
  new Card(H, 'J', 1),
  new Card(Suit.Clubs, '9', 1),
  new Card(Suit.Clubs, 'J', 1),
  new Card(Suit.Diamonds, '9', 1),
  new Card(Suit.Diamonds, 'J', 1),
  new Card(Suit.Spades, '9', 1),
  new Card(Suit.Spades, 'J', 1),
  new Card(Suit.Spades, 'Q', 1),
  new Card(Suit.Diamonds, 'K', 1),
  new Card(Suit.Clubs, 'Q', 1),
  new Card(H, 'Q', 2),
]

describe('rungFeatures', () => {
  it('has one entry per fitted feature, with the constant first', () => {
    const x = rungFeatures(STRONG, H)
    expect(x).toHaveLength(RUNG_FEATURES.length)
    expect(x[0]).toBe(1)
    // trump length, Aces, trump Aces
    expect(x[3]).toBe(RUN_RANKS.length + 2)
    expect(x[4]).toBe(4)
    expect(x[5]).toBe(2)
  })
})

describe('the fitted tables', () => {
  it('covers every level a raise can reach, in steps of ten', () => {
    expect(RUNG_LEVELS[0]).toBe(300)
    for (let i = 1; i < RUNG_LEVELS.length; i++) expect(RUNG_LEVELS[i] - RUNG_LEVELS[i - 1]).toBe(10)
  })

  it('holding a contract is worth less as the level rises, and defending one more', () => {
    for (const hand of [STRONG, WEAK]) {
      const x = rungFeatures(hand, H)
      for (let level = 300; level < 430; level += 10) {
        expect(takeValue(x, level + 10)).toBeLessThan(takeValue(x, level))
        expect(defendValue(x, level + 10)).toBeGreaterThan(defendValue(x, level))
      }
    }
  })

  it('interpolates between fitted levels and holds flat outside them', () => {
    const x = rungFeatures(STRONG, H)
    const mid = takeValue(x, 305)
    expect(mid).toBeLessThan(takeValue(x, 300))
    expect(mid).toBeGreaterThan(takeValue(x, 310))
    expect(takeValue(x, 200)).toBe(takeValue(x, 300))
    expect(defendValue(x, 900)).toBe(defendValue(x, 440))
  })

  it('stop probabilities are probabilities', () => {
    for (const level of RUNG_LEVELS) {
      const s = stopProbability(level)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(1)
    }
  })
})

describe('rungDecision', () => {
  it('raises on a strong hand and not on a hopeless one', () => {
    expect(rungDecision(STRONG, H, 320, 10).raise).toBe(true)
    expect(rungDecision(WEAK, H, 320, 10).raise).toBe(false)
  })

  it('stops climbing: a hand is not worth every rung', () => {
    // Once the level is far past anything the hand can carry, being stuck
    // costs more than the next rung takes from the opponent.
    let stoppedAt: number | null = null
    for (let current = 300; current < 460; current += 10) {
      if (!rungDecision(STRONG, H, current, 10).raise) {
        stoppedAt = current
        break
      }
    }
    expect(stoppedAt).not.toBeNull()
    expect(stoppedAt as number).toBeGreaterThan(330)
  })

  it('values a raise as the stop-weighted blend of holding and defending', () => {
    const d = rungDecision(STRONG, H, 340, 10)
    const x = rungFeatures(STRONG, H)
    const s = stopProbability(350)
    expect(d.level).toBe(350)
    expect(d.stop).toBe(s)
    expect(d.raiseValue).toBeCloseTo(s * takeValue(x, 350) + (1 - s) * defendValue(x, 360), 9)
    expect(d.passValue).toBeCloseTo(defendValue(x, 340), 9)
    expect(d.raise).toBe(d.raiseValue > d.passValue)
  })
})

describe('the third seat open', () => {
  it('opens on a strong hand and passes a hopeless one', () => {
    expect(thirdSeatOpens(STRONG, H)).toBe(true)
    expect(thirdSeatOpens(WEAK, H)).toBe(false)
  })

  it('scores a strong hand above a weak one', () => {
    expect(thirdSeatScore(STRONG, H)).toBeGreaterThan(thirdSeatScore(WEAK, H))
  })

  it('the model arm passes a hand the floor still opens', () => {
    const third: AuctionContext = {
      everBid: false,
      passesSoFar: 2,
      bidHistory: [],
      dealer: 1,
      scores: { 0: 0, 1: 0 },
      passedPlayers: [2, 3],
    }
    // The static opener, so the positional tier is what answers and not the
    // evaluator, which opens on its own judgement before the tier is reached.
    const saved = SKILL_PARAMS[SHIPPED_SKILL]
    try {
      SKILL_PARAMS[SHIPPED_SKILL] = { ...saved, bidPolicy: 'static', openingAnchor: 'floor', thirdSeatPolicy: 'model' }
      expect(chooseBid(0, STRONG, 290, 10, third)).toBeGreaterThanOrEqual(300)
      expect(chooseBid(0, WEAK, 290, 10, third)).toBeNull()
      // 2026-10-13: the floor ships again. It opens the same weak hand at 300,
      // which is the light open the AIs that act before a human no longer make
      // anywhere else, and the reason the model was rolled back.
      SKILL_PARAMS[SHIPPED_SKILL] = { ...saved, bidPolicy: 'static', openingAnchor: 'floor', thirdSeatPolicy: 'floor' }
      expect(chooseBid(0, WEAK, 290, 10, third)).toBe(300)
    } finally {
      SKILL_PARAMS[SHIPPED_SKILL] = saved
    }
  })
})

describe('chooseBid on the rung-value ladder', () => {
  const over = (amount: number): AuctionContext => ({
    everBid: true,
    passesSoFar: 0,
    bidHistory: [{ player: 1 as PlayerIndex, amount }],
    dealer: 3,
    scores: { 0: 0, 1: 0 },
    passedPlayers: [],
  })

  it('answers exactly one rung up, or passes, on every hand', () => {
    const real = Math.random
    let seed = 0x7a11e
    Math.random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    try {
      for (let i = 0; i < 150; i++) {
        const deck = new Deck()
        deck.shuffle()
        const hands = deck.deal()
        for (const standing of [310, 330, 360, 400]) {
          const out = chooseBid(0, hands[0], standing, 10, over(standing))
          if (out !== null) expect(out).toBe(standing + 10)
        }
      }
    } finally {
      Math.random = real
    }
  })

  it('does not ask a hand to carry a level far past its ceiling', () => {
    const { total } = bestBaseBid(WEAK, 0, 0)
    expect(total).toBeLessThan(300)
    expect(chooseBid(0, WEAK, 400, 10, over(400))).toBeNull()
  })
})

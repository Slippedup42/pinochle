import { describe, expect, it } from 'vitest'
import { Card, Suit } from './card'
import { isMisdealEligible, MISDEAL_NINE_THRESHOLD, nineCount } from './misdeal'

function nines(count: number, filler: Card[] = []): Card[] {
  const suits = [Suit.Spades, Suit.Diamonds, Suit.Clubs, Suit.Hearts]
  const nineCards: Card[] = []
  let suitIdx = 0
  let copy: 1 | 2 = 1
  for (let i = 0; i < count; i++) {
    nineCards.push(new Card(suits[suitIdx % 4], '9', copy))
    copy = copy === 1 ? 2 : 1
    if (copy === 1) suitIdx++
  }
  return [...nineCards, ...filler]
}

describe('nineCount', () => {
  it('counts only rank-9 cards, ignoring suit/copy', () => {
    expect(nineCount(nines(3))).toBe(3)
  })

  it('returns 0 for a hand with no nines', () => {
    const hand = [new Card(Suit.Spades, 'A', 1), new Card(Suit.Hearts, 'K', 2)]
    expect(nineCount(hand)).toBe(0)
  })
})

describe('isMisdealEligible', () => {
  it('is false below the threshold', () => {
    expect(isMisdealEligible(nines(MISDEAL_NINE_THRESHOLD - 1))).toBe(false)
  })

  it('is true at exactly the threshold', () => {
    expect(isMisdealEligible(nines(MISDEAL_NINE_THRESHOLD))).toBe(true)
  })

  it('is true above the threshold', () => {
    expect(isMisdealEligible(nines(MISDEAL_NINE_THRESHOLD + 1))).toBe(true)
  })
})

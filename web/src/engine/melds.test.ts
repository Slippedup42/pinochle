import { describe, expect, it } from 'vitest'
import { Card, Suit } from './card'
import { scoreMelds } from './melds'

const trump = Suit.Spades
const RUN_RANKS = ['A', '10', 'K', 'Q', 'J'] as const

describe('scoreMelds', () => {
  it('scores a Double Run at 1500, not Run + Run', () => {
    const hand = RUN_RANKS.flatMap((r) => [
      new Card(trump, r, 1),
      new Card(trump, r, 2),
    ])
    const { breakdown } = scoreMelds(hand, trump)
    expect(breakdown['Double Run']).toBe(1500)
    expect(breakdown['Run']).toBeUndefined()
  })

  it('scores a single Run at 150, not the double value', () => {
    const hand = RUN_RANKS.map((r) => new Card(trump, r, 1))
    const { breakdown } = scoreMelds(hand, trump)
    expect(breakdown['Run']).toBe(150)
    expect(breakdown['Double Run']).toBeUndefined()
  })

  it('scores Double Pinochle at 300, not 2x40', () => {
    const hand = [
      new Card(Suit.Spades, 'Q', 1),
      new Card(Suit.Spades, 'Q', 2),
      new Card(Suit.Diamonds, 'J', 1),
      new Card(Suit.Diamonds, 'J', 2),
    ]
    const { breakdown } = scoreMelds(hand, Suit.Hearts)
    expect(breakdown['Double Pinochle']).toBe(300)
    expect(breakdown['Pinochle']).toBeUndefined()
  })

  it('a trump King counts toward both Run and Royal Marriage', () => {
    const hand = [
      new Card(trump, 'A', 1),
      new Card(trump, '10', 1),
      new Card(trump, 'K', 1),
      new Card(trump, 'Q', 1),
      new Card(trump, 'J', 1),
    ]
    const { breakdown } = scoreMelds(hand, trump)
    expect(breakdown['Run']).toBe(150)
    expect(breakdown['Royal Marriage']).toBe(40)
  })

  it('scores a common (non-trump) marriage at 20', () => {
    const hand = [new Card(Suit.Hearts, 'K', 1), new Card(Suit.Hearts, 'Q', 1)]
    const { breakdown, total } = scoreMelds(hand, trump)
    expect(breakdown['Common Marriage']).toBe(20)
    expect(total).toBe(20)
  })

  it('scores Aces Around double at 1000, not 2x100', () => {
    const hand = [Suit.Spades, Suit.Diamonds, Suit.Clubs, Suit.Hearts].flatMap(
      (suit) => [new Card(suit, 'A', 1), new Card(suit, 'A', 2)],
    )
    const { breakdown } = scoreMelds(hand, trump)
    expect(breakdown['As Around (double)']).toBe(1000)
    expect(breakdown['As Around']).toBeUndefined()
  })

  it('returns zero total for a hand with no melds', () => {
    const hand = [
      new Card(Suit.Clubs, '9', 1),
      new Card(Suit.Hearts, '9', 1),
    ]
    const { total, breakdown } = scoreMelds(hand, Suit.Spades)
    expect(total).toBe(0)
    expect(breakdown).toEqual({})
  })
})

import { describe, expect, it } from 'vitest'
import { Card, Deck, RANKS, Suit } from './card'

describe('Deck', () => {
  it('builds 48 unique cards, two copies of each suit/rank', () => {
    const deck = new Deck()
    expect(deck.cards).toHaveLength(48)
    for (const suit of [Suit.Spades, Suit.Diamonds, Suit.Clubs, Suit.Hearts]) {
      for (const rank of RANKS) {
        const matches = deck.cards.filter(
          (c) => c.suit === suit && c.rank === rank,
        )
        expect(matches).toHaveLength(2)
        expect(matches.map((c) => c.copyId).sort()).toEqual([1, 2])
      }
    }
  })

  it('deals 12 cards to each of 4 hands and empties the deck', () => {
    const deck = new Deck()
    const hands = deck.deal()
    expect(hands).toHaveLength(4)
    for (const hand of hands) expect(hand).toHaveLength(12)
    expect(deck.cards).toHaveLength(0)
  })

  it('refuses to deal a deck that has already been dealt', () => {
    const deck = new Deck()
    deck.deal()
    expect(() => deck.deal()).toThrow()
  })
})

describe('Card.beats', () => {
  it('ranks 10 above King (non-standard order)', () => {
    const ten = new Card(Suit.Spades, '10', 1)
    const king = new Card(Suit.Spades, 'K', 1)
    expect(ten.beats(king, Suit.Hearts)).toBe(true)
    expect(king.beats(ten, Suit.Hearts)).toBe(false)
  })

  it('trump beats a non-trump card of a different suit', () => {
    const trumpNine = new Card(Suit.Hearts, '9', 1)
    const offSuitAce = new Card(Suit.Spades, 'A', 1)
    expect(trumpNine.beats(offSuitAce, Suit.Hearts)).toBe(true)
    expect(offSuitAce.beats(trumpNine, Suit.Hearts)).toBe(false)
  })

  it('a card cannot beat a different, non-trump suit', () => {
    const spadeAce = new Card(Suit.Spades, 'A', 1)
    const clubNine = new Card(Suit.Clubs, '9', 1)
    expect(spadeAce.beats(clubNine, Suit.Hearts)).toBe(false)
    expect(clubNine.beats(spadeAce, Suit.Hearts)).toBe(false)
  })
})

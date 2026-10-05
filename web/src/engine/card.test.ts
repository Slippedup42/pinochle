import { describe, expect, it } from 'vitest'
import { Card, Deck, RANKS, sortHandForDisplay, Suit } from './card'

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

describe('sortHandForDisplay', () => {
  it('groups by suit (Spades, Diamonds, Clubs, Hearts) then ranks A high to 9 low within each suit', () => {
    const hand = [
      new Card(Suit.Hearts, '9', 1),
      new Card(Suit.Clubs, 'A', 1),
      new Card(Suit.Spades, 'J', 1),
      new Card(Suit.Diamonds, '10', 1),
      new Card(Suit.Hearts, 'A', 1),
      new Card(Suit.Spades, 'A', 1),
    ]
    const sorted = sortHandForDisplay(hand)
    expect(sorted.map((c) => `${c.rank}${c.suit}`)).toEqual([
      'AS', 'JS', '10D', 'AC', 'AH', '9H',
    ])
  })

  describe('with a suit missing, keeps same-coloured suits apart where it can', () => {
    const order = (suits: Suit[]) =>
      sortHandForDisplay(suits.map((s) => new Card(s, 'A', 1)))
        .map((c) => c.suit)
        .join('')

    it('no Clubs: the Spades go between the Diamonds and the Hearts', () => {
      expect(order([Suit.Hearts, Suit.Spades, Suit.Diamonds])).toBe('DSH')
    })

    it('no Diamonds: the Hearts go between the Spades and the Clubs', () => {
      expect(order([Suit.Clubs, Suit.Hearts, Suit.Spades])).toBe('SHC')
    })

    it('leaves the already-alternating orders alone', () => {
      expect(order([Suit.Hearts, Suit.Clubs, Suit.Spades, Suit.Diamonds])).toBe('SDCH')
      expect(order([Suit.Clubs, Suit.Diamonds, Suit.Spades])).toBe('SDC') // no Hearts
      expect(order([Suit.Hearts, Suit.Clubs, Suit.Diamonds])).toBe('DCH') // no Spades
    })

    it('two or fewer suits: plain SUITS order, nothing to separate', () => {
      expect(order([Suit.Hearts, Suit.Diamonds])).toBe('DH')
      expect(order([Suit.Clubs, Suit.Spades])).toBe('SC')
      expect(order([Suit.Hearts])).toBe('H')
    })

    it('still sorts ranks high to low inside each rearranged suit', () => {
      const hand = [
        new Card(Suit.Diamonds, '9', 1),
        new Card(Suit.Hearts, 'A', 1),
        new Card(Suit.Spades, '10', 1),
        new Card(Suit.Diamonds, 'A', 1),
        new Card(Suit.Hearts, '9', 1),
        new Card(Suit.Spades, 'K', 1),
      ]
      expect(sortHandForDisplay(hand).map((c) => `${c.rank}${c.suit}`)).toEqual([
        'AD', '9D', '10S', 'KS', 'AH', '9H',
      ])
    })
  })

  it('does not mutate the input array', () => {
    const hand = [new Card(Suit.Hearts, '9', 1), new Card(Suit.Spades, 'A', 1)]
    const original = [...hand]
    sortHandForDisplay(hand)
    expect(hand).toEqual(original)
  })

  it('orders duplicate copies of the same suit/rank deterministically by copyId', () => {
    const hand = [
      new Card(Suit.Spades, 'A', 2),
      new Card(Suit.Spades, 'A', 1),
    ]
    expect(sortHandForDisplay(hand).map((c) => c.copyId)).toEqual([1, 2])
  })
})

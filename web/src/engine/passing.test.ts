import { describe, expect, it } from 'vitest'
import { Card, Suit } from './card'
import { bidderPassSelection, choosePassCards, partnerPassSelection } from './passing'

describe('partnerPassSelection', () => {
  it('D/S category: sends QS and JD to the bidder first', () => {
    const hand = [
      new Card(Suit.Spades, 'Q', 1),
      new Card(Suit.Diamonds, 'J', 1),
      new Card(Suit.Diamonds, 'K', 1),
      new Card(Suit.Hearts, '9', 1),
      new Card(Suit.Clubs, '9', 1),
    ]
    const chosen = partnerPassSelection(hand, Suit.Diamonds, 'DS', 2)
    expect(chosen).toHaveLength(2)
    expect(chosen.some((c) => c.suit === Suit.Spades && c.rank === 'Q')).toBe(true)
    expect(chosen.some((c) => c.suit === Suit.Diamonds && c.rank === 'J')).toBe(true)
  })

  it('H/C category: sends trump K/Q first (no QS/JD tier)', () => {
    const hand = [
      new Card(Suit.Hearts, 'K', 1),
      new Card(Suit.Hearts, 'Q', 1),
      new Card(Suit.Clubs, 'A', 1),
      new Card(Suit.Spades, '9', 1),
    ]
    const chosen = partnerPassSelection(hand, Suit.Hearts, 'HC', 1)
    expect(chosen).toHaveLength(1)
    expect(chosen[0].suit).toBe(Suit.Hearts)
    expect(['K', 'Q']).toContain(chosen[0].rank)
  })

  it('always returns exactly `count` cards, padding with a fallback tier', () => {
    const hand = [new Card(Suit.Clubs, '9', 1), new Card(Suit.Hearts, '9', 1), new Card(Suit.Spades, '9', 2)]
    const chosen = partnerPassSelection(hand, Suit.Diamonds, 'DS', 3)
    expect(chosen).toHaveLength(3)
  })
})

describe('bidderPassSelection', () => {
  it('protects trump cards, preferring safe non-trump filler', () => {
    const hand = [
      new Card(Suit.Spades, 'A', 1), // trump, protected
      new Card(Suit.Spades, 'K', 1), // trump, protected
      new Card(Suit.Hearts, '9', 1), // safe non-trump filler
      new Card(Suit.Clubs, '9', 1),
      new Card(Suit.Diamonds, '10', 1),
    ]
    const chosen = bidderPassSelection(hand, Suit.Spades, 'DS', 1)
    expect(chosen).toHaveLength(1)
    expect(chosen[0].suit).not.toBe(Suit.Spades)
  })

  it('H/C pro move (Queens Around + Pinochle + a trump run card) withholds QS/JD', () => {
    const hand = [
      new Card(Suit.Hearts, 'Q', 1), // trump Q -> Queens Around piece + run card
      new Card(Suit.Spades, 'Q', 1), // Queens Around piece + Pinochle piece
      new Card(Suit.Diamonds, 'Q', 1), // Queens Around piece
      new Card(Suit.Clubs, 'Q', 1), // Queens Around piece
      new Card(Suit.Diamonds, 'J', 1), // Pinochle piece
      new Card(Suit.Clubs, '9', 1), // safe filler
    ]
    const chosen = bidderPassSelection(hand, Suit.Hearts, 'HC', 1)
    expect(chosen.some((c) => c.suit === Suit.Spades && c.rank === 'Q')).toBe(false)
    expect(chosen.some((c) => c.suit === Suit.Diamonds && c.rank === 'J')).toBe(false)
  })

  it('without the pro move, H/C still sends QS/JD first', () => {
    const hand = [new Card(Suit.Spades, 'Q', 1), new Card(Suit.Diamonds, 'J', 1), new Card(Suit.Clubs, '9', 1)]
    const chosen = bidderPassSelection(hand, Suit.Hearts, 'HC', 1)
    expect(chosen).toHaveLength(1)
    const c = chosen[0]
    const isPinochlePiece = (c.suit === Suit.Spades && c.rank === 'Q') || (c.suit === Suit.Diamonds && c.rank === 'J')
    expect(isPinochlePiece).toBe(true)
  })

  it('never passes an Ace unless every other tier is exhausted', () => {
    const hand = [new Card(Suit.Diamonds, 'A', 1), new Card(Suit.Clubs, '9', 1)]
    const chosen = bidderPassSelection(hand, Suit.Spades, 'DS', 1)
    expect(chosen[0].rank).not.toBe('A')
  })
})

describe('choosePassCards', () => {
  it('falls back to a random sample when trumpSuit/isBidWinner are omitted', () => {
    const hand = [
      new Card(Suit.Spades, 'A', 1),
      new Card(Suit.Diamonds, 'K', 1),
      new Card(Suit.Clubs, '9', 1),
      new Card(Suit.Hearts, 'J', 1),
    ]
    const chosen = choosePassCards(hand, 3)
    expect(chosen).toHaveLength(3)
    for (const c of chosen) expect(hand).toContain(c)
  })

  it('dispatches to bidderPassSelection / partnerPassSelection based on isBidWinner', () => {
    const hand = [
      new Card(Suit.Spades, 'A', 1),
      new Card(Suit.Spades, 'K', 1),
      new Card(Suit.Hearts, '9', 1),
      new Card(Suit.Clubs, '9', 1),
    ]
    const asBidder = choosePassCards(hand, 2, Suit.Spades, true)
    const asPartner = choosePassCards(hand, 2, Suit.Spades, false)
    expect(asBidder).toEqual(bidderPassSelection(hand, Suit.Spades, 'DS', 2))
    expect(asPartner).toEqual(partnerPassSelection(hand, Suit.Spades, 'DS', 2))
  })

  it('returns exactly `count` cards for a full 12-card hand', () => {
    const suits = [Suit.Spades, Suit.Diamonds, Suit.Clubs, Suit.Hearts]
    const ranks = ['9', 'J', 'Q', 'K', '10', 'A'] as const
    const hand = suits.flatMap((s) => ranks.map((r) => new Card(s, r, 1)))
    expect(choosePassCards(hand, 3, Suit.Spades, true)).toHaveLength(3)
    expect(choosePassCards(hand, 3, Suit.Spades, false)).toHaveLength(3)
  })
})

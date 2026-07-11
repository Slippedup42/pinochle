import { describe, expect, it } from 'vitest'
import { Card, Suit } from './card'
import { Trick } from './trick'

describe('Trick.legalMoves', () => {
  it('leading: any card in hand is legal', () => {
    const trick = new Trick(Suit.Hearts)
    const hand = [
      new Card(Suit.Spades, 'A', 1),
      new Card(Suit.Clubs, '9', 1),
    ]
    expect(trick.legalMoves(hand)).toEqual(hand)
  })

  it('must follow lead suit and beat the best one on the table if able', () => {
    const trick = new Trick(Suit.Hearts) // trump irrelevant here
    trick.play(0, new Card(Suit.Spades, 'K', 1))

    const hand = [
      new Card(Suit.Spades, '10', 1), // beats King
      new Card(Suit.Spades, 'J', 1), // does not beat King
      new Card(Suit.Clubs, 'A', 1),
    ]
    const legal = trick.legalMoves(hand)
    expect(legal).toEqual([hand[0]])
  })

  it('must follow lead suit even without a beater, if no beater exists', () => {
    const trick = new Trick(Suit.Hearts)
    trick.play(0, new Card(Suit.Spades, 'A', 1)) // unbeatable in-suit

    const hand = [
      new Card(Suit.Spades, 'J', 1),
      new Card(Suit.Spades, '9', 1),
      new Card(Suit.Clubs, 'A', 1),
    ]
    const legal = trick.legalMoves(hand)
    expect(legal).toEqual([hand[0], hand[1]])
  })

  it('must play trump if void in lead suit and holding trump', () => {
    const trick = new Trick(Suit.Hearts)
    trick.play(0, new Card(Suit.Spades, 'A', 1))

    const hand = [
      new Card(Suit.Hearts, '9', 1),
      new Card(Suit.Clubs, 'A', 1),
    ]
    const legal = trick.legalMoves(hand)
    expect(legal).toEqual([hand[0]])
  })

  it('must beat the best trump on the table if able, when trumping in', () => {
    const trick = new Trick(Suit.Hearts)
    trick.play(0, new Card(Suit.Spades, 'A', 1))
    trick.play(1, new Card(Suit.Hearts, 'Q', 1))

    const hand = [
      new Card(Suit.Hearts, 'K', 1), // beats Queen
      new Card(Suit.Hearts, '9', 1), // does not beat Queen
    ]
    const legal = trick.legalMoves(hand)
    expect(legal).toEqual([hand[0]])
  })

  it('may sluff anything when void in both lead suit and trump', () => {
    const trick = new Trick(Suit.Hearts)
    trick.play(0, new Card(Suit.Spades, 'A', 1))

    const hand = [
      new Card(Suit.Clubs, '9', 1),
      new Card(Suit.Diamonds, 'J', 1),
    ]
    expect(trick.legalMoves(hand)).toEqual(hand)
  })
})

describe('Trick.winner', () => {
  it('highest trump wins over any lead-suit card', () => {
    const trick = new Trick(Suit.Hearts)
    trick.play(0, new Card(Suit.Spades, 'A', 1))
    trick.play(1, new Card(Suit.Hearts, '9', 1))
    trick.play(2, new Card(Suit.Spades, '10', 1))
    trick.play(3, new Card(Suit.Clubs, 'K', 1))
    expect(trick.winner()).toBe(1)
  })

  it('highest lead-suit card wins when no trump was played', () => {
    const trick = new Trick(Suit.Hearts)
    trick.play(0, new Card(Suit.Spades, 'Q', 1))
    trick.play(1, new Card(Suit.Clubs, 'A', 1)) // off-suit, doesn't count
    trick.play(2, new Card(Suit.Spades, 'A', 1))
    trick.play(3, new Card(Suit.Spades, 'J', 1))
    expect(trick.winner()).toBe(2)
  })

  it('a tie between identical cards goes to whichever copy was played first', () => {
    const trick = new Trick(Suit.Hearts)
    trick.play(0, new Card(Suit.Spades, 'A', 1))
    trick.play(1, new Card(Suit.Spades, 'A', 2)) // same rank/suit, second copy
    trick.play(2, new Card(Suit.Spades, '9', 1))
    trick.play(3, new Card(Suit.Spades, 'J', 1))
    expect(trick.winner()).toBe(0)
  })
})

describe('Trick.points', () => {
  it('counts Ace/10/King at 10 each, Queen/Jack/9 at 0', () => {
    const trick = new Trick(Suit.Hearts)
    trick.play(0, new Card(Suit.Spades, 'A', 1))
    trick.play(1, new Card(Suit.Spades, '10', 1))
    trick.play(2, new Card(Suit.Spades, 'K', 1))
    trick.play(3, new Card(Suit.Spades, 'Q', 1))
    expect(trick.points()).toBe(30)
  })

  it('a trick of all non-point cards scores 0', () => {
    const trick = new Trick(Suit.Hearts)
    trick.play(0, new Card(Suit.Spades, 'Q', 1))
    trick.play(1, new Card(Suit.Spades, 'J', 1))
    trick.play(2, new Card(Suit.Spades, '9', 1))
    trick.play(3, new Card(Suit.Clubs, 'Q', 1))
    expect(trick.points()).toBe(0)
  })
})

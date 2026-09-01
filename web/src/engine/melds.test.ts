import { describe, expect, it } from 'vitest'
import { Card, Suit } from './card'
import { extractMeldCards, scoreMelds } from './melds'

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

  // -- the Run/Royal-Marriage rule (#273) ------------------------------------
  //
  // The rule Paul ruled on 2026-08-31: a meld scores on top of a Run only if it
  // requires at least one card the Run does not use. The Royal Marriage is the
  // unique meld that fails that test, because you must hold the trump K and Q
  // to have a Run at all. A Pinochle needs the Q(S) or the J(D), one of which
  // is always outside the run; an Around needs three cards in other suits; the
  // Dix needs the trump 9, which is never in a run. This scorer paid the
  // absorbed marriage for the life of the project, so all three numbers below
  // are assertions of the rule and not records of what the code does.

  it('scores a bare trump Run at exactly 150, not 190', () => {
    // The rule: the Run consumes the trump K and Q it needs to exist, so the
    // marriage inside it is not a second meld.
    const hand = [
      new Card(trump, 'A', 1),
      new Card(trump, '10', 1),
      new Card(trump, 'K', 1),
      new Card(trump, 'Q', 1),
      new Card(trump, 'J', 1),
    ]
    const { breakdown, total } = scoreMelds(hand, trump)
    expect(breakdown['Run']).toBe(150)
    expect(breakdown['Royal Marriage']).toBeUndefined()
    expect(total).toBe(150)
  })

  it('scores a Run plus a second trump K+Q at exactly 190', () => {
    // The rule's other half: a second marriage needs a second King and a second
    // Queen, which the Run has not used, so it pays. One marriage, not two.
    const hand = [
      new Card(trump, 'A', 1),
      new Card(trump, '10', 1),
      new Card(trump, 'K', 1),
      new Card(trump, 'Q', 1),
      new Card(trump, 'J', 1),
      new Card(trump, 'K', 2),
      new Card(trump, 'Q', 2),
    ]
    const { breakdown, total } = scoreMelds(hand, trump)
    expect(breakdown['Run']).toBe(150)
    expect(breakdown['Royal Marriage']).toBe(40)
    expect(total).toBe(190)
  })

  it('scores a Double Run at exactly 1500, with no marriage left over', () => {
    // The rule worked out to its end: a Double Run uses both copies of the
    // trump King and both of the Queen, so no K+Q pair survives outside it.
    // 1500 flat — not 1540, and not the 1580 the scorer paid before #273.
    const hand = RUN_RANKS.flatMap((r) => [
      new Card(trump, r, 1),
      new Card(trump, r, 2),
    ])
    const { breakdown, total } = scoreMelds(hand, trump)
    expect(breakdown['Double Run']).toBe(1500)
    expect(breakdown['Royal Marriage']).toBeUndefined()
    expect(total).toBe(1500)
  })

  it('agrees with extractMeldCards, which had the rule right first', () => {
    // `extractMeldCards` drives the face-up meld display and has always skipped
    // the K/Q pair the Run consumes, so before #273 a player looking at a bare
    // run saw one group worth 150 while the round summary credited 190. Same
    // rule now, same total, in the two places a player can see it.
    const hand = [
      new Card(trump, 'A', 1),
      new Card(trump, '10', 1),
      new Card(trump, 'K', 1),
      new Card(trump, 'Q', 1),
      new Card(trump, 'J', 1),
      new Card(trump, 'K', 2),
      new Card(trump, 'Q', 2),
    ]
    const { groups } = extractMeldCards(hand, trump)
    const shown = groups.reduce((sum, g) => sum + g.points, 0)
    expect(shown).toBe(scoreMelds(hand, trump).total)
    expect(shown).toBe(190)
  })

  it('still pays every other meld the Run overlaps, because each needs a card outside it', () => {
    // The general rule the Royal Marriage is the exception to. Spades trump, so
    // the run's own Q(S) is also half a Pinochle and one of four Queens - both
    // of which reach outside the run for the rest of their cards, so both pay.
    const hand = [
      new Card(Suit.Spades, 'A', 1),
      new Card(Suit.Spades, '10', 1),
      new Card(Suit.Spades, 'K', 1),
      new Card(Suit.Spades, 'Q', 1),
      new Card(Suit.Spades, 'J', 1),
      new Card(Suit.Spades, '9', 1),
      new Card(Suit.Diamonds, 'J', 1),
      new Card(Suit.Diamonds, 'Q', 1),
      new Card(Suit.Hearts, 'Q', 1),
      new Card(Suit.Clubs, 'Q', 1),
    ]
    const { breakdown } = scoreMelds(hand, Suit.Spades)
    expect(breakdown['Run']).toBe(150)
    expect(breakdown['Royal Marriage']).toBeUndefined()
    expect(breakdown['Pinochle']).toBe(40) // needs the J(D), outside the run
    expect(breakdown['Qs Around']).toBe(60) // needs three Queens in other suits
    expect(breakdown['Dix']).toBe(10) // the trump 9 is never in a run
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

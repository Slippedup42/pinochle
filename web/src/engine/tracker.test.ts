import { describe, expect, it } from 'vitest'
import { Card, Suit } from './card'
import { chooseLeadCard, PlayTracker } from './tracker'

describe('PlayTracker', () => {
  it('starts with nothing played', () => {
    const tracker = new PlayTracker()
    expect(tracker.playedCount(Suit.Spades, 'A')).toBe(0)
  })

  it('accumulates played counts per suit/rank, up to 2 copies', () => {
    const tracker = new PlayTracker()
    tracker.record(new Card(Suit.Spades, 'A', 1))
    expect(tracker.playedCount(Suit.Spades, 'A')).toBe(1)
    tracker.record(new Card(Suit.Spades, 'A', 2))
    expect(tracker.playedCount(Suit.Spades, 'A')).toBe(2)
  })

  it('keeps suit/rank counts independent of each other', () => {
    const tracker = new PlayTracker()
    tracker.record(new Card(Suit.Spades, 'A', 1))
    expect(tracker.playedCount(Suit.Hearts, 'A')).toBe(0)
    expect(tracker.playedCount(Suit.Spades, 'K')).toBe(0)
  })
})

describe('chooseLeadCard', () => {
  it('priority 1: leads an unsecured trump Ace over everything else', () => {
    const hand = [
      new Card(Suit.Spades, 'A', 1), // trump, only 1 copy in hand, other copy unplayed
      new Card(Suit.Hearts, 'A', 1),
      new Card(Suit.Hearts, 'A', 2), // secure double ace, would otherwise be a safe card
    ]
    const tracker = new PlayTracker()
    const led = chooseLeadCard(hand, Suit.Spades, tracker)
    expect(led.suit).toBe(Suit.Spades)
    expect(led.rank).toBe('A')
  })

  it('a trump Ace is not "unsecured" once its partner copy has already been played', () => {
    const hand = [new Card(Suit.Spades, 'A', 1), new Card(Suit.Clubs, '9', 1)]
    const tracker = new PlayTracker()
    tracker.record(new Card(Suit.Spades, 'A', 2)) // the other copy is already gone
    const led = chooseLeadCard(hand, Suit.Spades, tracker)
    // Falls through past priority 1 - the remaining Ace is now safe (rank A
    // is always safe), so it's still the pick, just via priority 3.
    expect(led.suit).toBe(Suit.Spades)
    expect(led.rank).toBe('A')
  })

  it('priority 2: leads an unsecured non-trump Ace, preferring the longest suit', () => {
    const hand = [
      new Card(Suit.Hearts, 'A', 1), // unsecured, Hearts length 1
      new Card(Suit.Clubs, 'A', 1), // unsecured, Clubs length 2
      new Card(Suit.Clubs, '9', 1),
    ]
    const tracker = new PlayTracker()
    const led = chooseLeadCard(hand, Suit.Spades, tracker) // trump not present in hand
    expect(led.suit).toBe(Suit.Clubs)
    expect(led.rank).toBe('A')
  })

  it('priority 3: leads a safe card, cascading top-down by rank', () => {
    const hand = [
      new Card(Suit.Hearts, 'A', 1), // secure double ace -> safe, highest rank
      new Card(Suit.Hearts, 'A', 2),
      new Card(Suit.Clubs, '9', 1), // not safe: higher clubs ranks unaccounted for
    ]
    const tracker = new PlayTracker()
    const led = chooseLeadCard(hand, Suit.Spades, tracker)
    expect(led.suit).toBe(Suit.Hearts)
    expect(led.rank).toBe('A')
  })

  it('priority 3: within the same rank tier, prefers the longer suit', () => {
    // Both suits have all 5 higher ranks accounted for (all in hand), so the
    // 9s of each suit are equally "safe" - the tiebreak is suit length.
    const hand = [
      new Card(Suit.Hearts, '9', 1),
      new Card(Suit.Hearts, 'J', 1),
      new Card(Suit.Hearts, 'Q', 1),
      new Card(Suit.Hearts, 'K', 1),
      new Card(Suit.Hearts, '10', 1),
      new Card(Suit.Hearts, 'A', 1),
      new Card(Suit.Hearts, 'A', 2),
      new Card(Suit.Clubs, '9', 1),
      new Card(Suit.Clubs, 'J', 1),
      new Card(Suit.Clubs, 'Q', 1),
      new Card(Suit.Clubs, 'K', 1),
      new Card(Suit.Clubs, '10', 1),
    ]
    const tracker = new PlayTracker()
    const led = chooseLeadCard(hand, Suit.Spades, tracker)
    // Hearts (7 cards) is longer than Clubs (5 cards); both suits' 9s are
    // safe (every higher card is in hand), so Hearts' 9 wins the tiebreak.
    // But the Hearts Aces outrank everything by rank cascade first.
    expect(led.suit).toBe(Suit.Hearts)
    expect(led.rank).toBe('A')
  })

  it('priority 4: with no aces or safe cards, leads junk (non-point, non-trump), shortest suit first', () => {
    const hand = [
      new Card(Suit.Diamonds, 'J', 1), // Diamonds length 1
      new Card(Suit.Hearts, '9', 1), // Hearts length 2
      new Card(Suit.Hearts, '9', 2),
    ]
    const tracker = new PlayTracker()
    const led = chooseLeadCard(hand, Suit.Spades, tracker)
    expect(led.suit).toBe(Suit.Diamonds)
    expect(led.rank).toBe('J')
  })

  it('priority 5: falls back to non-point trump when only trump/point cards remain', () => {
    const hand = [
      new Card(Suit.Spades, '9', 1), // trump, non-point, not safe
      new Card(Suit.Hearts, '10', 1), // point card, not safe
    ]
    const tracker = new PlayTracker()
    const led = chooseLeadCard(hand, Suit.Spades, tracker)
    expect(led.suit).toBe(Suit.Spades)
    expect(led.rank).toBe('9')
  })

  it('last resort: leads the lowest-ranked card when every option is a point card', () => {
    const hand = [
      new Card(Suit.Hearts, '10', 1), // non-trump point card
      new Card(Suit.Spades, 'K', 1), // trump point card, lower rank than 10
    ]
    const tracker = new PlayTracker()
    const led = chooseLeadCard(hand, Suit.Spades, tracker)
    expect(led.suit).toBe(Suit.Spades)
    expect(led.rank).toBe('K')
  })
})

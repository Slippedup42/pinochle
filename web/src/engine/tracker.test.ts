import { describe, expect, it } from 'vitest'
import { Card, Suit } from './card'
import type { TrickPlay } from './trick'
import { chooseFollowCard, chooseLeadCard, PlayTracker } from './tracker'

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

describe('chooseFollowCard', () => {
  it('plays the only legal move without consulting any other context', () => {
    const onlyCard = new Card(Suit.Hearts, '9', 1)
    const played = chooseFollowCard([onlyCard], [onlyCard], [], Suit.Spades, [])
    expect(played).toBe(onlyCard)
  })

  it('forced beat: every legal card already beats the winner - plays the lowest one that still wins', () => {
    // Opponent (player 1) is winning with a weak 9 of the lead suit; both
    // legal cards outrank it, so this is a forced beat regardless of who's
    // winning - the cheapest winner is played to save bigger cards.
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, '9', 1) }]
    const legalMoves = [new Card(Suit.Hearts, '10', 1), new Card(Suit.Hearts, 'A', 1)]
    const hand = legalMoves
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2])
    expect(played.rank).toBe('10')
  })

  it('feeds partner the highest King/10 when partner is winning and not every card is a forced beat', () => {
    // Partner (player 0) is winning with a Queen; the 9 doesn't beat it, so
    // this isn't a forced beat - falls through to the feed-partner tier.
    const trickPlays: TrickPlay[] = [{ player: 0, card: new Card(Suit.Hearts, 'Q', 1) }]
    const legalMoves = [
      new Card(Suit.Hearts, '9', 1),
      new Card(Suit.Hearts, 'K', 1),
      new Card(Suit.Hearts, '10', 1),
    ]
    const hand = legalMoves
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2])
    expect(played.rank).toBe('10') // 10 outranks King, so it's the bigger feed
  })

  it('feeding partner with no King/10 available plays the lowest card instead (avoid donating a live Ace)', () => {
    const trickPlays: TrickPlay[] = [{ player: 0, card: new Card(Suit.Hearts, 'Q', 1) }]
    const legalMoves = [new Card(Suit.Hearts, '9', 1), new Card(Suit.Hearts, 'J', 1)]
    const hand = legalMoves
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2])
    expect(played.rank).toBe('9')
  })

  it('opponent winning: plays the lowest non-point card rather than feeding them a point', () => {
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, 'K', 1) }]
    const legalMoves = [
      new Card(Suit.Hearts, 'J', 1), // non-point
      new Card(Suit.Hearts, 'Q', 1), // non-point
      new Card(Suit.Hearts, 'A', 1), // point, beats the King, but not forced (Q/J don't)
    ]
    const hand = legalMoves
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2])
    expect(played.rank).toBe('J')
  })

  it('opponent winning with only point cards available: plays the lowest legal card', () => {
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, 'A', 1) }]
    const legalMoves = [new Card(Suit.Hearts, '10', 1), new Card(Suit.Hearts, 'K', 1)]
    const hand = legalMoves
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2])
    expect(played.rank).toBe('K')
  })

  it('void in the lead suit, forced to trump, no tracker supplied: defaults to trump-secure and conserves the lowest trump', () => {
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, 'K', 1) }]
    const legalMoves = [new Card(Suit.Spades, '9', 1), new Card(Suit.Spades, 'A', 1)]
    const hand = legalMoves
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2])
    expect(played.rank).toBe('9')
  })

  it('forced to trump, trump secure per tracker (all 12 copies accounted for): plays the lowest trump', () => {
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, 'K', 1) }]
    const hand = [new Card(Suit.Spades, '9', 1), new Card(Suit.Spades, 'A', 1)]
    const legalMoves = hand
    const tracker = new PlayTracker()
    for (const rank of ['J', 'Q', 'K', '10'] as const) {
      tracker.record(new Card(Suit.Spades, rank, 1))
      tracker.record(new Card(Suit.Spades, rank, 2))
    }
    tracker.record(new Card(Suit.Spades, '9', 2))
    tracker.record(new Card(Suit.Spades, 'A', 2))
    // 8 (J/Q/K/10 both copies) + 2 (spare 9/A copies) played, + 2 in hand = 12: fully accounted for.
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2], tracker)
    expect(played.rank).toBe('9')
  })

  it('forced to trump, not secure per tracker, has a point trump available: surrenders the lowest point trump', () => {
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, '9', 1) }]
    const hand = [new Card(Suit.Spades, 'J', 1), new Card(Suit.Spades, 'K', 1)]
    const legalMoves = hand
    const tracker = new PlayTracker() // nothing played -> nowhere near 12 accounted for
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2], tracker)
    expect(played.rank).toBe('K')
  })

  it('forced to trump, not secure, no point trump available: plays the lowest trump', () => {
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, '9', 1) }]
    const hand = [new Card(Suit.Spades, 'J', 1), new Card(Suit.Spades, '9', 1)]
    const legalMoves = hand
    const tracker = new PlayTracker()
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2], tracker)
    expect(played.rank).toBe('9')
  })

  it('sluff (void in lead suit and trump): plays from the shortest suit', () => {
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, 'K', 1) }]
    const hand = [
      new Card(Suit.Clubs, '9', 1),
      new Card(Suit.Clubs, '10', 1), // Clubs length 2
      new Card(Suit.Diamonds, '9', 1), // Diamonds length 1 - shortest
    ]
    const legalMoves = hand
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2])
    expect(played.suit).toBe(Suit.Diamonds)
    expect(played.rank).toBe('9')
  })

  it('sluff: when suit lengths tie, plays the lowest rank', () => {
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, 'K', 1) }]
    const hand = [new Card(Suit.Clubs, '9', 1), new Card(Suit.Diamonds, 'A', 1)] // both suits length 1
    const legalMoves = hand
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2])
    expect(played.suit).toBe(Suit.Clubs)
    expect(played.rank).toBe('9')
  })
})

import { describe, expect, it } from 'vitest'
import { Card, type Rank, Suit } from './card'
import { SKILL_PARAMS, type SkillLevel } from './skills'
import { chooseFollowCard, PlayTracker } from './tracker'
import { Trick, type PlayerIndex, type TrickPlay } from './trick'

// Paul's house follow rules (`FollowRules` in skills.ts), one case per rule,
// each with the card the shipped `'current'` cascade plays beside it so the
// test says what the arm changes as well as what it does.

const TRUMP = Suit.Hearts
const c = (suit: Suit, rank: Rank, copy: 1 | 2 = 1) => new Card(suit, rank, copy)

function withRules<T>(arm: 'current' | 'house', play: (skill: SkillLevel) => T): T {
  const level: SkillLevel = 'hard'
  const saved = SKILL_PARAMS[level]
  SKILL_PARAMS[level] = { ...saved, followRules: arm }
  try {
    return play(level)
  } finally {
    SKILL_PARAMS[level] = saved
  }
}

/** The follower's choice for `seat`, after `plays`, with every played card
 *  recorded in a tracker the way the real callers record them. */
function follow(
  arm: 'current' | 'house',
  seat: PlayerIndex,
  hand: Card[],
  plays: TrickPlay[],
  tracker = new PlayTracker(),
): Card {
  const trick = new Trick(TRUMP)
  for (const p of plays) {
    tracker.record(p.card, trick.plays[0]?.card.suit)
    trick.plays.push(p)
  }
  const legal = trick.legalMoves(hand)
  const team: PlayerIndex[] = [seat, ((seat + 2) % 4) as PlayerIndex]
  return withRules(arm, (skill) => chooseFollowCard(hand, legal, trick.plays, TRUMP, team, tracker, skill))
}

describe('house follow rules', () => {
  it('1: an opponent leads an Ace — play the lowest card', () => {
    const hand = [c(Suit.Spades, 'K'), c(Suit.Spades, '9'), c(Suit.Clubs, 'Q')]
    const plays = [{ player: 0 as PlayerIndex, card: c(Suit.Spades, 'A') }]
    expect(follow('house', 1, hand, plays).toString()).toBe(c(Suit.Spades, '9').toString())
  })

  it('2: partner still to play and an Ace still out — throw the lowest counter', () => {
    // Opponent leads the 10; K and Q cannot beat it. Partner may hold the Ace.
    const hand = [c(Suit.Spades, 'K'), c(Suit.Spades, 'Q'), c(Suit.Clubs, '9')]
    const plays = [{ player: 0 as PlayerIndex, card: c(Suit.Spades, '10') }]
    expect(follow('house', 1, hand, plays).toString()).toBe(c(Suit.Spades, 'K').toString())
    expect(follow('current', 1, hand, plays).toString()).toBe(c(Suit.Spades, 'Q').toString())
  })

  it('2: with both Aces accounted for, it keeps the counter', () => {
    const tracker = new PlayTracker()
    tracker.record(c(Suit.Spades, 'A', 1))
    tracker.record(c(Suit.Spades, 'A', 2))
    const hand = [c(Suit.Spades, 'K'), c(Suit.Spades, 'Q')]
    const plays = [{ player: 0 as PlayerIndex, card: c(Suit.Spades, '10') }]
    expect(follow('house', 1, hand, plays, tracker).toString()).toBe(c(Suit.Spades, 'Q').toString())
  })

  it('3: void, trumping in — the lowest trump rather than the Ace', () => {
    const hand = [c(Suit.Hearts, 'A'), c(Suit.Hearts, '9'), c(Suit.Clubs, 'Q')]
    const plays = [{ player: 0 as PlayerIndex, card: c(Suit.Spades, 'K') }]
    expect(follow('house', 1, hand, plays).toString()).toBe(c(Suit.Hearts, '9').toString())
    expect(follow('current', 1, hand, plays).toString()).toBe(c(Suit.Hearts, 'A').toString())
  })

  it('3: void, trumping in — spend a King of trump while a higher trump is out', () => {
    const hand = [c(Suit.Hearts, 'K'), c(Suit.Hearts, '9'), c(Suit.Hearts, 'J')]
    const plays = [{ player: 0 as PlayerIndex, card: c(Suit.Spades, 'K') }]
    expect(follow('house', 1, hand, plays).toString()).toBe(c(Suit.Hearts, 'K').toString())
  })

  it("3: an opponent's trump is already winning — the lowest trump, not a gift", () => {
    // Seat 3: opponent led a spade, partner followed, opponent ruffed with the 10.
    const hand = [c(Suit.Hearts, 'K'), c(Suit.Hearts, '9'), c(Suit.Clubs, 'Q')]
    const plays = [
      { player: 0 as PlayerIndex, card: c(Suit.Spades, 'J') },
      { player: 1 as PlayerIndex, card: c(Suit.Spades, '9') },
      { player: 2 as PlayerIndex, card: c(Suit.Hearts, '10') },
    ]
    expect(follow('house', 3, hand, plays).toString()).toBe(c(Suit.Hearts, '9').toString())
  })

  it('4: sluff with partner still to play — the lowest counter', () => {
    const hand = [c(Suit.Clubs, 'K'), c(Suit.Clubs, 'Q'), c(Suit.Diamonds, 'A')]
    const plays = [{ player: 0 as PlayerIndex, card: c(Suit.Spades, 'K') }]
    expect(follow('house', 1, hand, plays).toString()).toBe(c(Suit.Clubs, 'K').toString())
    expect(follow('current', 1, hand, plays).toString()).toBe(c(Suit.Clubs, 'Q').toString())
  })

  it('4: sluff — an Ace is saved unless its suit has been trumped', () => {
    const hand = [c(Suit.Diamonds, 'A'), c(Suit.Clubs, '9')]
    const plays = [{ player: 0 as PlayerIndex, card: c(Suit.Spades, 'K') }]
    expect(follow('house', 1, hand, plays).toString()).toBe(c(Suit.Clubs, '9').toString())

    // Earlier this hand someone trumped a diamond lead.
    const tracker = new PlayTracker()
    tracker.record(c(Suit.Diamonds, '9'))
    tracker.record(c(Suit.Hearts, 'Q'), Suit.Diamonds)
    expect(follow('house', 1, hand, plays, tracker).toString()).toBe(c(Suit.Diamonds, 'A').toString())
  })

  it('4: sluff when an opponent is going to take it — the lowest card', () => {
    // Seat 3: partner (seat 1) has played and an opponent is winning.
    const hand = [c(Suit.Clubs, 'K'), c(Suit.Clubs, 'Q'), c(Suit.Diamonds, '9')]
    const plays = [
      { player: 0 as PlayerIndex, card: c(Suit.Spades, 'J') },
      { player: 1 as PlayerIndex, card: c(Suit.Spades, '9') },
      { player: 2 as PlayerIndex, card: c(Suit.Spades, 'A') },
    ]
    const card = follow('house', 3, hand, plays)
    expect(card.rank === 'K' || card.rank === '10' || card.rank === 'A').toBe(false)
  })
})

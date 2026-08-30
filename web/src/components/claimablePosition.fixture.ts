// The one hand-built position that "the rest are mine" (#208) is tested from,
// shared by `trickPlayReducer.test.ts` (the rule) and `TrickPlayFlow.test.tsx`
// (the component wiring around it, #217).
//
// A claim cannot come out of `Deck.deal()`: it needs a position where every
// remaining trick is already decided, which is eleven tricks into a hand. So
// both suites have to hand-build one, and two copies of that build could drift
// into two different positions — one still claimable, one quietly not — while
// both files went on passing. `findClaim`'s preconditions are narrow enough
// (equal hand lengths, the claimer on lead, nobody else holding trump) that a
// second copy is a real risk rather than a theoretical one.

import { Card, type Rank, Suit } from '../engine/card'
import type { Hands } from '../engine/round'

/** Trump for {@link claimableHands} — the suit seat 0 holds all of. */
export const CLAIMABLE_TRUMP = Suit.Hearts

/**
 * Trick 11 of 12: two cards each, seat 0 on lead holding only trump and nobody
 * else holding any. The position `findClaim` exists for.
 *
 * Every card left is a counter, so the claim is worth all eight of them plus
 * the last-trick bonus, and both skipped tricks go to seat 0.
 *
 * A function rather than a frozen constant because `trickPlayReducer`'s
 * PLAY_CARD removes a played card by *identity*: one shared array of `Card`
 * instances would let one test's play empty a hand another test then reads.
 */
export function claimableHands(): Hands {
  const c = (suit: Suit, rank: Rank) => new Card(suit, rank, 1)
  return [
    [c(Suit.Hearts, 'A'), c(Suit.Hearts, 'K')],
    [c(Suit.Spades, 'A'), c(Suit.Spades, 'K')],
    [c(Suit.Clubs, 'A'), c(Suit.Clubs, 'K')],
    [c(Suit.Diamonds, 'A'), c(Suit.Diamonds, 'K')],
  ]
}

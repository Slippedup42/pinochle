// Melding — ported from pinochle_engine.py (frozen Python reference).
//
// A pure function over a hand and the trump suit, not a player decision.
// A card can count toward multiple *different* meld types at once (a trump
// King is part of both a Run and a Royal Marriage), but within a single
// meld type you can't reuse a physical card — you need a second copy for a
// second instance of the same meld.
//
// Doubles (Double Run, Double Pinochle, Arounds doubles) REPLACE the single
// value, they are not simple multiplication.

import { type Card, type Rank, Suit, SUITS } from './card'

export const RUN_VALUE = 150
// Replaces single Run, not 2x150 — same convention as Double Pinochle / Arounds.
export const DOUBLE_RUN_VALUE = 1500
export const ROYAL_MARRIAGE_VALUE = 40
export const COMMON_MARRIAGE_VALUE = 20
export const DIX_VALUE = 10
export const PINOCHLE_SINGLE_VALUE = 40
export const PINOCHLE_DOUBLE_VALUE = 300
export const AROUND_VALUES: Record<'A' | 'K' | 'Q' | 'J', number> = {
  A: 100,
  K: 80,
  Q: 60,
  J: 40,
}
export const AROUND_DOUBLE_MULTIPLIER = 10

export const RUN_RANKS: readonly Rank[] = ['A', '10', 'K', 'Q', 'J']

export interface MeldResult {
  total: number
  breakdown: Record<string, number>
}

export function scoreMelds(hand: readonly Card[], trumpSuit: Suit): MeldResult {
  const counts = new Map<string, number>()
  for (const card of hand) {
    const key = `${card.suit}${card.rank}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const n = (suit: Suit, rank: Rank) => counts.get(`${suit}${rank}`) ?? 0

  const breakdown: Record<string, number> = {}

  // -- Class A: trump/marriage melds --------------------------------
  const runCount = Math.min(...RUN_RANKS.map((r) => n(trumpSuit, r)))
  if (runCount === 2) {
    breakdown['Double Run'] = DOUBLE_RUN_VALUE
  } else if (runCount === 1) {
    breakdown['Run'] = RUN_VALUE
  }

  const royalCount = Math.min(n(trumpSuit, 'K'), n(trumpSuit, 'Q'))
  if (royalCount) {
    breakdown['Royal Marriage'] = royalCount * ROYAL_MARRIAGE_VALUE
  }

  let commonTotal = 0
  for (const suit of SUITS) {
    if (suit === trumpSuit) continue
    commonTotal += Math.min(n(suit, 'K'), n(suit, 'Q'))
  }
  if (commonTotal) {
    breakdown['Common Marriage'] = commonTotal * COMMON_MARRIAGE_VALUE
  }

  const dixCount = n(trumpSuit, '9')
  if (dixCount) {
    breakdown['Dix'] = dixCount * DIX_VALUE
  }

  // -- Class B: pinochle -------------------------------------------
  const pinochleCount = Math.min(
    n(Suit.Spades, 'Q'),
    n(Suit.Diamonds, 'J'),
  )
  if (pinochleCount === 2) {
    breakdown['Double Pinochle'] = PINOCHLE_DOUBLE_VALUE
  } else if (pinochleCount === 1) {
    breakdown['Pinochle'] = PINOCHLE_SINGLE_VALUE
  }

  // -- Class C: arounds ----------------------------------------------
  for (const [rank, baseValue] of Object.entries(AROUND_VALUES) as [
    'A' | 'K' | 'Q' | 'J',
    number,
  ][]) {
    const aroundCount = Math.min(...SUITS.map((suit) => n(suit, rank)))
    if (aroundCount === 2) {
      breakdown[`${rank}s Around (double)`] = baseValue * AROUND_DOUBLE_MULTIPLIER
    } else if (aroundCount === 1) {
      breakdown[`${rank}s Around`] = baseValue
    }
  }

  const total = Object.values(breakdown).reduce((sum, v) => sum + v, 0)
  return { total, breakdown }
}

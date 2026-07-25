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

function countByKey(hand: readonly Card[]): Map<string, Card[]> {
  const m = new Map<string, Card[]>()
  for (const card of hand) {
    const key = `${card.suit}${card.rank}`
    if (!m.has(key)) m.set(key, [])
    m.get(key)!.push(card)
  }
  return m
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

export interface MeldCardsResult {
  /** Every card that contributes to at least one meld group (deduplicated). */
  meldCards: Card[]
  /** Per-group breakdown with the actual cards. A card may appear in multiple groups. */
  groups: { name: string; points: number; cards: Card[] }[]
}

/**
 * Extract the specific cards that form melds in a hand. Used during the
 * meld-declaration phase to show opponent meld cards face-up on the table.
 *
 * In real pinochle, the same card can be used in multiple *different* meld
 * types simultaneously (e.g. Q♠ counts toward Pinochle, Queens Around, and
 * a Royal Marriage if spades is trump). The only conflict is Run vs Royal
 * Marriage in the trump suit — the Run takes precedence since it scores higher.
 *
 * This detection therefore does NOT remove cards from a pool as it goes;
 * instead, each meld type is detected independently, and the same Card object
 * may appear in several groups' card lists. The returned `meldCards` array
 * deduplicates across all groups so the table display shows each card once.
 */
export function extractMeldCards(hand: readonly Card[], trumpSuit: Suit): MeldCardsResult {
  const byKey = countByKey(hand)
  const n = (suit: Suit, rank: Rank) => byKey.get(`${suit}${rank}`)?.length ?? 0
  const cardAt = (suit: Suit, rank: Rank, index: number): Card | undefined =>
    byKey.get(`${suit}${rank}`)?.[index]

  const groups: { name: string; points: number; cards: Card[] }[] = []
  const allCards = new Set<Card>()

  // -- Run / Double Run (trump only) --
  const runCount = Math.min(...RUN_RANKS.map((r) => n(trumpSuit, r)))
  let trumpKRunCount = 0
  let trumpQRunCount = 0
  if (runCount >= 2) {
    const cards = RUN_RANKS.flatMap((r) => {
      const arr = byKey.get(`${trumpSuit}${r}`) ?? []
      return arr.slice(0, 2)
    })
    groups.push({ name: 'Double Run', points: DOUBLE_RUN_VALUE, cards })
    cards.forEach((c) => allCards.add(c))
    trumpKRunCount = 2
    trumpQRunCount = 2
  } else if (runCount === 1) {
    const cards = RUN_RANKS.flatMap((r) => {
      const arr = byKey.get(`${trumpSuit}${r}`) ?? []
      return arr.slice(0, 1)
    })
    groups.push({ name: 'Run', points: RUN_VALUE, cards })
    cards.forEach((c) => allCards.add(c))
    trumpKRunCount = 1
    trumpQRunCount = 1
  }

  // -- Royal Marriage (skip K/Q pairs already counted in the Run) --
  const royalK = n(trumpSuit, 'K')
  const royalQ = n(trumpSuit, 'Q')
  const royalCount = Math.min(royalK - trumpKRunCount, royalQ - trumpQRunCount)
  for (let i = 0; i < royalCount; i++) {
    const k = cardAt(trumpSuit, 'K', trumpKRunCount + i)
    const q = cardAt(trumpSuit, 'Q', trumpQRunCount + i)
    const cards = [k!, q!]
    groups.push({ name: 'Royal Marriage', points: ROYAL_MARRIAGE_VALUE, cards })
    cards.forEach((c) => allCards.add(c))
  }

  // -- Common Marriage (non-trump suits) --
  for (const suit of SUITS) {
    if (suit === trumpSuit) continue
    const cm = Math.min(n(suit, 'K'), n(suit, 'Q'))
    for (let i = 0; i < cm; i++) {
      const k = cardAt(suit, 'K', i)
      const q = cardAt(suit, 'Q', i)
      const cards = [k!, q!]
      groups.push({ name: `Common Marriage (${suit})`, points: COMMON_MARRIAGE_VALUE, cards })
      cards.forEach((c) => allCards.add(c))
    }
  }

  // -- Dix --
  const dixCount = n(trumpSuit, '9')
  for (let i = 0; i < dixCount; i++) {
    const d = cardAt(trumpSuit, '9', i)!
    groups.push({ name: 'Dix', points: DIX_VALUE, cards: [d] })
    allCards.add(d)
  }

  // -- Pinochle / Double Pinochle --
  const qs = n(Suit.Spades, 'Q')
  const jd = n(Suit.Diamonds, 'J')
  const pinCount = Math.min(qs, jd)
  if (pinCount >= 2) {
    const cards = [
      cardAt(Suit.Spades, 'Q', 0)!,
      cardAt(Suit.Spades, 'Q', 1)!,
      cardAt(Suit.Diamonds, 'J', 0)!,
      cardAt(Suit.Diamonds, 'J', 1)!,
    ]
    groups.push({ name: 'Double Pinochle', points: PINOCHLE_DOUBLE_VALUE, cards })
    cards.forEach((c) => allCards.add(c))
  } else if (pinCount === 1) {
    const cards = [cardAt(Suit.Spades, 'Q', 0)!, cardAt(Suit.Diamonds, 'J', 0)!]
    groups.push({ name: 'Pinochle', points: PINOCHLE_SINGLE_VALUE, cards })
    cards.forEach((c) => allCards.add(c))
  }

  // -- Arounds --
  for (const [rank, baseValue] of Object.entries(AROUND_VALUES) as ['A' | 'K' | 'Q' | 'J', number][]) {
    const ac = Math.min(...SUITS.map((s) => n(s, rank)))
    if (ac >= 2) {
      const cards: Card[] = []
      for (const s of SUITS) {
        for (let i = 0; i < 2; i++) cards.push(cardAt(s, rank, i)!)
      }
      groups.push({ name: `${rank}s Around (double)`, points: baseValue * AROUND_DOUBLE_MULTIPLIER, cards })
      cards.forEach((c) => allCards.add(c))
    } else if (ac === 1) {
      const cards: Card[] = []
      for (const s of SUITS) {
        cards.push(cardAt(s, rank, 0)!)
      }
      groups.push({ name: `${rank}s Around`, points: baseValue, cards })
      cards.forEach((c) => allCards.add(c))
    }
  }

  return { meldCards: [...allCards], groups }
}

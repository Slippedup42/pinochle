// Card-counting tracker + lead-card AI — ported from pinochle_engine.py's
// PlayTracker class and choose_lead_card function (frozen Python
// reference).
//
// PlayTracker accumulates played-card counts across a round; both the
// lead-card strategy here and the follow-card strategy (#32, not yet
// ported) consume the same tracker instance. Its public shape is kept
// deliberately small - `record` / `playedCount` are all either strategy
// currently needs.

import { type Card, RANK_VALUE, RANKS, type Rank, type Suit } from './card'

const POINT_RANKS = new Set(['A', '10', 'K'])

/** Tracks cards played so far this round, across all 4 hands. */
export class PlayTracker {
  private readonly played = new Map<string, number>()

  private static key(suit: Suit, rank: Rank): string {
    return `${suit}:${rank}`
  }

  record(card: Card): void {
    const key = PlayTracker.key(card.suit, card.rank)
    this.played.set(key, (this.played.get(key) ?? 0) + 1)
  }

  playedCount(suit: Suit, rank: Rank): number {
    return this.played.get(PlayTracker.key(suit, rank)) ?? 0
  }
}

function handCount(hand: readonly Card[], suit: Suit, rank: Rank): number {
  return hand.reduce((count, c) => count + (c.suit === suit && c.rank === rank ? 1 : 0), 0)
}

function suitLength(hand: readonly Card[], suit: Suit): number {
  return hand.reduce((count, c) => count + (c.suit === suit ? 1 : 0), 0)
}

/**
 * A card is safe to lead once every higher-ranked card in its suit is
 * accounted for - either already played, or still in your own hand (a
 * card you hold yourself can't beat you).
 */
function isSafe(card: Card, hand: readonly Card[], tracker: PlayTracker): boolean {
  if (card.rank === 'A') return true
  const idx = RANK_VALUE[card.rank]
  for (const rank of RANKS) {
    const value = RANK_VALUE[rank]
    if (value > idx) {
      const accounted = tracker.playedCount(card.suit, rank) + handCount(hand, card.suit, rank)
      if (accounted < 2) return false
    }
  }
  return true
}

/**
 * Exactly 1 copy of this Ace in hand, and the other copy hasn't been
 * played yet - a live liability that needs to move before someone else's
 * lead traps you into losing it to the tie-break rule.
 */
function isUnsecuredAce(card: Card, hand: readonly Card[], tracker: PlayTracker): boolean {
  if (card.rank !== 'A') return false
  if (handCount(hand, card.suit, 'A') !== 1) return false // 0 copies (n/a) or 2 copies (secure double, no rush)
  return tracker.playedCount(card.suit, 'A') === 0
}

/**
 * Choose what to lead when you have control. Priority:
 *   1. Unsecured trump Ace
 *   2. Other unsecured Aces (longest suit first)
 *   3. Safe cards, cascading top-down by rank (longest suit first within a rank)
 *   4. Junk lead (non-point, non-trump) to surrender - shortest suit first
 *   5. Non-point trump as a last resort before giving up a point card
 */
export function chooseLeadCard(hand: readonly Card[], trump: Suit, tracker: PlayTracker): Card {
  const trumpAces = hand.filter((c) => c.suit === trump && c.rank === 'A' && isUnsecuredAce(c, hand, tracker))
  if (trumpAces.length > 0) return trumpAces[0]

  const otherUnsecuredAces = hand.filter(
    (c) => c.rank === 'A' && c.suit !== trump && isUnsecuredAce(c, hand, tracker),
  )
  if (otherUnsecuredAces.length > 0) {
    otherUnsecuredAces.sort((a, b) => suitLength(hand, b.suit) - suitLength(hand, a.suit))
    return otherUnsecuredAces[0]
  }

  const safeCards = hand.filter((c) => isSafe(c, hand, tracker))
  if (safeCards.length > 0) {
    safeCards.sort((a, b) => {
      const byRank = RANK_VALUE[b.rank] - RANK_VALUE[a.rank]
      return byRank !== 0 ? byRank : suitLength(hand, b.suit) - suitLength(hand, a.suit)
    })
    return safeCards[0]
  }

  const junk = hand.filter((c) => !POINT_RANKS.has(c.rank) && c.suit !== trump)
  if (junk.length > 0) {
    junk.sort((a, b) => suitLength(hand, a.suit) - suitLength(hand, b.suit))
    return junk[0]
  }

  const junkTrump = hand.filter((c) => !POINT_RANKS.has(c.rank) && c.suit === trump)
  if (junkTrump.length > 0) {
    junkTrump.sort((a, b) => suitLength(hand, a.suit) - suitLength(hand, b.suit))
    return junkTrump[0]
  }

  return hand.reduce((lowest, c) => (RANK_VALUE[c.rank] < RANK_VALUE[lowest.rank] ? c : lowest))
}

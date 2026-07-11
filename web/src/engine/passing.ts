// 3-card pass — ported from pinochle_engine.py (frozen Python reference).
//
// Skill-level-proficient strategy, split by trump category (Diamonds/
// Spades vs Hearts/Clubs) and role (bidder vs partner). choosePassCards
// is the entry point; bidderPassSelection / partnerPassSelection hold
// the tiered priority logic for each role.

import { type Card, type Rank, Suit, SUITS } from './card'
import { scoreMelds } from './melds'

export type PassCategory = 'DS' | 'HC'

export const PASS_COUNT = 3

function nOf(hand: readonly Card[], suit: Suit, rank: Rank): number {
  return hand.reduce((count, c) => count + (c.suit === suit && c.rank === rank ? 1 : 0), 0)
}

/** Would removing this K/Q break an existing marriage in its suit? */
function breaksMarriage(hand: readonly Card[], card: Card): boolean {
  if (card.rank !== 'K' && card.rank !== 'Q') return false
  const otherRank = card.rank === 'K' ? 'Q' : 'K'
  return nOf(hand, card.suit, otherRank) >= 1
}

/**
 * Would removing this card break an existing 'around' meld (all 4 suits
 * present) for its rank?
 */
function breaksAround(hand: readonly Card[], card: Card): boolean {
  if (card.rank !== 'A' && card.rank !== 'K' && card.rank !== 'Q' && card.rank !== 'J') return false
  if (Math.min(...SUITS.map((s) => nOf(hand, s, card.rank))) < 1) return false
  return nOf(hand, card.suit, card.rank) === 1
}

/** Move matching cards from `pool` into `chosen` (both in place) until `count` is hit. */
function take(
  pool: Card[],
  chosen: Card[],
  count: number,
  predicate: (c: Card) => boolean,
  sortKey: (c: Card) => number = () => 0,
): void {
  const cands = pool.filter(predicate).sort((a, b) => sortKey(a) - sortKey(b))
  for (const c of cands) {
    if (chosen.length >= count) return
    chosen.push(c)
    pool.splice(pool.indexOf(c), 1)
  }
}

/**
 * Look for a non-trump suit where EVERY card is safe to pass (not
 * protected, not an Ace) and the whole suit fits within the remaining
 * pass slots - fully voiding it unlocks immediate trump control, which
 * beats scattering the same number of cards across multiple suits.
 * Prefers the largest such suit (most impactful void).
 */
function findVoidOpportunity(
  pool: readonly Card[],
  trump: Suit,
  isProtected: (c: Card) => boolean,
  remainingCount: number,
): Card[] | null {
  const candidates: Card[][] = []
  for (const suit of SUITS) {
    if (suit === trump) continue
    const suitCards = pool.filter((c) => c.suit === suit)
    if (suitCards.length === 0 || suitCards.length > remainingCount) continue
    if (suitCards.every((c) => !isProtected(c) && c.rank !== 'A')) {
      candidates.push(suitCards)
    }
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.length - a.length)
  return candidates[0]
}

/**
 * Partner's send-to-bidder priority:
 *   D/S: QS, JD -> K/Q trump -> trump A/10/J -> non-trump aces
 *        (non-duplicate first) -> 9 of trump -> other 9s
 *   H/C: K/Q trump -> trump A/10/J -> non-trump aces
 *        (non-duplicate first) -> 9 of trump -> other 9s
 */
export function partnerPassSelection(
  hand: readonly Card[],
  trump: Suit,
  category: PassCategory,
  count: number,
): Card[] {
  const pool = [...hand]
  const chosen: Card[] = []

  if (category === 'DS') {
    take(
      pool,
      chosen,
      count,
      (c) => (c.suit === Suit.Spades && c.rank === 'Q') || (c.suit === Suit.Diamonds && c.rank === 'J'),
    )
  }

  take(pool, chosen, count, (c) => c.suit === trump && (c.rank === 'K' || c.rank === 'Q'))

  const trumpOrder: Record<string, number> = { A: 0, '10': 1, J: 2 }
  take(
    pool,
    chosen,
    count,
    (c) => c.suit === trump && (c.rank === 'A' || c.rank === '10' || c.rank === 'J'),
    (c) => trumpOrder[c.rank],
  )

  take(
    pool,
    chosen,
    count,
    (c) => c.suit !== trump && c.rank === 'A',
    (c) => (nOf(hand, c.suit, 'A') === 1 ? 0 : 1),
  )

  take(pool, chosen, count, (c) => c.suit === trump && c.rank === '9')

  // Void opportunity: once the intentional trump-building/ace tiers are
  // done, a clean full-suit void beats scattering leftover 9s/filler.
  if (chosen.length < count) {
    const isProtected = (c: Card) => c.suit === trump // partner has no QS/JD-style personal protection
    const voidCards = findVoidOpportunity(pool, trump, isProtected, count - chosen.length)
    if (voidCards) {
      for (const c of voidCards) {
        if (chosen.length >= count) break
        chosen.push(c)
        pool.splice(pool.indexOf(c), 1)
      }
    }
  }

  take(pool, chosen, count, (c) => c.rank === '9')
  take(pool, chosen, count, () => true) // fallback

  return chosen.slice(0, count)
}

/**
 * Bidder's send-back-to-partner priority, matching the documented tiers:
 *
 *   D/S: (protect trump/JD/QS) -> safe non-trump J/9 filler (not
 *        breaking marriage/around) -> non-trump 10s -> duplicate AS/AD
 *        (pro move) -> random non-trump J/9, no safety check (true
 *        last resort before touching anything else) -> spare K/Q ->
 *        any unprotected non-ace -> any unprotected -> protected
 *
 *   H/C: QS/JD (unless the 60-queens+pinochle+1-run-card pro move
 *        applies) -> safe non-trump J/9 filler -> non-trump 10s ->
 *        random non-trump J/9 -> spare K/Q -> any unprotected non-ace
 *        -> any unprotected -> protected
 *
 * Aces are never passed except via the explicit pro-move tier (D/S
 * only) - they're too valuable to give away speculatively.
 */
export function bidderPassSelection(hand: readonly Card[], trump: Suit, category: PassCategory, count: number): Card[] {
  const pool = [...hand]
  const chosen: Card[] = []

  const isProtected = (c: Card) =>
    c.suit === trump || (c.suit === Suit.Spades && c.rank === 'Q') || (c.suit === Suit.Diamonds && c.rank === 'J')

  if (category === 'HC') {
    const { breakdown } = scoreMelds(hand, trump)
    const hasQueensAround = Object.keys(breakdown).some((k) => k.startsWith('Q') && k.includes('Around'))
    const hasPinochle = 'Pinochle' in breakdown || 'Double Pinochle' in breakdown
    const hasRunCard = (['A', '10', 'K', 'Q', 'J'] as const).some((r) => nOf(hand, trump, r) >= 1)
    const proMove = hasQueensAround && hasPinochle && hasRunCard

    if (!proMove) {
      take(
        pool,
        chosen,
        count,
        (c) => (c.suit === Suit.Spades && c.rank === 'Q') || (c.suit === Suit.Diamonds && c.rank === 'J'),
      )
    }
  }

  // Void opportunity: fully emptying a suit unlocks immediate trump
  // control, which beats scattering the same number of cards - check
  // this before falling into the generic rank tiers.
  if (chosen.length < count) {
    const voidCards = findVoidOpportunity(pool, trump, isProtected, count - chosen.length)
    if (voidCards) {
      for (const c of voidCards) {
        if (chosen.length >= count) break
        chosen.push(c)
        pool.splice(pool.indexOf(c), 1)
      }
    }
  }

  // Safe filler: non-trump J/9, only if it doesn't break a marriage/around
  take(
    pool,
    chosen,
    count,
    (c) => !isProtected(c) && (c.rank === 'J' || c.rank === '9') && !breaksMarriage(hand, c) && !breaksAround(hand, c),
  )

  // Non-trump 10s
  take(pool, chosen, count, (c) => !isProtected(c) && c.rank === '10')

  if (category === 'DS') {
    // Pro move: duplicate AS/AD
    take(
      pool,
      chosen,
      count,
      (c) => c.rank === 'A' && (c.suit === Suit.Spades || c.suit === Suit.Diamonds) && nOf(hand, c.suit, 'A') === 2,
    )
  }

  // Random J/9 - true last resort within this family, no safety check
  take(pool, chosen, count, (c) => !isProtected(c) && (c.rank === 'J' || c.rank === '9'))

  // Spare K/Q not currently doing meld work (only QS is inherently
  // protected - KS and other K/Q are fair game here)
  take(
    pool,
    chosen,
    count,
    (c) => !isProtected(c) && (c.rank === 'K' || c.rank === 'Q') && !breaksMarriage(hand, c) && !breaksAround(hand, c),
  )

  // Any unprotected non-ace (Aces stay off-limits outside the pro move)
  take(pool, chosen, count, (c) => !isProtected(c) && c.rank !== 'A')

  // Any unprotected card at all, including Aces if truly nothing else is left
  take(pool, chosen, count, (c) => !isProtected(c))

  // True last resort: protected cards
  take(pool, chosen, count, () => true)

  return chosen.slice(0, count)
}

/**
 * Fisher-Yates partial shuffle sample of `count` unique cards from
 * `pool` (mirrors Python's random.sample; used as choosePassCards'
 * fallback when it's called without full context).
 */
function sampleRandom(pool: readonly Card[], count: number): Card[] {
  const copy = [...pool]
  const n = Math.min(count, copy.length)
  const result: Card[] = []
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
    result.push(copy[i])
  }
  return result
}

/**
 * Skill-level-proficient passing strategy, split by trump category
 * (Diamonds/Spades vs Hearts/Clubs) and role (bidder vs partner). Falls
 * back to random selection if trumpSuit/isBidWinner aren't supplied
 * (keeps the function usable in isolation / old call sites).
 */
export function choosePassCards(
  hand: readonly Card[],
  count: number,
  trumpSuit?: Suit,
  isBidWinner?: boolean,
): Card[] {
  if (trumpSuit === undefined || isBidWinner === undefined) {
    return sampleRandom(hand, count)
  }

  const category: PassCategory = trumpSuit === Suit.Spades || trumpSuit === Suit.Diamonds ? 'DS' : 'HC'
  let chosen = isBidWinner
    ? bidderPassSelection(hand, trumpSuit, category, count)
    : partnerPassSelection(hand, trumpSuit, category, count)

  // Fallback safety net: strategy tiers should always fill `count`, but
  // pad with random remaining cards if some edge case leaves us short.
  if (chosen.length < count) {
    const remaining = hand.filter((c) => !chosen.includes(c))
    chosen = chosen.concat(sampleRandom(remaining, count - chosen.length))
  }
  return chosen.slice(0, count)
}

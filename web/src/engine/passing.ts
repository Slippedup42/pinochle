// 3-card pass — ported from pinochle_engine.py, which stays authoritative for
// the rule itself: three cards each way, per pinochle_rules.md. Which three is
// AI strategy, and strategy is the half of the port that is allowed to diverge
// on the TS side (#213) — PASS_COUNT is not.
//
// Skill-level-proficient strategy, split by trump category (Diamonds/
// Spades vs Hearts/Clubs) and role (bidder vs partner). choosePassCards
// is the entry point; bidderPassSelection / partnerPassSelection hold
// the tiered priority logic for each role.

import { type Card, type Rank, Suit, SUITS } from './card'
import { isProtectedTen } from './handShape'
import { SHIPPED_SKILL, SKILL_PARAMS, type SkillLevel } from './skills'

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

/**
 * Is this one of the two Aces that make a 10 of its own suit protected?
 *
 * The corollary of `isProtectedTen` (which #277 moved to `handShape.ts`, since
 * the bid values the same card), and not optional. The reason to keep the 10 is
 * that both Aces are behind it, so a pass rule that keeps the 10 while shedding
 * an Ace produces the one outcome that is strictly worse than shedding the 10
 * was: a bare 10 with nothing left to make it win. A-A-10 of a non-trump suit is
 * a running suit, and the tiers below move it as a unit. This one stays here: it
 * is about what survives a pass, and nothing outside passing asks it.
 */
function protectsATen(hand: readonly Card[], trump: Suit, card: Card): boolean {
  return (
    card.rank === 'A' &&
    card.suit !== trump &&
    nOf(hand, card.suit, 'A') === 2 &&
    nOf(hand, card.suit, '10') >= 1
  )
}

/** A-A-10 of a non-trump suit, as one group (#276) - see the two above. */
function inProtectedTenRun(hand: readonly Card[], trump: Suit, card: Card): boolean {
  return isProtectedTen(hand, trump, card) || protectsATen(hand, trump, card)
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
 * Inside the trump tiers, a spread beats duplicates. The bidder is building a
 * Run - A-10-K-Q-J of the trump suit - so three distinct trump ranks are worth
 * far more to them than two copies of one rank, which fills a single slot of
 * that run and leaves the rest of it open. Paul, 2026-09-02: "do not send KKQ
 * of trump if you have other trump J or better. The goal is for a Run so you
 * want to send a spread."
 */
const TRUMP_RUN_ORDER: Record<string, number> = { A: 0, '10': 1, K: 2, Q: 3, J: 4 }

/**
 * Like `take`, in rank order, but at most one card of any one rank.
 *
 * K-K-Q-J of trump sends K, Q and J and keeps the spare King. Nothing is thrown
 * away by declining that second King: the leftover-trump tier picks the
 * duplicates back up further down the list, once the side Aces have had their
 * turn.
 *
 * `seen` is per-call rather than read off `chosen`, deliberately - the two trump
 * tiers that use this cover disjoint ranks (A/10/J and K/Q) so they have nothing
 * to share, while the Q(S) an earlier tier may already have sent is a Queen of
 * another suit entirely and must not block the Queen of trump.
 */
function takeSpread(
  pool: Card[],
  chosen: Card[],
  count: number,
  predicate: (c: Card) => boolean,
  rankOrder: Record<string, number>,
): void {
  const seen = new Set<string>()
  const cands = pool.filter(predicate).sort((a, b) => rankOrder[a.rank] - rankOrder[b.rank])
  for (const c of cands) {
    if (chosen.length >= count) return
    if (seen.has(c.rank)) continue
    seen.add(c.rank)
    chosen.push(c)
    pool.splice(pool.indexOf(c), 1)
  }
}

/**
 * The partner's last tier, once trump, Aces and 9s have all gone: J, then 10,
 * then Q, then K, in increasing cost to give away. Paul, 2026-09-02: "You do not
 * want to pass points, 10 and K, and K are even worse because they make
 * marriages, this is also why keeping a Q is better." So: a Jack is neither a
 * counter nor a marriage card and costs nothing, a 10 is a counter, a Queen
 * carries a marriage, and a King is both.
 */
const PARTNER_FILLER_ORDER: Record<string, number> = { J: 0, '10': 1, Q: 2, K: 3 }

function partnerFillerOrder(hand: readonly Card[], trump: Suit, card: Card): number {
  // The protected 10 is the exception, and it is a reading of #280 rather than
  // something Paul stated: a 10 with both Aces of its suit behind it is a trick
  // this hand can still cash (#276), and the Ace tier above has already declined
  // to break that group up, so shipping the 10 out from under the pair produces
  // exactly the bare-10 outcome #276 exists to prevent. It sorts behind the King
  // instead of with the ordinary 10s.
  if (card.rank === '10' && isProtectedTen(hand, trump, card)) return 4
  // 5 is unreachable in practice - trump, Aces and 9s are all gone by the time
  // this tier runs. It is here so the tier can double as the catch-all that
  // guarantees `count` gets filled.
  return PARTNER_FILLER_ORDER[card.rank] ?? 5
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
 * Partner's send-to-bidder priority (Paul's rework, #280):
 *
 *   1. Q(S)/J(D) - D/S category only
 *   2. Trump A, 10, J - at most one of each rank
 *   3. Trump K, Q - at most one of each rank
 *   4. Non-trump Aces, singletons before pairs
 *   5. Whatever trump is left above the 9, highest first
 *   6. The 9 of trump (the dix)
 *   7. Void building
 *   8. Any 9
 *   9. J, then 10, then Q, then K
 *
 * Two of those orderings are not self-evident. A/10/J comes before K/Q because
 * the partner may want to keep the royal marriage - Paul: "really if you have
 * enough Trump you might keep the Royal Marriage." Three slots are often used up
 * before tier 3 is reached at all, and the A, the 10 and the J fill the run's
 * other ranks without breaking a K-Q pair this hand can still score. And tiers
 * 2, 3 and 5 between them prefer a spread over duplicates: see `takeSpread` for
 * why, and `partnerFillerOrder` for tier 9's order.
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

  takeSpread(
    pool,
    chosen,
    count,
    (c) => c.suit === trump && (c.rank === 'A' || c.rank === '10' || c.rank === 'J'),
    { A: 0, '10': 1, J: 2 },
  )

  // King before Queen for the same reason tier 9 gives a Queen away before a
  // King: of the two, the King is the more expensive card to be left holding, so
  // it is the better one to have gone.
  takeSpread(pool, chosen, count, (c) => c.suit === trump && (c.rank === 'K' || c.rank === 'Q'), { K: 0, Q: 1 })

  take(
    pool,
    chosen,
    count,
    (c) => c.suit !== trump && c.rank === 'A',
    (c) => (nOf(hand, c.suit, 'A') === 1 ? 0 : 1),
  )

  // The duplicate trump the two spread tiers declined, highest first - ahead of
  // the dix, which scores its 10 for the team wherever it sits.
  take(
    pool,
    chosen,
    count,
    (c) => c.suit === trump && c.rank !== '9',
    (c) => TRUMP_RUN_ORDER[c.rank],
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

  // Everything else, cheapest to give away first. Doubles as the catch-all: the
  // predicate matches any card, so `count` is always filled.
  take(
    pool,
    chosen,
    count,
    () => true,
    (c) => partnerFillerOrder(hand, trump, c),
  )

  return chosen.slice(0, count)
}

/**
 * Bidder's send-back-to-partner priority (Paul's rework, #280):
 *
 *   1. Q(S)/J(D) - H/C category only, unconditional
 *   2. Void building
 *   3. Spare K/Q doing no meld work
 *   4. Non-trump 10s, unprotected ones only (#276)
 *   5. Non-trump J/9 that breaks no marriage and no around
 *   6. Any unprotected non-Ace
 *   7. Any unprotected card
 *   8. Trump 9s and Js - H/C category only
 *   9. Anything left
 *
 * The bidder does not send an Ace back. Nothing above tier 7 can pick one up,
 * and tier 7 only fires on a hand with nothing unprotected left in it at all.
 * #280 removed the one tier that ever did so on purpose - Paul: "I took them out
 * on purpose. I want to see the play before I add pro moves."
 *
 * Tier 8 is the all-trump-and-Aces hand: when nothing safe is left, the low
 * trump goes rather than a card the bid is counting on. H/C only, because with
 * Spades or Diamonds trump a trump J or 9 can be a pinochle card or sit in the
 * run. It is placed ahead of the take-anything tier rather than after it - after
 * it, it could never run, since by then every remaining card is protected.
 *
 * The "non-trump 10s" tier means *unprotected* 10s only (#276). A 10 with both
 * Aces of its suit behind it is a winner the bidder can cash by playing that
 * suit out last, not a liability, so it is held out of that tier - and out of
 * the void tier, the other place a piece of that A-A-10 group could leave early
 * - and reaches the shed list only at "any unprotected non-ace", behind every
 * J/9 rag. See `isProtectedTen` for the rule and Paul's reasoning.
 */
export function bidderPassSelection(hand: readonly Card[], trump: Suit, category: PassCategory, count: number): Card[] {
  const pool = [...hand]
  const chosen: Card[] = []

  const isProtected = (c: Card) =>
    c.suit === trump || (c.suit === Suit.Spades && c.rank === 'Q') || (c.suit === Suit.Diamonds && c.rank === 'J')

  if (category === 'HC') {
    // Unconditional since #280. The exception this used to carry - keep them
    // when the hand holds Queens Around plus a pinochle plus a run card - was
    // removed deliberately, not lost.
    take(
      pool,
      chosen,
      count,
      (c) => (c.suit === Suit.Spades && c.rank === 'Q') || (c.suit === Suit.Diamonds && c.rank === 'J'),
    )
  }

  // Void opportunity: fully emptying a suit unlocks immediate trump
  // control, which beats scattering the same number of cards - check
  // this before falling into the generic rank tiers.
  if (chosen.length < count) {
    const voidCards = findVoidOpportunity(
      pool,
      trump,
      (c) => isProtected(c) || inProtectedTenRun(hand, trump, c),
      count - chosen.length,
    )
    if (voidCards) {
      for (const c of voidCards) {
        if (chosen.length >= count) break
        chosen.push(c)
        pool.splice(pool.indexOf(c), 1)
      }
    }
  }

  // Spare K/Q not currently doing meld work (only QS is inherently protected -
  // KS and other K/Q are fair game here). #280 moved this ahead of the 10s and
  // the J/9 filler: a King or Queen in no marriage and no around is scoring
  // nothing in this hand, and it may well find the card that marries it in the
  // partner's.
  take(
    pool,
    chosen,
    count,
    (c) => !isProtected(c) && (c.rank === 'K' || c.rank === 'Q') && !breaksMarriage(hand, c) && !breaksAround(hand, c),
  )

  // Non-trump 10s - but not one that both Aces of its suit make a winner
  // (#276); that one falls through to the "any unprotected non-ace" tier,
  // behind the J/9 filler this bidder can spend more cheaply.
  take(pool, chosen, count, (c) => !isProtected(c) && c.rank === '10' && !isProtectedTen(hand, trump, c))

  // Safe filler: non-trump J/9, only if it doesn't break a marriage/around
  take(
    pool,
    chosen,
    count,
    (c) => !isProtected(c) && (c.rank === 'J' || c.rank === '9') && !breaksMarriage(hand, c) && !breaksAround(hand, c),
  )

  // Any unprotected non-ace (Aces stay off-limits until the tier below)
  take(pool, chosen, count, (c) => !isProtected(c) && c.rank !== 'A')

  // Any unprotected card at all, including Aces if truly nothing else is left
  take(pool, chosen, count, (c) => !isProtected(c))

  if (category === 'HC') {
    // Nothing safe is left: the hand is trump and Aces. Low trump goes before
    // the run and the marriages do. H/C only - a trump J or 9 in Spades or
    // Diamonds can be a pinochle card or a run card.
    take(pool, chosen, count, (c) => c.suit === trump && (c.rank === 'J' || c.rank === '9'))
  }

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

/** Cheap per-card "keep value" for skill 1's simplified passing logic,
 *  matching Python's `_easy_card_worth`. */
function easyCardWorth(card: Card, trump: Suit): number {
  let worth = 0
  if (card.suit === trump) worth += 5
  if (card.rank === 'A' || card.rank === '10' || card.rank === 'K') worth += 2
  if (card.rank === 'Q' || card.rank === 'J') worth += 1
  return worth
}

/**
 * Skill-level-proficient passing strategy, split by trump category
 * (Diamonds/Spades vs Hearts/Clubs) and role (bidder vs partner). Falls
 * back to random selection if trumpSuit/isBidWinner aren't supplied
 * (keeps the function usable in isolation / old call sites).
 *
 * @param skill Which `SKILL_PARAMS` slot to read `handValuation` from:
 *   `'meld_only'` uses the simplified passing logic, `'base_bid'` the full
 *   Proficient tiers. Defaults to `SHIPPED_SKILL`, which is `'base_bid'`; the
 *   simplified arm is reachable only through an override (see `HandValuation`).
 */
export function choosePassCards(
  hand: readonly Card[],
  count: number,
  trumpSuit?: Suit,
  isBidWinner?: boolean,
  skill: SkillLevel = SHIPPED_SKILL,
): Card[] {
  if (trumpSuit === undefined || isBidWinner === undefined) {
    return sampleRandom(hand, count)
  }

  // Skill 1 (easy): simplified meld-only passing logic matching Python's EasyPlayer
  if (SKILL_PARAMS[skill].handValuation === 'meld_only') {
    if (!isBidWinner) {
      const ranked = [...hand].sort((a, b) => easyCardWorth(a, trumpSuit!) - easyCardWorth(b, trumpSuit!))
      return ranked.slice(0, count)
    }
    // Bidder: ship non-trump 10s first, then lowest-worth filler. A 10 with
    // both Aces of its suit behind it is exempt (#276) - it wins a trick when
    // the suit is played out last, so it drops back into the worth-ranked
    // filler, where `easyCardWorth` scores it level with an Ace or King and
    // behind every Q/J/9 in the hand.
    const pool = [...hand]
    const chosen = pool
      .filter((c) => c.suit !== trumpSuit && c.rank === '10' && !isProtectedTen(hand, trumpSuit, c))
      .slice(0, count)
    for (const c of chosen) {
      const idx = pool.indexOf(c)
      if (idx !== -1) pool.splice(idx, 1)
    }
    if (chosen.length < count) {
      const filler = [...pool].sort((a, b) => easyCardWorth(a, trumpSuit!) - easyCardWorth(b, trumpSuit!))
      chosen.push(...filler.slice(0, count - chosen.length))
    }
    return chosen
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

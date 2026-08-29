// Trick — owns lead suit, trump, legal-move filtering, and winner
// resolution. Ported from pinochle_engine.py's Trick class, which stays
// authoritative for these rules: engineParity.test.ts replays a full
// Python round through legalMoves/winner and a mismatch is TS drift (#125).
//
// Trick doesn't know about Player/Team objects — plays are recorded by
// PlayerIndex (0-3, matching clockwise table seating), so this module took
// no dependency on however bidding/passing (#17) would end up representing
// players. round.ts's teamOf() maps a PlayerIndex to its team.

import type { Card, Rank, Suit } from './card'

export type PlayerIndex = 0 | 1 | 2 | 3

/** The "counters" — the only ranks that carry trick points. Exported so
 *  round.ts can derive MAX_TRICK_POINTS from the same set that scores a
 *  trick, rather than restating how many counters a deck holds (#178). */
export const POINT_RANKS: ReadonlySet<Rank> = new Set<Rank>(['A', '10', 'K'])

/** What one counter is worth to whoever takes the trick it falls in. */
export const COUNTER_VALUE = 10

export interface TrickPlay {
  readonly player: PlayerIndex
  readonly card: Card
}

export class Trick {
  readonly trumpSuit: Suit
  readonly plays: TrickPlay[] = []

  constructor(trumpSuit: Suit) {
    this.trumpSuit = trumpSuit
  }

  /** Suit of the first card played this trick, or undefined before anyone has led. */
  get leadSuit(): Suit | undefined {
    return this.plays[0]?.card.suit
  }

  /**
   * Legal-move filtering, per pinochle_rules.md Phase 4:
   *   1. Leading: anything goes.
   *   2. Must follow the lead suit if able.
   *   3. Must beat the best lead-suit card on the table if able.
   *   4. If void in lead suit, must play trump if able.
   *   5. If playing trump because void, must beat the best trump on the
   *      table if able.
   *   6. Sluff: no lead-suit or trump cards in hand — anything goes.
   */
  legalMoves(hand: readonly Card[]): Card[] {
    if (this.plays.length === 0) return [...hand] // leading: anything goes

    const leadSuit = this.leadSuit as Suit
    const leadCardsOnTable = this.plays
      .filter((p) => p.card.suit === leadSuit)
      .map((p) => p.card)
    const trumpCardsOnTable = this.plays
      .filter((p) => p.card.suit === this.trumpSuit)
      .map((p) => p.card)

    const hasLeadSuit = hand.filter((c) => c.suit === leadSuit)
    if (hasLeadSuit.length > 0) {
      const bestOnTable = maxByRank(leadCardsOnTable)
      const beaters = hasLeadSuit.filter((c) => c.rankValue > bestOnTable.rankValue)
      return beaters.length > 0 ? beaters : hasLeadSuit
    }

    const hasTrump = hand.filter((c) => c.suit === this.trumpSuit)
    if (hasTrump.length > 0) {
      if (trumpCardsOnTable.length > 0) {
        const bestTrump = maxByRank(trumpCardsOnTable)
        const beaters = hasTrump.filter((c) => c.rankValue > bestTrump.rankValue)
        return beaters.length > 0 ? beaters : hasTrump
      }
      return hasTrump
    }

    return [...hand] // sluff — nothing of lead suit or trump
  }

  play(player: PlayerIndex, card: Card): void {
    this.plays.push({ player, card })
  }

  /**
   * Trick winner: highest trump if any trump was played, else highest
   * card of the lead suit. Ties (the same physical rank/suit played
   * twice) go to whichever copy was played first — `firstMaxByRank` only
   * replaces the running winner on a strictly-greater rank, so the
   * first-played copy naturally wins on equal rank, same as Python's
   * `max()` (stable, keeps the first maximal element).
   */
  winner(): PlayerIndex {
    const trumpPlays = this.plays.filter((p) => p.card.suit === this.trumpSuit)
    const pool = trumpPlays.length > 0
      ? trumpPlays
      : this.plays.filter((p) => p.card.suit === this.leadSuit)
    return firstMaxByRank(pool).player
  }

  /** Trick points (Ace/10/King = 10 each; Queen/Jack/9 = 0). Excludes the last-trick bonus — that's the caller's job. */
  points(): number {
    return this.plays.reduce(
      (sum, p) => sum + (POINT_RANKS.has(p.card.rank) ? COUNTER_VALUE : 0),
      0,
    )
  }
}

function maxByRank(cards: readonly Card[]): Card {
  return cards.reduce((best, c) => (c.rankValue > best.rankValue ? c : best))
}

function firstMaxByRank(plays: readonly TrickPlay[]): TrickPlay {
  return plays.reduce((best, p) => (p.card.rankValue > best.card.rankValue ? p : best))
}

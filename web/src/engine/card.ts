// Card / Deck — ported from pinochle_engine.py, the reference implementation
// this engine is checked against (engineParity.test.ts, #125). Python is not
// frozen — it is still where the AI research and measurement run — but it does
// stay authoritative for the rules constants in this file (the +-1000 bounds,
// OPENING_BID/FORCED_BID): if the two engines disagree on one of these, Python
// is right and this side has drifted. That is #118's bug class, #126's audit.

export const Suit = {
  Spades: 'S',
  Diamonds: 'D',
  Clubs: 'C',
  Hearts: 'H',
} as const
export type Suit = (typeof Suit)[keyof typeof Suit]

export const SUITS: readonly Suit[] = [
  Suit.Spades,
  Suit.Diamonds,
  Suit.Clubs,
  Suit.Hearts,
]

export type Rank = '9' | 'J' | 'Q' | 'K' | '10' | 'A'

// Highest to lowest, per pinochle's non-standard rank order (10 beats King).
export const RANKS: readonly Rank[] = ['9', 'J', 'Q', 'K', '10', 'A']
export const RANK_VALUE: Record<Rank, number> = Object.fromEntries(
  RANKS.map((rank, i) => [rank, i]),
) as Record<Rank, number>

export type CopyId = 1 | 2

/** A pinochle deck holds two copies of every card (pinochle_rules.md), which
 *  is what makes 48 cards out of 24 distinct ones. Named rather than written
 *  as a literal `[1, 2]` at each use so anything counting cards — `Deck.build`
 *  below, `round.ts`'s MAX_TRICK_POINTS — derives from one place. */
export const COPIES_PER_CARD: readonly CopyId[] = [1, 2]

/** Every copy of one suit in a full deck: 6 ranks x 2 copies. Named for trump
 *  because trump is the only suit anyone counts to exhaustion — `tracker.ts`
 *  calls trump "secure" once this many are accounted for, and `trumpMemory.ts`
 *  sizes a seat's recall against it (#158). Same name and value as Python's
 *  `TOTAL_TRUMP_COPIES`, derived here rather than written as 12 so it follows
 *  the deck the way MAX_TRICK_POINTS does (#241). */
export const TOTAL_TRUMP_COPIES = RANKS.length * COPIES_PER_CARD.length

export const GAME_WIN_SCORE = 1000
export const GAME_LOSE_SCORE = -1000
// Lowest rung the auction can open at. **250 since #200** (was 300): a house
// preference, not a rules discovery. Only the opening rung moved — the minimum
// raise (10), OPENER_THRESHOLD (320, the hand an AI needs to open at all) and
// PARTNER_PASSED_FLOOR (320) are unchanged, so the AI opens on the same set of
// hands as before and simply commits to 250 rather than 300 when it does.
export const OPENING_BID = 250
// What the dealer is stuck with if everyone passes without ever bidding.
// Equal to OPENING_BID since #200, so passing the auction out no longer
// discounts anything — the dealer lands on the rung the first seat could have
// opened at. Kept as its own constant because the two mean different things
// and only one of them is a house preference.
// Coincidentally equal to round.ts's MAX_TRICK_POINTS and entirely unrelated
// to it — one is an auction floor, the other the trick points in a deck. Do
// not use either in place of the other (#178).
export const FORCED_BID = 250

export class Card {
  readonly suit: Suit
  readonly rank: Rank
  readonly copyId: CopyId

  constructor(suit: Suit, rank: Rank, copyId: CopyId) {
    this.suit = suit
    this.rank = rank
    this.copyId = copyId
  }

  get rankValue(): number {
    return RANK_VALUE[this.rank]
  }

  /**
   * True if this card outranks other in a trick-resolution context.
   * Caller is responsible for only comparing cards that are actually
   * eligible to be compared (same suit, or both trump).
   */
  beats(other: Card, trumpSuit: Suit): boolean {
    if (this.suit !== other.suit) {
      if (this.suit === trumpSuit && other.suit !== trumpSuit) return true
      if (other.suit === trumpSuit && this.suit !== trumpSuit) return false
      return false
    }
    return this.rankValue > other.rankValue
  }

  equals(other: Card): boolean {
    return (
      this.suit === other.suit &&
      this.rank === other.rank &&
      this.copyId === other.copyId
    )
  }

  toString(): string {
    return `${this.rank}${this.suit}_${this.copyId}`
  }
}

// Card-collection helpers. Pure queries over an array of cards, with no rules
// or strategy in them, which is why they live beside Card rather than in the
// module that happened to need one first: bidding.ts and tracker.ts each had
// their own byte-identical `handCount`, and trick.ts and tracker.ts their own
// `maxByRank` (#241). Python keeps the same pairing, `_hand_count` next to
// `_suit_length`.

/** How many copies of one exact card (suit + rank) a hand holds: 0, 1 or 2. */
export function handCount(hand: readonly Card[], suit: Suit, rank: Rank): number {
  return hand.reduce((count, c) => count + (c.suit === suit && c.rank === rank ? 1 : 0), 0)
}

/** How many cards of a suit a hand holds. */
export function suitLength(hand: readonly Card[], suit: Suit): number {
  return hand.reduce((count, c) => count + (c.suit === suit ? 1 : 0), 0)
}

/** Highest-ranked card of a non-empty set, in pinochle rank order (10 beats
 *  King). Ties keep the first element, since only a strictly greater rank
 *  replaces the running best — the same stability Python's `max()` has.
 *  Compares rank alone, so the caller is responsible for passing cards that
 *  are actually comparable (one suit, or all trump). */
export function maxByRank(cards: readonly Card[]): Card {
  return cards.reduce((best, c) => (c.rankValue > best.rankValue ? c : best))
}

/** Lowest-ranked card of a non-empty set. Mirror of `maxByRank`, same caveats. */
export function minByRank(cards: readonly Card[]): Card {
  return cards.reduce((lowest, c) => (c.rankValue < lowest.rankValue ? c : lowest))
}

/**
 * Sort a hand for human display only: grouped by suit (Spades, Diamonds,
 * Clubs, Hearts — `SUITS` order), highest rank to lowest within each suit
 * (A, 10, K, Q, J, 9). Purely a UI convenience — game logic never depends
 * on hand order, so this is safe to apply anywhere a human's own hand
 * renders without touching gameplay state.
 */
export function sortHandForDisplay(hand: readonly Card[]): Card[] {
  return [...hand].sort((a, b) => {
    if (a.suit !== b.suit) return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit)
    if (a.rankValue !== b.rankValue) return b.rankValue - a.rankValue
    return a.copyId - b.copyId
  })
}

export class Deck {
  cards: Card[]

  constructor() {
    this.cards = Deck.build()
  }

  static build(): Card[] {
    const cards: Card[] = []
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        for (const copyId of COPIES_PER_CARD) {
          cards.push(new Card(suit, rank, copyId))
        }
      }
    }
    if (cards.length !== 48) {
      throw new Error(`expected 48 cards, built ${cards.length}`)
    }
    return cards
  }

  shuffle(): void {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]]
    }
  }

  /** Deal 12 cards to each of 4 hands, emptying the deck. */
  deal(): [Card[], Card[], Card[], Card[]] {
    if (this.cards.length !== 48) {
      throw new Error(`expected 48 cards to deal, have ${this.cards.length}`)
    }
    const hands = [0, 1, 2, 3].map((i) =>
      this.cards.slice(i * 12, (i + 1) * 12),
    ) as [Card[], Card[], Card[], Card[]]
    this.cards = []
    return hands
  }
}

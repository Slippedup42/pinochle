// Card / Deck — ported from pinochle_engine.py (frozen Python reference).

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

export const GAME_WIN_SCORE = 1000
export const GAME_LOSE_SCORE = -1000
export const OPENING_BID = 300
// What the dealer is stuck with if everyone passes without ever bidding.
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

export class Deck {
  cards: Card[]

  constructor() {
    this.cards = Deck.build()
  }

  static build(): Card[] {
    const cards: Card[] = []
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        for (const copyId of [1, 2] as const) {
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

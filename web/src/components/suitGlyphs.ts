import { Suit } from '../engine/card'

// Code-drawn, not image assets — see issue #24. The four suit symbols
// (♠♥♦♣) have solid cross-platform font coverage; the Unicode "Playing
// Cards" block (🂡 etc.) does not and is deliberately not used here.
// Shared between PlayingCard and any other component that needs to show
// a suit (e.g. the scoreboard's trump indicator).
export const SUIT_GLYPH: Record<Suit, string> = {
  [Suit.Spades]: '♠',
  [Suit.Hearts]: '♥',
  [Suit.Diamonds]: '♦',
  [Suit.Clubs]: '♣',
}

export const RED_SUITS: readonly Suit[] = [Suit.Hearts, Suit.Diamonds]

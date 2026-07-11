import { type Rank, Suit } from '../engine/card'

// Code-drawn, not image assets — see issue #24. The four suit symbols
// (♠♥♦♣) have solid cross-platform font coverage; the Unicode "Playing
// Cards" block (🂡 etc.) does not and is deliberately not used here.
const SUIT_GLYPH: Record<Suit, string> = {
  [Suit.Spades]: '♠',
  [Suit.Hearts]: '♥',
  [Suit.Diamonds]: '♦',
  [Suit.Clubs]: '♣',
}

const RED_SUITS: readonly Suit[] = [Suit.Hearts, Suit.Diamonds]

export interface PlayingCardProps {
  suit: Suit
  rank: Rank
  /** Render the card back instead of its face. */
  faceDown?: boolean
  className?: string
}

/**
 * A single playing card face, drawn in CSS/Tailwind. The card face is a
 * fixed off-white regardless of app theme (dark/light) — real cards don't
 * change color with the room lights, and it keeps contrast high against
 * either a light or dark table background by construction.
 */
export function PlayingCard({ suit, rank, faceDown, className = '' }: PlayingCardProps) {
  if (faceDown) {
    return (
      <div
        role="img"
        aria-label="face-down card"
        className={`aspect-5/7 w-20 rounded-lg border border-blue-950 bg-blue-800 bg-[repeating-linear-gradient(45deg,theme(colors.blue.700)_0,theme(colors.blue.700)_4px,theme(colors.blue.800)_4px,theme(colors.blue.800)_8px)] shadow-sm ${className}`}
      />
    )
  }

  const glyph = SUIT_GLYPH[suit]
  const colorClass = RED_SUITS.includes(suit) ? 'text-red-600' : 'text-neutral-900'

  return (
    <div
      role="img"
      aria-label={`${rank} of ${suit}`}
      className={`relative aspect-5/7 w-20 rounded-lg border border-neutral-300 bg-neutral-50 shadow-sm select-none ${colorClass} ${className}`}
    >
      <div className="absolute top-1 left-1.5 flex flex-col items-center text-sm leading-none font-semibold">
        <span>{rank}</span>
        <span>{glyph}</span>
      </div>
      <div className="absolute right-1.5 bottom-1 flex rotate-180 flex-col items-center text-sm leading-none font-semibold">
        <span>{rank}</span>
        <span>{glyph}</span>
      </div>
      <div className="flex h-full w-full items-center justify-center text-3xl">{glyph}</div>
    </div>
  )
}

import { type Rank, type Suit } from '../engine/card'
import { RED_SUITS, SUIT_GLYPH } from './suitGlyphs'

/**
 * Card sizes, as matched sets of width + corner/centre type scale.
 *
 * Size is a prop rather than something a caller passes through `className`
 * because Tailwind resolves conflicting utilities by their order in the
 * generated stylesheet, not by their order in the class attribute. A caller
 * passing `w-6` alongside the base `w-20` silently lost — `w-6` sorts first,
 * so `w-20` won and the card rendered full size (#94). Keeping width here
 * means there is never a competing utility to lose to, and the type scale
 * stays proportional to the card instead of overflowing it.
 */
const CARD_SIZES = {
  /** Compact, for dense read-only displays like meld declaration. */
  sm: { width: 'w-9', corner: 'text-[0.5rem]', cornerPos: 'top-0.5 left-1', centre: 'text-lg' },
  /** The fanned hand in a seat. */
  md: { width: 'w-[60px]', corner: 'text-sm', cornerPos: 'top-1 left-1.5', centre: 'text-3xl' },
  /** Full size — trick area, pass selector, pass reveal. */
  lg: { width: 'w-20', corner: 'text-sm', cornerPos: 'top-1 left-1.5', centre: 'text-3xl' },
} as const

export type PlayingCardSize = keyof typeof CARD_SIZES

export interface PlayingCardProps {
  suit: Suit
  rank: Rank
  /** Render the card back instead of its face. */
  faceDown?: boolean
  size?: PlayingCardSize
  className?: string
}

/**
 * A single playing card face, drawn in CSS/Tailwind. The card face is a
 * fixed off-white regardless of app theme (dark/light) — real cards don't
 * change color with the room lights, and it keeps contrast high against
 * either a light or dark table background by construction.
 */
export function PlayingCard({ suit, rank, faceDown, size = 'lg', className = '' }: PlayingCardProps) {
  const { width, corner, cornerPos, centre } = CARD_SIZES[size]

  if (faceDown) {
    return (
      <div
        role="img"
        aria-label="face-down card"
        className={`aspect-5/7 ${width} rounded-lg border border-blue-950 bg-blue-800 bg-[repeating-linear-gradient(45deg,theme(colors.blue.700)_0,theme(colors.blue.700)_4px,theme(colors.blue.800)_4px,theme(colors.blue.800)_8px)] shadow-sm ${className}`}
      />
    )
  }

  const glyph = SUIT_GLYPH[suit]
  const colorClass = RED_SUITS.includes(suit) ? 'text-red-600' : 'text-neutral-900'
  // The compact size has no room for the second, rotated corner index.
  const showRotatedCorner = size !== 'sm'

  return (
    <div
      role="img"
      aria-label={`${rank} of ${suit}`}
      className={`relative aspect-5/7 ${width} rounded-lg border border-neutral-300 bg-neutral-50 shadow-sm select-none ${colorClass} ${className}`}
    >
      <div className={`absolute ${cornerPos} flex flex-col items-center ${corner} leading-none font-semibold`}>
        <span>{rank}</span>
        <span>{glyph}</span>
      </div>
      {showRotatedCorner && (
        <div className={`absolute right-1.5 bottom-1 flex rotate-180 flex-col items-center ${corner} leading-none font-semibold`}>
          <span>{rank}</span>
          <span>{glyph}</span>
        </div>
      )}
      <div className={`flex h-full w-full items-center justify-center ${centre}`}>{glyph}</div>
    </div>
  )
}

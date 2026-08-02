import { type Rank, type Suit } from '../engine/card'
import { RED_SUITS, SUIT_GLYPH } from './suitGlyphs'

/**
 * Card sizes, as matched sets of width + corner/centre type scale + the
 * positions of both corner indices.
 *
 * Size is a prop rather than something a caller passes through `className`
 * because Tailwind resolves conflicting utilities by their order in the
 * generated stylesheet, not by their order in the class attribute. A caller
 * passing `w-6` alongside the base `w-20` silently lost — `w-6` sorts first,
 * so `w-20` won and the card rendered full size (#94). Keeping width here
 * means there is never a competing utility to lose to, and the type scale
 * stays proportional to the card instead of overflowing it. Everything that
 * scales with the card belongs in this table for the same reason: the rotated
 * corner's offsets used to be hardcoded in the JSX, so they stayed put while
 * the card shrank under them.
 *
 * Widths came down ~20% for #161 (lg 80 -> 64, md 60 -> 48, sm 36 -> 28): at
 * the old sizes a 12-card hand measured 564px against a 390px phone viewport.
 * `aspect-5/7` is what turns each width into a card, so the heights follow
 * (lg 112 -> 90, md 84 -> 67, sm 50 -> 39) and the ratio is unchanged.
 */
const CARD_SIZES = {
  /** Compact, for dense read-only displays like meld declaration. */
  sm: { width: 'w-7', corner: 'text-[0.5rem]', cornerPos: 'top-0 left-0.5', cornerPosAlt: 'right-0.5 bottom-0', centre: 'text-base' },
  /** The fanned hand in a seat. */
  md: { width: 'w-12', corner: 'text-xs', cornerPos: 'top-0.5 left-1', cornerPosAlt: 'right-1 bottom-0.5', centre: 'text-xl' },
  /** Full size — trick area, pass selector, pass reveal. */
  lg: { width: 'w-16', corner: 'text-xs', cornerPos: 'top-0.5 left-1', cornerPosAlt: 'right-1 bottom-0.5', centre: 'text-2xl' },
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
  const { width, corner, cornerPos, cornerPosAlt, centre } = CARD_SIZES[size]

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
        <div className={`absolute ${cornerPosAlt} flex rotate-180 flex-col items-center ${corner} leading-none font-semibold`}>
          <span>{rank}</span>
          <span>{glyph}</span>
        </div>
      )}
      <div className={`flex h-full w-full items-center justify-center ${centre}`}>{glyph}</div>
    </div>
  )
}

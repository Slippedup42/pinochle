import { type Rank, type Suit } from '../engine/card'
import { RED_SUITS, SUIT_GLYPH } from './suitGlyphs'

/**
 * Card sizes, as matched sets of width + every type size and offset that has to
 * scale with it.
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
 * Widths: `lg` went 80 -> 64 in #161 to fit a 12-card hand on a phone, and back
 * to **80** here now that #187's two rows only have to fit six. `sm` went
 * 28 -> **42** in #202 — exactly 1.5x, the size Paul asked for after his dad
 * found the meld cards hard to read. `aspect-5/7` is what turns each width into
 * a card, so the heights follow (lg 112, md 67, sm 59) and the ratio is
 * unchanged.
 *
 * **Why 42 and not more.** `sm` is only ever used inside MeldFlow's panel, whose
 * columns are ~147px on a 375px phone. Cards wrap at 3 per row from 40px all the
 * way to 47px, so anything in that band costs the same rows; 48px is where it
 * drops to 2 and a five-card Run needs three rows. Measured on a real 19-card
 * meld at 375x812: the panel stands 509px tall at 28, 668 at 42, and reaches its
 * own `max-h-[85vh]` cap (690) at 48, where the list starts scrolling. 42 keeps
 * the biggest card that still leaves an ordinary hand un-scrolled.
 *
 * Everything else in a row is that row's width times a fixed fraction, which is
 * how the face stays the same face at every size:
 *
 *   rank 0.40w · suit 0.55w · watermark 1.05w · stripe max(4, 0.075w)
 *
 * The suit fraction is the one Paul picked from a rendered comparison at 0.34 /
 * 0.45 / 0.55 / 0.68. **0.68 is the hard ceiling and 0.55 is deliberately under
 * it**: `Seat.tsx` fans the hand at a 0.6875w reveal, so an index wider than
 * that is the part of the card the next card covers.
 */
const CARD_SIZES = {
  /** Compact, for dense read-only displays like meld declaration. */
  sm: { width: 'w-10.5', rankSize: 'text-[17px]', suitSize: 'text-[23px]', markSize: 'text-[44px]', stripe: 'w-1', indexLeft: 'left-[7px]' },
  /** An AI seat's exposed hand during meld. */
  md: { width: 'w-12', rankSize: 'text-[19px]', suitSize: 'text-[26px]', markSize: 'text-[50px]', stripe: 'w-1', indexLeft: 'left-[7px]' },
  /** Full size — the human's hand, trick area, pass selector, pass reveal. */
  lg: { width: 'w-20', rankSize: 'text-[32px]', suitSize: 'text-[44px]', markSize: 'text-[84px]', stripe: 'w-1.5', indexLeft: 'left-[11px]' },
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
 *
 * **Jumbo index, not a pip field.** The face is one oversized rank-over-suit
 * index in the top-left, a faint suit watermark filling the rest, and a
 * suit-coloured stripe down the left edge. That shape is chosen for one
 * specific reading condition rather than for looks: `Seat.tsx` fans the hand
 * with a negative margin, so for eleven of twelve cards **the only part on
 * screen is a ~0.69w strip of the left edge**. The previous face put a single
 * centred glyph there and a 0.22w index in the corner, which meant a fanned
 * hand was a row of near-identical white rectangles and the rank was the
 * smallest thing on the card. Everything here is placed inside that strip.
 *
 * The stripe is the part that survives even a heavier overlap, since it sits at
 * x=0. It is `bg-current`, so it inherits the same two-colour suit mapping as
 * the index rather than restating it.
 *
 * `overflow-hidden` is load-bearing twice over: it clips the stripe to the
 * rounded corners, and it crops the watermark, which is deliberately larger
 * than the card and offset past two edges.
 */
export function PlayingCard({ suit, rank, faceDown, size = 'lg', className = '' }: PlayingCardProps) {
  const { width, rankSize, suitSize, markSize, stripe, indexLeft } = CARD_SIZES[size]

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

  return (
    <div
      role="img"
      aria-label={`${rank} of ${suit}`}
      className={`relative aspect-5/7 ${width} overflow-hidden rounded-lg border border-neutral-300 bg-neutral-50 shadow-sm select-none ${colorClass} ${className}`}
    >
      <div className={`absolute inset-y-0 left-0 ${stripe} bg-current`} />
      <div className={`absolute -right-[6%] -bottom-[8%] ${markSize} leading-none opacity-15`} aria-hidden="true">
        {glyph}
      </div>
      <div className={`absolute top-[4%] ${indexLeft} flex flex-col items-center leading-[0.95] font-extrabold`}>
        <span className={rankSize}>{rank}</span>
        <span className={suitSize}>{glyph}</span>
      </div>
    </div>
  )
}

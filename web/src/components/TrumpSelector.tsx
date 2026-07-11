import { SUITS } from '../engine/card'
import type { Suit } from '../engine/card'
import { SUIT_NAME } from './auctionTypes'
import { RED_SUITS, SUIT_GLYPH } from './suitGlyphs'

export interface TrumpSelectorProps {
  onSelect: (suit: Suit) => void
}

/**
 * Human trump call after winning the bid (#34). Shown once, right after
 * the auction resolves in the human's favor — passing.ts's bidder/partner
 * split needs `trumpSuit` before the pass phase can run.
 */
export function TrumpSelector({ onSelect }: TrumpSelectorProps) {
  return (
    <div className="w-full max-w-xs rounded-lg bg-white p-4 text-neutral-900 shadow-xl">
      <h3 className="text-sm font-semibold">Name trump</h3>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {SUITS.map((suit) => {
          const colorClass = RED_SUITS.includes(suit) ? 'text-red-600' : 'text-neutral-900'
          return (
            <button
              key={suit}
              type="button"
              onClick={() => onSelect(suit)}
              className="flex items-center justify-center gap-2 rounded border border-neutral-300 px-3 py-2 font-semibold hover:bg-neutral-100"
            >
              <span className={`text-lg ${colorClass}`}>{SUIT_GLYPH[suit]}</span>
              <span>{SUIT_NAME[suit]}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

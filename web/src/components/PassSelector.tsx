import { useState } from 'react'
import type { Card, Suit } from '../engine/card'
import { sortHandForDisplay } from '../engine/card'
import { PlayingCard } from './PlayingCard'
import { RED_SUITS, SUIT_GLYPH } from './suitGlyphs'

export interface PassSelectorProps {
  hand: readonly Card[]
  /** How many cards must be selected before Confirm is enabled — passing.ts's `PASS_COUNT`. */
  count: number
  /** Trump is already settled by the time passing happens — shown here so
   * the player doesn't have to hunt for it in the (dimmed, overlay-covered)
   * header while deciding what to pass. */
  trumpSuit: Suit
  onConfirm: (cards: Card[]) => void
}

/**
 * Card-selection UI for the human's half of the 3-card pass (#34): the
 * partner's send-to-bidder pass, or the bidder's send-back-to-partner
 * pass, whichever the human is holding at the time. AuctionFlow decides
 * which hand/role this renders for; this component just enforces "exactly
 * `count` selected" before letting the player confirm.
 */
export function PassSelector({ hand, count, trumpSuit, onConfirm }: PassSelectorProps) {
  const [selected, setSelected] = useState<Card[]>([])
  const trumpColor = RED_SUITS.includes(trumpSuit) ? 'text-red-600' : 'text-neutral-900'

  const toggle = (card: Card) => {
    setSelected((prev) => {
      if (prev.includes(card)) return prev.filter((c) => c !== card)
      if (prev.length >= count) return prev
      return [...prev, card]
    })
  }

  return (
    <div className="w-full max-w-2xl rounded-lg bg-white p-4 text-neutral-900 shadow-xl">
      <h3 className="text-sm font-semibold">
        Choose {count} cards to pass ({selected.length}/{count} selected) — Trump:{' '}
        <span className={`text-base font-bold ${trumpColor}`}>{SUIT_GLYPH[trumpSuit]}</span>
      </h3>
      <div className="mt-3 flex flex-wrap justify-center gap-1">
        {sortHandForDisplay(hand).map((card) => {
          const isSelected = selected.includes(card)
          return (
            <button
              key={card.toString()}
              type="button"
              onClick={() => toggle(card)}
              aria-pressed={isSelected}
              className={`rounded-lg transition-transform ${isSelected ? '-translate-y-3 ring-2 ring-amber-500' : ''}`}
            >
              <PlayingCard suit={card.suit} rank={card.rank} />
            </button>
          )
        })}
      </div>
      <button
        type="button"
        disabled={selected.length !== count}
        onClick={() => onConfirm(selected)}
        className="mt-4 w-full rounded bg-green-800 px-4 py-2 font-semibold text-white hover:bg-green-900 disabled:cursor-not-allowed disabled:bg-neutral-300"
      >
        Confirm pass
      </button>
    </div>
  )
}

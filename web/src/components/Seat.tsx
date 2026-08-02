import type { Card } from '../engine/card'
import { sortHandForDisplay } from '../engine/card'
import { PlayingCard } from './PlayingCard'
import type { SeatPosition, SeatState } from './tableTypes'

export interface SeatProps {
  seat: SeatState
  position: SeatPosition
  isHuman: boolean
  isBidWinner: boolean
  isDealer: boolean
  /** Trick-play (#35): legal cards for the human's turn to play, and the
   * callback to fire on a legal card's click/tap. Legal cards render
   * highlighted and clickable; illegal ones render dimmed and disabled.
   * Omit entirely to render the hand as plain, non-interactive cards (the
   * auction phases, or any AI seat). */
  playable?: { legalCards: readonly Card[]; onPlay: (card: Card) => void }
  /** Meld phase (#??): when true, a non-human seat renders its cards face-up
   * (meld cards laid on the table) instead of just its name/card count. Meld
   * is public information in Pinochle — it is laid down for everyone to see —
   * so this is a rules requirement, not a display preference. */
  exposeCards?: boolean
}

const POSITION_LAYOUT: Record<SeatPosition, string> = {
  bottom: 'flex-col items-center',
  top: 'flex-col-reverse items-center',
  left: 'flex-col items-center',
  right: 'flex-col items-center',
}

/**
 * One seat at the table. The human seat renders its full hand face-up with
 * the real `PlayingCard` component. AI seats render no fan at all (#142) —
 * just the name and card count in the header, which is the public
 * information a player needs to track how many tricks are left. The one
 * exception is `exposeCards` during the meld phase, where an AI's cards are
 * laid face-up because meld is public.
 */
export function Seat({ seat, position, isHuman, isBidWinner, isDealer, playable, exposeCards }: SeatProps) {
  return (
    <div className={`flex gap-1 ${POSITION_LAYOUT[position]}`}>
      <div className="flex items-center gap-2 text-sm font-medium">
        <span>{seat.name}</span>
        {isDealer && (
          <span className="rounded bg-neutral-700/80 px-1.5 py-0.5 text-xs font-bold text-amber-300">
            D
          </span>
        )}
        {isBidWinner && (
          <span className="rounded bg-amber-500/90 px-1.5 py-0.5 text-xs font-semibold text-amber-950">
            Bid
          </span>
        )}
        {!isHuman && (
          <span className="text-xs text-white/70">{seat.hand.length} cards</span>
        )}
      </div>
      {seat.statusText && (
        <div className="text-xs text-white/60">{seat.statusText}</div>
      )}
      {isHuman ? (
        // A single row, not `flex-wrap`: the fanned-overlap look below relies
        // on `first:ml-0` to zero out the leading card's negative margin, which
        // only identifies the true first card in the DOM — with wrapping on, a
        // second row's leading card still carried the big negative margin and
        // rendered shifted/misaligned relative to the row above it. One row
        // that scrolls horizontally instead keeps every row's cards flush.
        <div className="flex justify-center gap-1 overflow-x-auto">
          {sortHandForDisplay(seat.hand).map((card) => {
            const cardFace = <PlayingCard suit={card.suit} rank={card.rank} />
            if (!playable) {
              return (
                <div key={card.toString()} className="-ml-10 first:ml-0">
                  {cardFace}
                </div>
              )
            }
            const isLegal = playable.legalCards.includes(card)
            return (
              <button
                key={card.toString()}
                type="button"
                disabled={!isLegal}
                onClick={() => playable.onPlay(card)}
                aria-label={`Play ${card.rank} of ${card.suit}`}
                className={`-ml-10 first:ml-0 rounded-lg transition-transform ${
                  isLegal
                    ? 'cursor-pointer ring-2 ring-amber-400 hover:-translate-y-2'
                    : 'cursor-not-allowed opacity-40'
                }`}
              >
                {cardFace}
              </button>
            )
          })}
        </div>
      ) : exposeCards ? (
        <div className="flex justify-center gap-1 overflow-x-auto">
          {sortHandForDisplay(seat.hand).map((card, i) => (
            <div key={i} className="-ml-10 first:ml-0">
              <PlayingCard suit={card.suit} rank={card.rank} size="md" />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

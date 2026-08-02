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
      {/* Wraps and breaks (#161): the left/right seats live in columns that are
          allowed to fall to zero width, and a nowrap header of "Beauregard" +
          badges + "12 cards" would otherwise set a min-content floor under the
          column and widen the whole board on a phone. */}
      <div className="flex flex-wrap items-center justify-center gap-x-2 text-center text-sm font-medium [overflow-wrap:anywhere]">
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
        // -ml-11 against a 64px card leaves 24px of every card showing, which
        // is enough for the corner index and puts all 12 in 328px — inside a
        // 360px phone (#161). The overlap is paired with the card width, so
        // changing one without the other either re-overflows or hides the
        // indices. `w-full` is what makes `overflow-x-auto` mean anything: it
        // resolves against the seat's stretched width (Table.tsx), so the row
        // is as wide as the column and scrolls, instead of sizing to the fan.
        <div className="flex w-full justify-center gap-1 overflow-x-auto">
          {sortHandForDisplay(seat.hand).map((card) => {
            const cardFace = <PlayingCard suit={card.suit} rank={card.rank} />
            if (!playable) {
              return (
                <div key={card.toString()} className="-ml-11 first:ml-0">
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
                className={`-ml-11 first:ml-0 rounded-lg transition-transform ${
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
        <div className="flex w-full justify-center gap-1 overflow-x-auto">
          {/* Same 24px reveal as the human fan above, against a 48px `md` card. */}
          {sortHandForDisplay(seat.hand).map((card, i) => (
            <div key={i} className="-ml-7 first:ml-0">
              <PlayingCard suit={card.suit} rank={card.rank} size="md" />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

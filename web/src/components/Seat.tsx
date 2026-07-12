import type { Card } from '../engine/card'
import { type Rank, sortHandForDisplay, Suit } from '../engine/card'
import { PlayingCard } from './PlayingCard'
import type { SeatPosition, SeatState } from './tableTypes'

export interface SeatProps {
  seat: SeatState
  position: SeatPosition
  isHuman: boolean
  isBidWinner: boolean
  /** Trick-play (#35): legal cards for the human's turn to play, and the
   * callback to fire on a legal card's click/tap. Legal cards render
   * highlighted and clickable; illegal ones render dimmed and disabled.
   * Omit entirely to render the hand as plain, non-interactive cards (the
   * auction phases, or any AI seat). */
  playable?: { legalCards: readonly Card[]; onPlay: (card: Card) => void }
  /** Options toggle (#54): when true, an AI seat renders only its name/card
   * count — the face-down fan is skipped entirely to save screen space.
   * No-op for the human seat, which always renders its real hand. */
  hideOpponentHand?: boolean
}

// Placeholder face used for AI seats' face-down fan. The suit/rank props
// are required by PlayingCard but are never rendered when faceDown is
// set, so these values are arbitrary — no hidden information leaks here.
const FACE_DOWN_SUIT: Suit = Suit.Spades
const FACE_DOWN_RANK: Rank = '9'

const POSITION_LAYOUT: Record<SeatPosition, string> = {
  bottom: 'flex-col items-center',
  top: 'flex-col-reverse items-center',
  left: 'flex-col items-center',
  right: 'flex-col items-center',
}

/**
 * One seat at the table. The human seat renders its full hand face-up
 * with the real `PlayingCard` component; AI seats render a face-down fan
 * sized to their card count — never the actual cards, since an AI's hand
 * is hidden information from the human player's point of view.
 */
export function Seat({ seat, position, isHuman, isBidWinner, playable, hideOpponentHand }: SeatProps) {
  return (
    <div className={`flex gap-1 ${POSITION_LAYOUT[position]}`}>
      <div className="flex items-center gap-2 text-sm font-medium">
        <span>{seat.name}</span>
        {isBidWinner && (
          <span className="rounded bg-amber-500/90 px-1.5 py-0.5 text-xs font-semibold text-amber-950">
            Bid
          </span>
        )}
        {!isHuman && (
          <span className="text-xs text-white/70">{seat.hand.length} cards</span>
        )}
      </div>
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
      ) : hideOpponentHand ? null : (
        <div className="flex overflow-x-auto px-2">
          {seat.hand.map((_, i) => (
            <PlayingCard
              key={i}
              suit={FACE_DOWN_SUIT}
              rank={FACE_DOWN_RANK}
              faceDown
              className={`-ml-14 first:ml-0 ${i % 2 === 0 ? '-rotate-6' : 'rotate-6'}`}
            />
          ))}
        </div>
      )}
    </div>
  )
}

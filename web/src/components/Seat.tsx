import { type Rank, Suit } from '../engine/card'
import { PlayingCard } from './PlayingCard'
import type { SeatPosition, SeatState } from './tableTypes'

export interface SeatProps {
  seat: SeatState
  position: SeatPosition
  isHuman: boolean
  isBidWinner: boolean
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
export function Seat({ seat, position, isHuman, isBidWinner }: SeatProps) {
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
        <div className="flex flex-wrap justify-center gap-1 overflow-x-auto">
          {seat.hand.map((card) => (
            <PlayingCard
              key={card.toString()}
              suit={card.suit}
              rank={card.rank}
              className="-ml-10 first:ml-0"
            />
          ))}
        </div>
      ) : (
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

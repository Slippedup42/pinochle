import type { PlayerIndex, TrickPlay } from '../engine/trick'
import { PlayingCard } from './PlayingCard'
import { seatPosition, type SeatPosition } from './tableTypes'

export interface TrickAreaProps {
  trick: readonly TrickPlay[]
  humanPlayer: PlayerIndex
}

const POSITION_CLASS: Record<SeatPosition, string> = {
  top: 'col-start-2 row-start-1',
  left: 'col-start-1 row-start-2',
  right: 'col-start-3 row-start-2',
  bottom: 'col-start-2 row-start-3',
}

/**
 * Center-of-table area: the cards played so far in the current trick,
 * each placed on the side of the center matching its player's seat. Empty
 * until a seat has played, so a trick in progress shows 1-3 cards and a
 * completed-but-not-yet-cleared trick shows all 4.
 */
export function TrickArea({ trick, humanPlayer }: TrickAreaProps) {
  return (
    <div className="grid aspect-square w-full max-w-72 grid-cols-3 grid-rows-3 items-center justify-items-center rounded-full bg-green-950/40">
      {trick.map((play) => (
        <div key={play.player} className={POSITION_CLASS[seatPosition(play.player, humanPlayer)]}>
          <PlayingCard suit={play.card.suit} rank={play.card.rank} />
        </div>
      ))}
    </div>
  )
}

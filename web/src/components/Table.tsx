import { Scoreboard } from './Scoreboard'
import { Seat } from './Seat'
import { seatPosition, type SeatPosition, type TableState } from './tableTypes'
import { TrickArea } from './TrickArea'

export interface TableProps {
  state: TableState
}

const POSITION_GRID_CLASS: Record<SeatPosition, string> = {
  top: 'col-start-2 row-start-1',
  left: 'col-start-1 row-start-2',
  right: 'col-start-3 row-start-2',
  bottom: 'col-start-2 row-start-3',
}

/**
 * Static table layout scaffold (#33): four seats around a center trick
 * area, with a scoreboard strip up top. No interaction yet — bid/pass
 * and trick-play controls (separate issues) will mount into this shell,
 * most likely inside/near the human seat and the TrickArea respectively.
 */
export function Table({ state }: TableProps) {
  const { seats, humanPlayer, trick, trumpSuit, currentBid, bidWinner, scoresByTeam } = state
  const bidWinnerSeat = seats.find((seat) => seat.player === bidWinner)

  return (
    <div className="flex min-h-svh flex-col bg-green-900 text-white">
      <Scoreboard
        scoresByTeam={scoresByTeam}
        currentBid={currentBid}
        bidWinnerName={bidWinnerSeat?.name ?? `Player ${bidWinner}`}
        trumpSuit={trumpSuit}
      />
      <div className="grid flex-1 grid-cols-[1fr_2fr_1fr] grid-rows-[1fr_2fr_1fr] items-center justify-items-center gap-4 p-4">
        {seats.map((seat) => (
          <div
            key={seat.player}
            className={POSITION_GRID_CLASS[seatPosition(seat.player, humanPlayer)]}
          >
            <Seat
              seat={seat}
              position={seatPosition(seat.player, humanPlayer)}
              isHuman={seat.player === humanPlayer}
              isBidWinner={seat.player === bidWinner}
            />
          </div>
        ))}
        <div className="col-start-2 row-start-2">
          <TrickArea trick={trick} humanPlayer={humanPlayer} />
        </div>
      </div>
    </div>
  )
}

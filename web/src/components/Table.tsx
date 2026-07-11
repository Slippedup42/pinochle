import type { ReactNode } from 'react'
import { Scoreboard } from './Scoreboard'
import { Seat } from './Seat'
import { seatPosition, type SeatPosition, type TableState } from './tableTypes'
import { TrickArea } from './TrickArea'

export interface TableProps {
  state: TableState
  /** Centered modal-style slot (bid controls, trump call, pass selector,
   * round summary, ...) rendered above the table. Optional so existing
   * callers that just want the static scaffold don't need to pass one. */
  overlay?: ReactNode
  /** Corner slot for a non-blocking feed (the auction/pass event log, #34)
   * that should stay visible alongside the table rather than covering it. */
  logPanel?: ReactNode
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
export function Table({ state, overlay, logPanel }: TableProps) {
  const { seats, humanPlayer, trick, trumpSuit, currentBid, bidWinner, scoresByTeam } = state
  const bidWinnerSeat = bidWinner === null ? undefined : seats.find((seat) => seat.player === bidWinner)

  return (
    <div className="relative flex min-h-svh flex-col bg-green-900 text-white">
      <Scoreboard
        scoresByTeam={scoresByTeam}
        currentBid={currentBid}
        bidWinnerName={bidWinnerSeat?.name}
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
      {logPanel && <div className="absolute top-16 right-2">{logPanel}</div>}
      {overlay && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/40 p-4">{overlay}</div>
      )}
    </div>
  )
}

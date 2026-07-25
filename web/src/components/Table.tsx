import { useEffect, type ReactNode } from 'react'
import { Scoreboard } from './Scoreboard'
import { Seat } from './Seat'
import { seatPosition, type SeatPosition, type TableState } from './tableTypes'
import { TrickArea } from './TrickArea'
import { useDraggable } from './useDraggable'

export interface TableProps {
  state: TableState
  /** Centered modal-style slot (bid controls, trump call, pass selector,
   * round summary, ...) rendered above the table. Optional so existing
   * callers that just want the static scaffold don't need to pass one. */
  overlay?: ReactNode
  /** Corner slot for a non-blocking feed (the auction/pass event log, #34)
   * that should stay visible alongside the table rather than covering it. */
  logPanel?: ReactNode
  /** Local autosave (#54): opens the persistent mid-game menu (New Game /
   * Continue / Options) so a player is never stranded once a round has
   * started. Rendered as a small corner button; omitted entirely (no
   * button) when not provided. */
  onOpenMenu?: () => void
  /** Options toggle (#54): when true, don't render the West/Partner/East
   * face-down card fans at all — just the seat label and board, to save
   * screen space. UI-only preference, not game state, so it lives here
   * rather than on TableState. */
  hideOpponentCards?: boolean
  /** 1-based trick number for display (e.g. "Trick 3 of 12"). Omitted outside
   * trick-play so TrickArea doesn't show a counter during the auction/meld
   * phases. */
  trickNumber?: number
  /** Meld phase: when true, non-human seats render their cards face-up (meld
   * cards on the table) instead of face-down or hidden. */
  exposeCards?: boolean
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
export function Table({ state, overlay, logPanel, onOpenMenu, hideOpponentCards, trickNumber, exposeCards }: TableProps) {
  const { onMouseDown, onMouseMove, onMouseUp } = useDraggable()

  useEffect(() => {
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('touchmove', onMouseMove as EventListener, { passive: false })
    document.addEventListener('touchend', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('touchmove', onMouseMove as EventListener)
      document.removeEventListener('touchend', onMouseUp)
    }
  }, [onMouseMove, onMouseUp])
  const {
    seats,
    humanPlayer,
    trick,
    trumpSuit,
    currentBid,
    bidWinner,
    scoresByTeam,
    teamNames,
    humanPlayable,
    trickWinner,
    meldPoints,
  } = state
  const bidWinnerSeat = bidWinner === null ? undefined : seats.find((seat) => seat.player === bidWinner)

  return (
    <div className="relative flex min-h-svh flex-col bg-green-900 text-white">
      {onOpenMenu && (
        <button
          type="button"
          onClick={onOpenMenu}
          aria-label="Open menu"
          className="absolute top-2 left-2 z-10 rounded bg-black/40 px-2 py-1 text-xs font-semibold text-white hover:bg-black/60"
        >
          ☰ Menu
        </button>
      )}
      <Scoreboard
        scoresByTeam={scoresByTeam}
        teamNames={teamNames}
        currentBid={currentBid}
        bidWinnerName={bidWinnerSeat?.name}
        trumpSuit={trumpSuit}
        meldPoints={meldPoints}
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
              isDealer={seat.player === state.dealer}
              playable={seat.player === humanPlayer ? humanPlayable : undefined}
              hideOpponentHand={hideOpponentCards}
              exposeCards={seat.player !== humanPlayer ? exposeCards : undefined}
            />
          </div>
        ))}
        <div className="col-start-2 row-start-2">
          <TrickArea trick={trick} humanPlayer={humanPlayer} winningPlayer={trickWinner} trickNumber={trickNumber} />
        </div>
      </div>
      {logPanel && <div className="fixed top-16 right-2 z-30">{logPanel}</div>}
      {overlay && (
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onMouseDown={onMouseDown} onTouchStart={onMouseDown}>
          <div data-draggable className="inline-block cursor-grab">
            {overlay}
          </div>
        </div>
      )}
    </div>
  )
}

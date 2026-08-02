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
  /** 1-based trick number for display (e.g. "Trick 3 of 12"). Omitted outside
   * trick-play so TrickArea doesn't show a counter during the auction/meld
   * phases. */
  trickNumber?: number
  /** Meld phase: when true, non-human seats render their cards face-up (meld
   * cards on the table) instead of just their name and card count. */
  exposeCards?: boolean
}

/**
 * Where each seat sits in the 3x3 board.
 *
 * The top and bottom seats span the full width (#161). Pinned to the centre
 * column they got half the board, which is not enough for a hand: the human's
 * 12-card fan measured 564px against a 390px phone.
 *
 * Every seat is `justify-self-stretch min-w-0`, overriding the grid's
 * `justify-items-center` (which is still what centres the trick circle). A
 * centred grid item is sized by its own content, and a fanned hand's
 * min-content width is the whole fan — `overflow-x-auto` does not reduce it —
 * so a seat sized itself to its cards and then overflowed its column no matter
 * how narrow the column was. Stretching gives the seat the column's width and
 * `min-w-0` lets that width actually be smaller than the cards, which is what
 * finally hands the fan a definite width to scroll inside.
 */
const SEAT_CELL_CLASS = 'min-w-0 justify-self-stretch'
const POSITION_GRID_CLASS: Record<SeatPosition, string> = {
  top: `col-span-full row-start-1 ${SEAT_CELL_CLASS}`,
  left: `col-start-1 row-start-2 ${SEAT_CELL_CLASS}`,
  right: `col-start-3 row-start-2 ${SEAT_CELL_CLASS}`,
  bottom: `col-span-full row-start-3 ${SEAT_CELL_CLASS}`,
}

/**
 * Static table layout scaffold (#33): four seats around a center trick
 * area, with a scoreboard strip up top. No interaction yet — bid/pass
 * and trick-play controls (separate issues) will mount into this shell,
 * most likely inside/near the human seat and the TrickArea respectively.
 */
export function Table({ state, overlay, logPanel, onOpenMenu, trickNumber, exposeCards }: TableProps) {
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
    // Safe-area insets (#161, --safe-* in index.css): on an installed instance
    // the board runs under the home indicator, so the bottom/side insets come
    // off the height budget here. `box-sizing: border-box` (Tailwind preflight)
    // means this padding comes out of `min-h-svh` rather than adding to it. The
    // top inset is handled by the Scoreboard, whose own background then fills
    // the strip behind the status bar instead of leaving a bare gap.
    <div className="relative flex min-h-svh flex-col bg-green-900 pr-[var(--safe-right)] pb-[var(--safe-bottom)] pl-[var(--safe-left)] text-white">
      {onOpenMenu && (
        <button
          type="button"
          onClick={onOpenMenu}
          aria-label="Open menu"
          // Absolute offsets resolve against the padding box, i.e. the very
          // top-left corner, so this needs the inset added in explicitly or it
          // sits under the notch.
          className="absolute top-[calc(0.5rem_+_var(--safe-top))] left-[calc(0.5rem_+_var(--safe-left))] z-10 rounded bg-black/40 px-2 py-1 text-xs font-semibold text-white hover:bg-black/60"
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
      {/* Columns are capped, not proportional (#161). `1fr 2fr 1fr` let the
          centre column be sized by its contents, so the trick circle set a
          floor under the whole board and the grid was wider than the phone
          before a single card was dealt. `minmax(0, 13rem)` caps the centre at
          the circle's width and lets it shrink below that on a narrow screen,
          and `minmax(0, 1fr)` lets the side seats fall to zero rather than
          widening the board — together they make the grid physically unable to
          exceed the viewport down to ~240px. Rows stay content-sized top and
          bottom with the circle taking the slack. Gutters halved from 4 to 2
          (16px -> 8px): 32px of the 390 was board margin. */}
      <div className="grid flex-1 grid-cols-[minmax(0,1fr)_minmax(0,13rem)_minmax(0,1fr)] grid-rows-[auto_1fr_auto] items-center justify-items-center gap-2 p-2">
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
              exposeCards={seat.player !== humanPlayer ? exposeCards : undefined}
            />
          </div>
        ))}
        <div className="col-start-2 row-start-2">
          <TrickArea trick={trick} humanPlayer={humanPlayer} winningPlayer={trickWinner} trickNumber={trickNumber} />
        </div>
      </div>
      {/* Fixed to the viewport, so the root's safe-area padding doesn't reach
          it — both of these carry the insets themselves. */}
      {logPanel && (
        <div className="fixed top-[calc(4rem_+_var(--safe-top))] right-[calc(0.5rem_+_var(--safe-right))] z-30">
          {logPanel}
        </div>
      )}
      {overlay && (
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 pt-[calc(1rem_+_var(--safe-top))] pr-[calc(1rem_+_var(--safe-right))] pb-[calc(1rem_+_var(--safe-bottom))] pl-[calc(1rem_+_var(--safe-left))]"
          onMouseDown={onMouseDown}
          onTouchStart={onMouseDown}
        >
          <div data-draggable className="inline-block cursor-grab">
            {overlay}
          </div>
        </div>
      )}
    </div>
  )
}

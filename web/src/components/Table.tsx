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
  /** Trick play: concede the hand, rendered in the Scoreboard strip. Omitted
   * everywhere else. */
  onConcede?: () => void
  /** 1-based trick number for display (e.g. "Trick 3 of 12"). Omitted outside
   * trick-play so TrickArea doesn't show a counter during the auction/meld
   * phases. */
  trickNumber?: number
  /** Meld phase: when true, non-human seats render their cards face-up (meld
   * cards on the table) instead of just their name and card count. */
  exposeCards?: boolean
  /** `'stacked'` swaps the 3x3 board for a column built around a docked slot:
   * the circle on top, `dock` under it, the human's hand at the bottom. The
   * other three seats are not drawn as seats at all — their names ride in the
   * circle at their own side of it, and nothing else about them (a card count
   * that reads the same for everyone) earns the room.
   *
   * Paul asked for it on the auction first and then for trick play to match.
   * On a phone the 3x3 board spends its width on two side columns that hold a
   * name each, and its height on mirroring the hand's row (see the grid's own
   * note below) — which is why the play screen showed a band of bare felt top
   * and bottom while the hand it belonged to was cut off at the bottom edge.
   * Stacking spends that room on the two things being looked at. Defaults to
   * the standard board. */
  layout?: 'board' | 'stacked'
  /** `layout="stacked"`: an in-flow slot between the circle and the hand, for a
   * panel that must not cover either (the bid controls, the pass reveal). Its
   * height is reserved even while empty, so the hand does not jump every time
   * the turn passes to and from the human. */
  dock?: ReactNode
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
export function Table({
  state,
  overlay,
  logPanel,
  onOpenMenu,
  onConcede,
  trickNumber,
  exposeCards,
  layout = 'board',
  dock,
}: TableProps) {
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
    receivedCards,
  } = state
  const bidWinnerSeat = bidWinner === null ? undefined : seats.find((seat) => seat.player === bidWinner)
  const humanSeat = seats.find((seat) => seat.player === humanPlayer)
  // Calls are derived here rather than passed in, so a caller only has to
  // populate `SeatState.call` and the circle placement follows from the seat it
  // is already describing. Seats without a call (every phase after the auction)
  // contribute nothing.
  const calls = seats.flatMap((seat) =>
    seat.call ? [{ player: seat.player, name: seat.name, call: seat.call }] : [],
  )
  // A call on a seat is what makes this the auction: `AuctionFlow` populates
  // `SeatState.call` for all four seats and every later phase clears it. The
  // stacked layout reads it to decide what the middle of the board is for —
  // a docked panel during the auction, a bigger circle once cards are being
  // played into it.
  const isAuction = calls.length > 0

  return (
    // Safe-area insets (#161, --safe-* in index.css): on an installed instance
    // the board runs under the home indicator, so the bottom/side insets come
    // off the height budget here. `box-sizing: border-box` (Tailwind preflight)
    // means this padding comes out of `min-h-svh` rather than adding to it. The
    // top inset is handled by the Scoreboard, whose own background then fills
    // the strip behind the status bar instead of leaving a bare gap.
    <div className="relative flex min-h-svh flex-col bg-green-900 pr-[var(--safe-right)] pb-[var(--safe-bottom)] pl-[var(--safe-left)] text-white">
      {/* The menu button lives inside the Scoreboard now (#187). Floated here as
          `absolute top-2 left-2 z-10` it was painted over the strip's first line
          — "☰ Menu" across "Trump: —" on a phone — and the strip had no way to
          know it was there. In the strip's own flow it cannot collide, and it
          inherits the safe-area insets the strip already carries. */}
      <Scoreboard
        scoresByTeam={scoresByTeam}
        teamNames={teamNames}
        currentBid={currentBid}
        bidWinnerName={bidWinnerSeat?.name}
        trumpSuit={trumpSuit}
        meldPoints={meldPoints}
        onOpenMenu={onOpenMenu}
        onConcede={onConcede}
      />
      {/* Columns are capped, not proportional (#161). `1fr 2fr 1fr` let the
          centre column be sized by its contents, so the trick circle set a
          floor under the whole board and the grid was wider than the phone
          before a single card was dealt. `minmax(0, 13rem)` caps the centre at
          the circle's width and lets it shrink below that on a narrow screen,
          and `minmax(0, 1fr)` lets the side seats fall to zero rather than
          widening the board — together they make the grid physically unable to
          exceed the viewport down to ~240px. Gutters halved from 4 to 2
          (16px -> 8px): 32px of the 390 was board margin.

          13rem stayed put when the cards went 64 -> 80px, so it is no longer
          "three cards across" the way #161 sized it. That is measured, not an
          oversight — see `TrickArea` for why the circle deliberately did not
          grow with the cards, and for the 5px overhang it buys.

          Rows are `1fr auto 1fr`, not `auto 1fr auto` (#187). Sizing the outer
          rows to their content and giving the slack to the middle centred the
          circle *within the middle row*, and that row is only centred on the
          board when the top and bottom seats are the same height — which they
          never are, since the bottom seat carries the human's hand and the top
          seat carries a name. At 390x844 that put the circle 37px above centre
          (row centre 416, board centre 453), and the two-row hand widened the
          gap further. Giving the middle row to the circle and splitting the
          remainder equally makes the circle's centre the board's centre by
          construction. `1fr` (min-content floor), not `minmax(0,1fr)`: the
          outer rows must never shrink below the hand they hold.

          The cost of that mirroring scales with the hand, and the 80px card
          spends what was left: the bottom seat is 252px, so the top row is 252px
          too even though it holds a name, and the board measures **exactly 844**
          on a 390x844 phone. It fits, with nothing to spare. A shorter phone
          scrolls — 375x812 is 14px over — and anything that grows the bottom
          seat or the circle costs twice its own height here. Re-measure this
          number before changing either. */}
      {layout === 'stacked' ? (
        // Circle, then dock, then hand — top to bottom, in the order a turn is
        // taken: read the table, decide, look at your cards. `flex-1` on the
        // dock gives it all the slack, which centres a panel between the circle
        // and the hand instead of leaving a gap above the hand.
        //
        // The dock's floor is `min-h-[12.5rem]` because the bid panel measures
        // ~182px at 390px wide; a floor a little above that absorbs a third
        // line of hint text. In trick play nothing is docked at all, and the
        // floor is what keeps the circle off the hand rather than letting it
        // slide down onto it between tricks.
        <div className="flex flex-1 flex-col items-center gap-2 p-2">
          <TrickArea
            trick={trick}
            humanPlayer={humanPlayer}
            winningPlayer={trickWinner}
            trickNumber={trickNumber}
            calls={calls}
            namedCalls={isAuction}
            dealer={state.dealer}
            size={isAuction ? 'md' : 'lg'}
            // Labelled only once the auction's calls are gone: during the
            // auction each name is already printed under its own call, and
            // printing it twice in one cell is how this first read.
            seatLabels={
              isAuction
                ? undefined
                : seats.flatMap((seat) =>
                    seat.player === humanPlayer ? [] : [{ player: seat.player, name: seat.name }],
                  )
            }
          />
          {/* The floor is the auction's and only the auction's: the bid panel
              measures ~182px at 390px wide, and reserving a little over that
              keeps the hand still as the turn passes to and from the human.
              Trick play docks nothing, and holding 12.5rem of felt open there
              is what left a band of empty table between the circle and the
              hand — so there the slot collapses and the circle takes the room
              instead. */}
          <div
            className={`flex w-full flex-1 items-center justify-center ${isAuction ? 'min-h-[12.5rem]' : 'min-h-0'}`}
          >
            {dock}
          </div>
          {humanSeat && (
            <div className={SEAT_CELL_CLASS}>
              <Seat
                seat={humanSeat}
                position="bottom"
                isHuman
                isBidWinner={humanSeat.player === bidWinner}
                isDealer={humanSeat.player === state.dealer}
                playable={humanPlayable}
                receivedCards={receivedCards}
              />
            </div>
          )}
        </div>
      ) : (
      <div className="grid flex-1 grid-cols-[minmax(0,1fr)_minmax(0,13rem)_minmax(0,1fr)] grid-rows-[1fr_auto_1fr] items-center justify-items-center gap-2 p-2">
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
              receivedCards={seat.player === humanPlayer ? receivedCards : undefined}
            />
          </div>
        ))}
        <div className="col-start-2 row-start-2">
          <TrickArea
            trick={trick}
            humanPlayer={humanPlayer}
            winningPlayer={trickWinner}
            trickNumber={trickNumber}
            calls={calls}
          />
        </div>
      </div>
      )}
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

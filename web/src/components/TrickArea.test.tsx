import { render, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Card, Suit } from '../engine/card'
import type { PlayerIndex } from '../engine/trick'
import { TrickArea, type SeatCallAt } from './TrickArea'
import { seatPosition } from './tableTypes'

// Queries are scoped with `within(container)`, not taken from `screen` or from
// `render()`'s own bound queries: this suite mounts many boards, the project does
// not enable RTL's auto-cleanup, and the bound queries are bound to `baseElement`
// (the whole body) rather than to the container — so both of the easier options
// see every board mounted so far. Same reason PlayingCard.test.tsx reads
// `container.firstElementChild` instead of `screen`.

const NAMES: Record<PlayerIndex, string> = { 0: 'You', 1: 'West', 2: 'Partner', 3: 'East' }

const PLAYERS: readonly PlayerIndex[] = [0, 1, 2, 3]

const CELL: Record<string, string> = {
  top: 'col-start-2 row-start-1',
  left: 'col-start-1 row-start-2',
  right: 'col-start-3 row-start-2',
  bottom: 'col-start-2 row-start-3',
}

function callsFor(entries: Partial<Record<PlayerIndex, SeatCallAt['call']>>): SeatCallAt[] {
  return PLAYERS.filter((p) => entries[p] !== undefined).map((p) => ({
    player: p,
    name: NAMES[p],
    call: entries[p]!,
  }))
}

describe('TrickArea auction calls (#191)', () => {
  it('names every kind of call, so the board is readable without its layout', () => {
    const { container } = render(
      <TrickArea
        trick={[]}
        humanPlayer={0}
        calls={callsFor({
          0: { kind: 'turn' },
          1: { kind: 'bid', amount: 320 },
          2: { kind: 'pass' },
          3: { kind: 'waiting' },
        })}
      />,
    )

    const board = within(container)
    expect(board.getByLabelText('You: to bid')).not.toBeNull()
    expect(board.getByLabelText('West: bid 320')).not.toBeNull()
    expect(board.getByLabelText('Partner: passed')).not.toBeNull()
    expect(board.getByLabelText('East: waiting')).not.toBeNull()
  })

  // The whole point of the change is *where* a call sits: "300" means nothing
  // until you know whose 300 it is, and the only thing saying so is the cell.
  // This pins a call to the same cell that seat's played card would land in, for
  // a human at each of the four PlayerIndex values — the mapping Seat, Table and
  // TrickArea all have to agree on for the board to make sense at all.
  it('places a call in the same cell as that seat’s played card, for any human seat', () => {
    for (const human of PLAYERS) {
      for (const player of PLAYERS) {
        const { container, unmount } = render(
          <TrickArea trick={[]} humanPlayer={human} calls={callsFor({ [player]: { kind: 'pass' } })} />,
        )
        expect(within(container).getByLabelText(`${NAMES[player]}: passed`).className).toContain(
          CELL[seatPosition(player, human)],
        )
        unmount()
      }
    }
  })

  it('renders the bid amount as visible text, not only as a label', () => {
    const { container } = render(
      <TrickArea trick={[]} humanPlayer={0} calls={callsFor({ 2: { kind: 'bid', amount: 340 } })} />,
    )
    expect(within(container).getByLabelText('Partner: bid 340').textContent).toBe('340')
  })

  it('shows nothing in the circle when no seat has a call', () => {
    const { container } = render(<TrickArea trick={[]} humanPlayer={0} />)
    expect(container.querySelectorAll('[role="img"]').length).toBe(0)
  })

  // Calls and cards share one 3x3 grid, so a phase that had both would stack
  // them in the same cell. Nothing does today — `trick` is empty until the
  // auction settles, and AuctionFlow is the only thing that sets calls — but the
  // sharing is deliberate, and this records that trick play alone stays clean.
  it('renders played cards with no calls once the auction is over', () => {
    const { container } = render(
      <TrickArea
        trick={[{ player: 1, card: new Card(Suit.Hearts, 'A', 1) }]}
        humanPlayer={0}
        trickNumber={3}
      />,
    )
    const board = within(container)
    expect(board.getByLabelText('A of H')).not.toBeNull()
    expect(board.queryByLabelText(/: (bid|passed|waiting|to bid)/)).toBeNull()
    expect(board.getByText('Trick 3 of 12')).not.toBeNull()
  })
})

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Card, sortHandForDisplay, Suit } from '../engine/card'
import { splitHandIntoRows } from './handRows'
import { Seat } from './Seat'
import type { SeatState } from './tableTypes'

afterEach(cleanup)

function opponentSeat(cardCount: number): SeatState {
  return {
    player: 1,
    name: 'West',
    hand: Array.from({ length: cardCount }, () => new Card(Suit.Spades, '9', 1)),
  }
}

describe('Seat', () => {
  // #142: the face-down fan is gone unconditionally — there is no prop that
  // brings it back. Name and card count stay: the count is public
  // information players use to track how many tricks are left.
  it('renders no face-down fan for an AI seat, keeping its name and card count', () => {
    render(<Seat seat={opponentSeat(3)} position="left" isHuman={false} isBidWinner={false} isDealer={false} />)
    expect(screen.queryAllByLabelText('face-down card')).toHaveLength(0)
    expect(screen.getByText('West')).not.toBeNull()
    expect(screen.getByText('3 cards')).not.toBeNull()
  })

  it('still renders the human seat’s real hand face-up', () => {
    const humanSeat: SeatState = { player: 0, name: 'You', hand: [new Card(Suit.Hearts, 'A', 1)] }
    render(<Seat seat={humanSeat} position="bottom" isHuman isBidWinner={false} isDealer={false} />)
    expect(screen.getByLabelText('A of H')).not.toBeNull()
  })

  // Meld is public information in Pinochle — it is laid down for everyone to
  // see — so exposeCards must keep showing an AI seat's cards face-up even
  // though the face-down fan is gone (#142).
  it('exposes a non-human seat’s cards face-up when exposeCards is set (meld phase)', () => {
    const meldSeat: SeatState = {
      player: 1,
      name: 'West',
      hand: [new Card(Suit.Hearts, 'K', 1), new Card(Suit.Hearts, 'Q', 1)],
    }
    render(<Seat seat={meldSeat} position="left" isHuman={false} isBidWinner={false} isDealer={false} exposeCards />)
    expect(screen.getByLabelText('K of H')).not.toBeNull()
    expect(screen.getByLabelText('Q of H')).not.toBeNull()
    expect(screen.queryAllByLabelText('face-down card')).toHaveLength(0)
  })
})

// #187: one row of 12 overflowed below ~350px, and an overflowing
// `justify-center` row centres inside its own scroll box — so the fan was
// clipped at the right with its leading cards unreachable. Two rows halve the
// width that has to fit.
describe('splitHandIntoRows', () => {
  const hand = (n: number) => Array.from({ length: n }, (_, i) => i)

  it('splits a full 12-card hand evenly', () => {
    expect(splitHandIntoRows(hand(12))).toEqual([[0, 1, 2, 3, 4, 5], [6, 7, 8, 9, 10, 11]])
  })

  it('puts the extra card on the top row for an odd hand', () => {
    // Grows upward, so an odd hand does not leave a short trailing row under a
    // full one — and the bottom row is never the wider of the two.
    expect(splitHandIntoRows(hand(11))).toEqual([[0, 1, 2, 3, 4, 5], [6, 7, 8, 9, 10]])
    expect(splitHandIntoRows(hand(7))).toEqual([[0, 1, 2, 3], [4, 5, 6]])
  })

  it('keeps a short hand on a single row', () => {
    // The last tricks play out at 1-2 cards; two rows of one card each would
    // read as a layout fault rather than a hand.
    expect(splitHandIntoRows(hand(6))).toEqual([[0, 1, 2, 3, 4, 5]])
    expect(splitHandIntoRows(hand(1))).toEqual([[0]])
    expect(splitHandIntoRows(hand(0))).toEqual([[]])
  })

  it('never leaves a row wider than the single-row limit', () => {
    // The property that actually protects the layout: whatever the hand size,
    // no row exceeds what fits a 320px viewport.
    for (let n = 0; n <= 24; n += 1) {
      for (const row of splitHandIntoRows(hand(n))) {
        expect(row.length).toBeLessThanOrEqual(Math.max(6, Math.ceil(n / 2)))
        if (n <= 12) expect(row.length).toBeLessThanOrEqual(6)
      }
    }
  })

  it('preserves the sorted order across the split', () => {
    expect(splitHandIntoRows(hand(12)).flat()).toEqual(hand(12))
  })
})

describe('Seat hand layout (#187)', () => {
  const RANKS = ['A', '10', 'K', 'Q', 'J', '9'] as const

  /** n distinct cards — `key={card.toString()}` collides on a duplicate, and a
   *  hand of repeats would silently test one card rendered n times. */
  function humanHand(n: number): SeatState {
    return {
      player: 0,
      name: 'You',
      hand: Array.from(
        { length: n },
        (_, i) => new Card(i < 6 ? Suit.Spades : Suit.Hearts, RANKS[i % RANKS.length], 1),
      ),
    }
  }

  it('lays a 12-card hand out in two rows', () => {
    const { container } = render(
      <Seat seat={humanHand(12)} position="bottom" isHuman isBidWinner={false} isDealer={false} />,
    )
    const rows = container.querySelectorAll('div.overflow-x-auto')
    expect(rows).toHaveLength(2)
    expect(rows[0].children).toHaveLength(6)
    expect(rows[1].children).toHaveLength(6)
  })

  it('gives every row its own leading card with the overlap zeroed', () => {
    // The reason this is two containers rather than one `flex-wrap` row:
    // `first:ml-0` only matches the first child of its own parent, so under
    // wrapping a visual second row kept the negative margin and hung left.
    const { container } = render(
      <Seat seat={humanHand(12)} position="bottom" isHuman isBidWinner={false} isDealer={false} />,
    )
    for (const row of container.querySelectorAll('div.overflow-x-auto')) {
      expect(row.firstElementChild?.className).toContain('first:ml-0')
    }
  })

  it('keeps the cards playable across both rows during trick play', () => {
    // The split runs inside the branch that renders cards as buttons, so a row
    // boundary must not cost the second row its click handlers or its legality
    // styling — that would make half a hand unplayable rather than just hidden.
    const seat = humanHand(12)
    // Legality has to be expressed in *display* order: the component sorts
    // before it splits, so the raw hand order says nothing about which row a
    // card lands in.
    const legalCards = [...splitHandIntoRows(sortHandForDisplay(seat.hand))[1]]
    const onPlay = vi.fn()
    const { container } = render(
      <Seat
        seat={seat}
        position="bottom"
        isHuman
        isBidWinner={false}
        isDealer={false}
        playable={{ legalCards, onPlay }}
      />,
    )
    const rows = container.querySelectorAll('div.overflow-x-auto')
    expect(rows).toHaveLength(2)
    expect(container.querySelectorAll('button')).toHaveLength(12)
    // Legality is decided per card, not per row: the enabled ones here all live
    // in the second row.
    expect([...rows[0].querySelectorAll('button')].every((b) => (b as HTMLButtonElement).disabled)).toBe(true)
    const enabled = [...rows[1].querySelectorAll('button')].filter((b) => !(b as HTMLButtonElement).disabled)
    expect(enabled).toHaveLength(6)
    fireEvent.click(enabled[0])
    expect(onPlay).toHaveBeenCalledTimes(1)
  })

  it('keeps a two-card hand on one row', () => {
    const { container } = render(
      <Seat seat={humanHand(2)} position="bottom" isHuman isBidWinner={false} isDealer={false} />,
    )
    expect(container.querySelectorAll('div.overflow-x-auto')).toHaveLength(1)
  })
})

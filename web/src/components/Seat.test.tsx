import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Card, Suit } from '../engine/card'
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

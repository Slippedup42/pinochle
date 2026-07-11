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
  it('renders a face-down fan for an AI seat by default', () => {
    render(<Seat seat={opponentSeat(3)} position="left" isHuman={false} isBidWinner={false} />)
    expect(screen.getAllByLabelText('face-down card')).toHaveLength(3)
    expect(screen.getByText('West')).not.toBeNull()
  })

  it('omits the face-down fan when hideOpponentHand is set (Options toggle, #54)', () => {
    render(<Seat seat={opponentSeat(3)} position="left" isHuman={false} isBidWinner={false} hideOpponentHand />)
    expect(screen.queryAllByLabelText('face-down card')).toHaveLength(0)
    // The seat label/count stays visible — only the card fan is hidden.
    expect(screen.getByText('West')).not.toBeNull()
  })

  it('never hides the human seat, regardless of hideOpponentHand', () => {
    const humanSeat: SeatState = { player: 0, name: 'You', hand: [new Card(Suit.Hearts, 'A', 1)] }
    render(<Seat seat={humanSeat} position="bottom" isHuman isBidWinner={false} hideOpponentHand />)
    expect(screen.getByLabelText('A of H')).not.toBeNull()
  })
})

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Card, Suit } from '../engine/card'
import { PassSelector } from './PassSelector'

afterEach(cleanup)

const hand = [
  new Card(Suit.Spades, 'A', 1),
  new Card(Suit.Hearts, 'K', 1),
  new Card(Suit.Diamonds, 'Q', 1),
  new Card(Suit.Clubs, 'J', 1),
  new Card(Suit.Spades, '9', 1),
]

describe('PassSelector', () => {
  it('shows the running selection count', () => {
    render(<PassSelector hand={hand} count={3} trumpSuit={Suit.Hearts} onConfirm={() => {}} />)
    expect(screen.getByText(/Choose 3 cards to pass \(0\/3 selected\)/)).not.toBeNull()
  })

  it('shows the trump suit so the player can see it without hunting for the header', () => {
    render(<PassSelector hand={hand} count={3} trumpSuit={Suit.Hearts} onConfirm={() => {}} />)
    const heading = screen.getByRole('heading', { name: /Choose 3 cards to pass/ })
    expect(heading.textContent).toContain('Trump: ♥')
  })

  it('keeps Confirm disabled until exactly `count` cards are selected', () => {
    render(<PassSelector hand={hand} count={3} trumpSuit={Suit.Hearts} onConfirm={() => {}} />)
    const confirm = screen.getByRole('button', { name: 'Confirm pass' })
    expect(confirm.hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('img', { name: 'A of S' }))
    fireEvent.click(screen.getByRole('img', { name: 'K of H' }))
    expect(confirm.hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('img', { name: 'Q of D' }))
    expect(confirm.hasAttribute('disabled')).toBe(false)
  })

  it('does not allow selecting more than `count` cards', () => {
    render(<PassSelector hand={hand} count={2} trumpSuit={Suit.Hearts} onConfirm={() => {}} />)
    fireEvent.click(screen.getByRole('img', { name: 'A of S' }))
    fireEvent.click(screen.getByRole('img', { name: 'K of H' }))
    fireEvent.click(screen.getByRole('img', { name: 'Q of D' }))
    expect(screen.getByText(/Choose 2 cards to pass \(2\/2 selected\)/)).not.toBeNull()
  })

  it('toggles a card back off when clicked again', () => {
    render(<PassSelector hand={hand} count={3} trumpSuit={Suit.Hearts} onConfirm={() => {}} />)
    const ace = screen.getByRole('img', { name: 'A of S' })
    fireEvent.click(ace)
    fireEvent.click(ace)
    expect(screen.getByText(/Choose 3 cards to pass \(0\/3 selected\)/)).not.toBeNull()
  })

  it('calls onConfirm with exactly the selected cards', () => {
    const onConfirm = vi.fn()
    render(<PassSelector hand={hand} count={2} trumpSuit={Suit.Hearts} onConfirm={onConfirm} />)
    fireEvent.click(screen.getByRole('img', { name: 'A of S' }))
    fireEvent.click(screen.getByRole('img', { name: 'K of H' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm pass' }))
    expect(onConfirm).toHaveBeenCalledOnce()
    const passed = onConfirm.mock.calls[0][0] as Card[]
    expect(passed).toHaveLength(2)
    expect(passed).toContain(hand[0])
    expect(passed).toContain(hand[1])
  })
})

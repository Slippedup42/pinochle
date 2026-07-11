import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Suit } from '../engine/card'
import { TrumpSelector } from './TrumpSelector'

afterEach(cleanup)

describe('TrumpSelector', () => {
  it('renders all four suits by name', () => {
    render(<TrumpSelector onSelect={() => {}} />)
    expect(screen.getByText('Spades')).not.toBeNull()
    expect(screen.getByText('Hearts')).not.toBeNull()
    expect(screen.getByText('Diamonds')).not.toBeNull()
    expect(screen.getByText('Clubs')).not.toBeNull()
  })

  it('calls onSelect with the chosen suit', () => {
    const onSelect = vi.fn()
    render(<TrumpSelector onSelect={onSelect} />)
    fireEvent.click(screen.getByText('Hearts'))
    expect(onSelect).toHaveBeenCalledWith(Suit.Hearts)
  })
})

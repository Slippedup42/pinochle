import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Card, Suit } from '../engine/card'
import { TrickLog } from './TrickLog'
import type { TrickPlayLogEntry } from './trickPlayTypes'

afterEach(cleanup)

describe('TrickLog', () => {
  it('renders nothing when there are no entries', () => {
    const { container } = render(<TrickLog entries={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders every entry, formatted', () => {
    const entries: TrickPlayLogEntry[] = [
      { kind: 'card-play', player: 0, name: 'You', card: new Card(Suit.Hearts, 'A', 1), isLead: true },
      { kind: 'trick-won', player: 2, name: 'Partner', points: 10, trickNumber: 0 },
    ]
    render(<TrickLog entries={entries} />)
    expect(screen.getByText('You led the A of Hearts')).not.toBeNull()
    expect(screen.getByText('Partner won the trick (10 points)')).not.toBeNull()
  })

  it('shows the most recent entry first', () => {
    const entries: TrickPlayLogEntry[] = [
      { kind: 'card-play', player: 0, name: 'You', card: new Card(Suit.Hearts, 'A', 1), isLead: true },
      { kind: 'card-play', player: 1, name: 'West', card: new Card(Suit.Hearts, '9', 1), isLead: false },
    ]
    render(<TrickLog entries={entries} />)
    const items = screen.getAllByRole('listitem')
    expect(items[0].textContent).toBe('West played the 9 of Hearts')
    expect(items[1].textContent).toBe('You led the A of Hearts')
  })
})

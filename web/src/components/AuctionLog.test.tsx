import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AuctionLogEntry } from './auctionTypes'
import { AuctionLog } from './AuctionLog'

afterEach(cleanup)

describe('AuctionLog', () => {
  it('renders nothing when there are no entries', () => {
    const { container } = render(<AuctionLog entries={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders every entry, formatted', () => {
    const entries: AuctionLogEntry[] = [
      { kind: 'bid', player: 1, name: 'West', amount: 300 },
      { kind: 'pass-bid', player: 2, name: 'Partner' },
    ]
    render(<AuctionLog entries={entries} />)
    expect(screen.getByText('West bid 300')).not.toBeNull()
    expect(screen.getByText('Partner passed')).not.toBeNull()
  })

  it('shows the most recent entry first', () => {
    const entries: AuctionLogEntry[] = [
      { kind: 'bid', player: 1, name: 'West', amount: 300 },
      { kind: 'bid', player: 3, name: 'East', amount: 310 },
    ]
    render(<AuctionLog entries={entries} />)
    const items = screen.getAllByRole('listitem')
    expect(items[0].textContent).toBe('East bid 310')
    expect(items[1].textContent).toBe('West bid 300')
  })
})

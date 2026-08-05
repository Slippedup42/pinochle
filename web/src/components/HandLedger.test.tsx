import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Suit } from '../engine/card'
import { HandLedger } from './HandLedger'
import type { HandLedgerEntry } from './scoreTypes'

// See RoundSummary.test.tsx: no global `afterEach` is wired up for
// @testing-library/react's automatic cleanup, so each render() here would
// otherwise persist into the next test's DOM.
afterEach(cleanup)

const TEAM_NAMES = { 0: 'Team A', 1: 'Team B' } as const

/** A three-hand game that goes up, down, up for team 0 — the shape the
 * ledger exists to show. */
const entries: readonly HandLedgerEntry[] = [
  {
    hand: 1,
    bidWinnerTeam: 0,
    bid: 250,
    trumpSuit: Suit.Spades,
    wentSet: false,
    conceded: false,
    roundScoreByTeam: { 0: 260, 1: 90 },
    cumulativeScoresByTeam: { 0: 260, 1: 90 },
  },
  {
    hand: 2,
    bidWinnerTeam: 0,
    bid: 340,
    trumpSuit: Suit.Hearts,
    wentSet: true,
    conceded: false,
    roundScoreByTeam: { 0: -340, 1: 150 },
    cumulativeScoresByTeam: { 0: -80, 1: 240 },
  },
  {
    hand: 3,
    bidWinnerTeam: 1,
    bid: 320,
    trumpSuit: Suit.Clubs,
    wentSet: false,
    conceded: false,
    roundScoreByTeam: { 0: 110, 1: 330 },
    cumulativeScoresByTeam: { 0: 30, 1: 570 },
  },
]

describe('HandLedger', () => {
  it('renders one row per completed hand', () => {
    render(<HandLedger entries={entries} teamNames={TEAM_NAMES} />)
    // 3 hands + the header row.
    expect(screen.getAllByRole('row')).toHaveLength(4)
  })

  it('shows each team per-hand delta with its sign', () => {
    render(<HandLedger entries={entries} teamNames={TEAM_NAMES} />)
    expect(screen.getByText('+260')).not.toBeNull()
    expect(screen.getByText('-340')).not.toBeNull()
    expect(screen.getByText('+330')).not.toBeNull()
  })

  it('shows the running total after each hand', () => {
    render(<HandLedger entries={entries} teamNames={TEAM_NAMES} />)
    expect(screen.getByText('-80')).not.toBeNull()
    expect(screen.getByText('570')).not.toBeNull()
  })

  it('shows the bid and trump in the bidding team column only', () => {
    render(<HandLedger entries={[entries[0]]} teamNames={TEAM_NAMES} />)
    const cells = screen.getAllByRole('cell')
    expect(cells[0].textContent).toContain('250')
    expect(cells[0].textContent).toContain('♠')
    expect(cells[1].textContent).not.toContain('250')
  })

  it('labels a hand the bidding team went set on', () => {
    render(<HandLedger entries={[entries[1]]} teamNames={TEAM_NAMES} />)
    expect(screen.getByText('(set)')).not.toBeNull()
  })

  it('labels a folded hand differently from a played-out set', () => {
    const folded: HandLedgerEntry = { ...entries[1], conceded: true }
    render(<HandLedger entries={[folded]} teamNames={TEAM_NAMES} />)
    expect(screen.getByText('(folded)')).not.toBeNull()
    expect(screen.queryByText('(set)')).toBeNull()
  })

  it('renders nothing before the first hand completes', () => {
    const { container } = render(<HandLedger entries={[]} teamNames={TEAM_NAMES} />)
    expect(container.firstChild).toBeNull()
  })

  it('caps its height and scrolls rather than growing with the game', () => {
    render(<HandLedger entries={entries} teamNames={TEAM_NAMES} />)
    const scroller = screen.getByRole('table').parentElement
    expect(scroller?.className).toContain('overflow-y-auto')
    expect(scroller?.className).toContain('max-h-')
  })
})

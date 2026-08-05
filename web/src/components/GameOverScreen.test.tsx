import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Suit } from '../engine/card'
import type { GameOverData, HandLedgerEntry } from './scoreTypes'
import { GameOverScreen } from './GameOverScreen'

// See RoundSummary.test.tsx: no global `afterEach` is wired up for
// @testing-library/react's automatic cleanup, so each render() here would
// otherwise persist into the next test's DOM.
afterEach(cleanup)

const data: GameOverData = {
  winningTeam: 0,
  finalScoresByTeam: { 0: 1040, 1: 760 },
  teamNames: { 0: 'Team A', 1: 'Team B' },
}

/** A two-hand game: team 0 goes set, then wins it back. */
const ledger: HandLedgerEntry[] = [
  {
    hand: 1,
    bidWinnerTeam: 0,
    bid: 340,
    trumpSuit: Suit.Diamonds,
    wentSet: true,
    conceded: false,
    roundScoreByTeam: { 0: -340, 1: 200 },
    cumulativeScoresByTeam: { 0: -340, 1: 200 },
  },
  {
    hand: 2,
    bidWinnerTeam: 0,
    bid: 300,
    trumpSuit: Suit.Clubs,
    wentSet: false,
    conceded: false,
    roundScoreByTeam: { 0: 1380, 1: 560 },
    cumulativeScoresByTeam: { 0: 1040, 1: 760 },
  },
]

describe('GameOverScreen', () => {
  it('announces the winning team', () => {
    render(<GameOverScreen data={data} onNewGame={() => {}} />)
    expect(screen.getByText('Team A wins!')).not.toBeNull()
  })

  it('renders both teams final scores', () => {
    render(<GameOverScreen data={data} onNewGame={() => {}} />)
    expect(screen.getByText('1040')).not.toBeNull()
    expect(screen.getByText('760')).not.toBeNull()
  })

  it('shows the whole match hand by hand when given a ledger (#198)', () => {
    render(<GameOverScreen data={data} ledger={ledger} onNewGame={() => {}} />)
    expect(screen.getByText('Game ledger')).not.toBeNull()
    // Header row + one row per hand.
    expect(screen.getAllByRole('row')).toHaveLength(3)
    // Twice on hand 1: the delta, and the running total it produced from 0.
    expect(screen.getAllByText('-340')).toHaveLength(2)
    expect(screen.getByText('(set)')).not.toBeNull()
    expect(screen.getByText('+1380')).not.toBeNull()
  })

  it('renders without a ledger for callers that do not have one', () => {
    render(<GameOverScreen data={data} onNewGame={() => {}} />)
    expect(screen.queryByText('Game ledger')).toBeNull()
  })

  it('calls onNewGame when the start-new-game button is clicked', () => {
    const onNewGame = vi.fn()
    render(<GameOverScreen data={data} onNewGame={onNewGame} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start new game' }))
    expect(onNewGame).toHaveBeenCalledOnce()
  })
})

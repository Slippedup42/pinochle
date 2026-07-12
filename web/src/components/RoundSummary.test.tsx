import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RoundSummaryData } from './scoreTypes'
import { RoundSummary } from './RoundSummary'

// No global `afterEach` is wired up for @testing-library/react's automatic
// cleanup (vitest.config's `test` block doesn't set `globals: true`), so
// each render() here would otherwise persist into the next test's DOM.
afterEach(cleanup)

const madeContractData: RoundSummaryData = {
  meldPointsByTeam: { 0: 60, 1: 24 },
  trickPointsByTeam: { 0: 130, 1: 120 },
  roundScoreByTeam: { 0: 190, 1: 144 },
  bidWinnerTeam: 0,
  bid: 180,
  cumulativeScoresByTeam: { 0: 610, 1: 524 },
  teamNames: { 0: 'Team A', 1: 'Team B' },
}

const wentSetData: RoundSummaryData = {
  meldPointsByTeam: { 0: 20, 1: 24 },
  trickPointsByTeam: { 0: 100, 1: 150 },
  roundScoreByTeam: { 0: -340, 1: 174 },
  bidWinnerTeam: 0,
  bid: 340,
  cumulativeScoresByTeam: { 0: 80, 1: 554 },
  teamNames: { 0: 'Team A', 1: 'Team B' },
}

describe('RoundSummary', () => {
  it('renders meld, trick, round, and running scores for both teams', () => {
    render(<RoundSummary data={madeContractData} />)
    expect(screen.getByText('60')).not.toBeNull()
    expect(screen.getByText('24')).not.toBeNull()
    expect(screen.getByText('130')).not.toBeNull()
    expect(screen.getByText('120')).not.toBeNull()
    expect(screen.getByText('610')).not.toBeNull()
    expect(screen.getByText('524')).not.toBeNull()
  })

  it('reports a made contract when the bidding team met their bid', () => {
    render(<RoundSummary data={madeContractData} />)
    expect(screen.getByText(/made their contract/)).not.toBeNull()
  })

  it('reports going set when the bidding team fell short of their bid', () => {
    render(<RoundSummary data={wentSetData} />)
    expect(screen.getByText(/went set/)).not.toBeNull()
    expect(screen.getByText('-340')).not.toBeNull()
  })

  it('omits the continue button when onContinue is not supplied', () => {
    render(<RoundSummary data={madeContractData} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('calls onContinue when the continue button is clicked', () => {
    const onContinue = vi.fn()
    render(<RoundSummary data={madeContractData} onContinue={onContinue} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onContinue).toHaveBeenCalledOnce()
  })
})

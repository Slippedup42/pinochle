import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GameOverData } from './scoreTypes'
import { GameOverScreen } from './GameOverScreen'

// See RoundSummary.test.tsx: no global `afterEach` is wired up for
// @testing-library/react's automatic cleanup, so each render() here would
// otherwise persist into the next test's DOM.
afterEach(cleanup)

const data: GameOverData = {
  winningTeam: 0,
  finalScoresByTeam: { 0: 1040, 1: 760 },
}

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

  it('calls onNewGame when the start-new-game button is clicked', () => {
    const onNewGame = vi.fn()
    render(<GameOverScreen data={data} onNewGame={onNewGame} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start new game' }))
    expect(onNewGame).toHaveBeenCalledOnce()
  })
})

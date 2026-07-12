import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Card, Deck, Suit } from '../engine/card'
import { GameShell } from './GameShell'

// Same deterministic-weak-hand approach GameFlow.test.tsx uses: no nines
// means nobody's misdeal-eligible, so dealing lands straight in the
// auction (dealer East (3), human (0) bids first).
function weakHand(): Card[] {
  return [new Card(Suit.Clubs, 'J', 1)]
}

function mockDeal(): void {
  vi.spyOn(Deck.prototype, 'shuffle').mockImplementation(() => {})
  vi.spyOn(Deck.prototype, 'deal').mockReturnValue([weakHand(), weakHand(), weakHand(), weakHand()])
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('GameShell', () => {
  it('shows the start menu on load with Continue disabled when there is no save', () => {
    render(<GameShell />)
    expect(screen.getByText('Pinochle')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true)
  })

  it('New Game deals straight into the auction', async () => {
    mockDeal()
    render(<GameShell />)
    fireEvent.click(screen.getByRole('button', { name: 'New Game' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bid' })).not.toBeNull())
  })

  it('autosaves during play, and a fresh mount can Continue back into it without redealing', async () => {
    mockDeal()
    const { unmount } = render(<GameShell />)
    fireEvent.click(screen.getByRole('button', { name: 'New Game' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bid' })).not.toBeNull())
    unmount()

    render(<GameShell />)
    const continueButton = screen.getByRole('button', { name: 'Continue' })
    expect(continueButton.hasAttribute('disabled')).toBe(false)
    fireEvent.click(continueButton)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bid' })).not.toBeNull())
    // Resuming reused the saved state rather than dealing a second time.
    expect(Deck.prototype.deal).toHaveBeenCalledTimes(1)
  })

  it('opens the mid-game menu via the persistent menu button, and Continue there just resumes', async () => {
    mockDeal()
    render(<GameShell />)
    fireEvent.click(screen.getByRole('button', { name: 'New Game' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bid' })).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    expect(screen.getByText('Pinochle')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('button', { name: 'Bid' })).not.toBeNull()
  })

  it('confirms before New Game discards an in-progress save, and backs off if declined', async () => {
    mockDeal()
    render(<GameShell />)
    fireEvent.click(screen.getByRole('button', { name: 'New Game' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bid' })).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    fireEvent.click(screen.getByRole('button', { name: 'New Game' }))
    // In-app confirm dialog (not a native window.confirm — that blocks the
    // whole page and doesn't match the rest of the app's styled modals).
    expect(screen.getByText('Start a new game? Your current saved game will be lost.')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    // Declined — the menu is still up, nothing was reset.
    expect(screen.getByText('Pinochle')).not.toBeNull()
    expect(screen.queryByText('Start a new game? Your current saved game will be lost.')).toBeNull()
  })

  it('New Game confirmation actually discards the save when accepted', async () => {
    mockDeal()
    render(<GameShell />)
    fireEvent.click(screen.getByRole('button', { name: 'New Game' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bid' })).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    fireEvent.click(screen.getByRole('button', { name: 'New Game' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start new game' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bid' })).not.toBeNull())
    expect(Deck.prototype.deal).toHaveBeenCalledTimes(2)
  })

  it('toggling "Hide opponent cards" in Options affects the next game rendered', async () => {
    mockDeal()
    render(<GameShell />)
    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    fireEvent.click(screen.getByLabelText('Hide opponent cards'))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    fireEvent.click(screen.getByRole('button', { name: 'New Game' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bid' })).not.toBeNull())
    expect(screen.queryAllByLabelText('face-down card')).toHaveLength(0)
  })
})

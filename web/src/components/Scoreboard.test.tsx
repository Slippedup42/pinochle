import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Suit } from '../engine/card'
import { Scoreboard } from './Scoreboard'

afterEach(cleanup)

const SCORES = { 0: 120, 1: 90 }
const TEAM_NAMES = { 0: 'Meld Squad', 1: 'Quantum Drifters' }

function renderStrip(props: Partial<Parameters<typeof Scoreboard>[0]> = {}) {
  return render(
    <Scoreboard
      scoresByTeam={SCORES}
      teamNames={TEAM_NAMES}
      currentBid={320}
      trumpSuit={Suit.Spades}
      {...props}
    />,
  )
}

describe('Scoreboard', () => {
  it('shows the scores, the standing bid and trump', () => {
    renderStrip()
    expect(screen.getByText('Meld Squad:')).not.toBeNull()
    expect(screen.getByText('320')).not.toBeNull()
    expect(screen.getByText('♠')).not.toBeNull()
  })

  // #187: the menu button used to be an `absolute top-2 left-2 z-10` sibling in
  // Table, painted over this strip's first line — on a phone "☰ Menu" sat across
  // "Trump: —". Rendering it as the strip's leading item is what makes the
  // collision impossible rather than merely unlikely, so the ownership is the
  // thing worth pinning.
  it('renders the menu button as its own leading item when onOpenMenu is given', () => {
    const onOpenMenu = vi.fn()
    const { container } = renderStrip({ onOpenMenu })
    const strip = container.firstElementChild
    const button = screen.getByRole('button', { name: 'Open menu' })
    expect(button.parentElement).toBe(strip)
    expect(strip?.firstElementChild).toBe(button)
    expect(button.className).not.toContain('absolute')
  })

  it('fires onOpenMenu when the button is pressed', () => {
    const onOpenMenu = vi.fn()
    renderStrip({ onOpenMenu })
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    expect(onOpenMenu).toHaveBeenCalledTimes(1)
  })

  it('renders no menu button at all when onOpenMenu is omitted', () => {
    renderStrip()
    expect(screen.queryByRole('button', { name: 'Open menu' })).toBeNull()
  })
})

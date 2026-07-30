import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Card, Suit } from '../engine/card'
import type { Hands, TeamId } from '../engine/round'
import type { PlayerIndex } from '../engine/trick'
import { MeldFlow } from './MeldFlow'

const SEAT_NAMES: Record<PlayerIndex, string> = { 0: 'You', 1: 'West', 2: 'Partner', 3: 'East' }
const SCORES: Record<TeamId, number> = { 0: 0, 1: 0 }
const TEAM_NAMES: Record<TeamId, string> = { 0: 'Us', 1: 'Them' }

/** Every seat gets a royal marriage in hearts plus filler, so all four have
 * meld to show — the case that used to overflow the panel. */
function handsWithMeld(): Hands {
  const seat = (n: number): Card[] => [
    new Card(Suit.Hearts, 'K', n % 2 === 0 ? 1 : 2),
    new Card(Suit.Hearts, 'Q', n % 2 === 0 ? 1 : 2),
    new Card(Suit.Spades, 'A', 1),
    new Card(Suit.Clubs, '9', 1),
  ]
  return [seat(0), seat(1), seat(2), seat(3)] as Hands
}

function renderMeld() {
  return render(
    <MeldFlow
      hands={handsWithMeld()}
      trumpSuit={Suit.Hearts}
      bidWinner={0}
      bid={320}
      seatNames={SEAT_NAMES}
      humanPlayer={0}
      scoresByTeam={SCORES}
      teamNames={TEAM_NAMES}
      dealer={3}
      onComplete={vi.fn()}
    />,
  )
}

afterEach(cleanup)

describe('MeldFlow', () => {
  // #94: the panel used to stack all four seats in one column, growing to
  // roughly twice the viewport height and pushing Continue off-screen.
  it('lays meld out in one column per team, each holding that team‘s two seats', () => {
    renderMeld()

    const us = screen.getByRole('region', { name: 'Us meld' })
    const them = screen.getByRole('region', { name: 'Them meld' })

    // Seats 0 and 2 are one team; 1 and 3 the other.
    expect(within(us).getByText(/You/)).toBeTruthy()
    expect(within(us).getByText(/Partner/)).toBeTruthy()
    expect(within(them).getByText(/West/)).toBeTruthy()
    expect(within(them).getByText(/East/)).toBeTruthy()

    // Neither team's seats leak into the other column.
    expect(within(us).queryByText(/West/)).toBeNull()
    expect(within(them).queryByText(/You/)).toBeNull()
  })

  it('renders meld cards at the compact size so four seats fit on screen (#94)', () => {
    renderMeld()
    const cards = screen.getAllByRole('img').filter((el) => el.closest('section[aria-label$="meld"]'))
    expect(cards.length).toBeGreaterThan(0)
    for (const card of cards) {
      expect(card.className).toContain('w-9')
      expect(card.className).not.toContain('w-20')
    }
  })

  it('caps the panel height and scrolls the meld list, keeping Continue outside the scroll area', () => {
    const { container } = renderMeld()
    const panel = container.querySelector('.max-h-\\[85vh\\]')
    expect(panel).not.toBeNull()

    const scroller = panel!.querySelector('.overflow-y-auto')
    expect(scroller).not.toBeNull()

    const continueBtn = screen.getByRole('button', { name: 'Continue' })
    expect(scroller!.contains(continueBtn)).toBe(false)
    expect(panel!.contains(continueBtn)).toBe(true)
  })
})

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Card, Suit } from '../engine/card'
import { ClaimNotice } from './ClaimNotice'

afterEach(cleanup)

const cards = [
  new Card(Suit.Hearts, 'A', 1),
  new Card(Suit.Hearts, 'A', 2),
  new Card(Suit.Hearts, '10', 1),
]

function renderNotice(overrides: Partial<Parameters<typeof ClaimNotice>[0]> = {}) {
  const onDismiss = vi.fn()
  render(
    <ClaimNotice
      claimerName="Partner"
      teamName="Team A"
      humanIsClaimer={false}
      cards={cards}
      points={110}
      tricks={3}
      trumpName="Hearts"
      onDismiss={onDismiss}
      {...overrides}
    />,
  )
  return { onDismiss }
}

describe('ClaimNotice (#208)', () => {
  it('says whose claim it is and how many tricks it takes', () => {
    renderNotice()
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('heading').textContent).toContain('The rest are mine')
    expect(dialog.textContent).toContain('Partner holds')
    expect(dialog.textContent).toContain('the last 3 tricks go to Team A')
  })

  it('addresses the human directly when the human is claiming', () => {
    renderNotice({ humanIsClaimer: true })
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('You hold')
    expect(dialog.textContent).toContain('go to you')
  })

  it("shows the claimer's whole hand face up, because a claim is checkable", () => {
    // Including an AI's. The message asserts these cards cannot be beaten, and
    // the player is entitled to verify it rather than take it on trust.
    renderNotice()
    const hand = screen.getByLabelText("Partner's remaining cards")
    expect(within(hand).getAllByRole('img')).toHaveLength(3)
    expect(within(hand).getAllByRole('img').map((n) => n.getAttribute('aria-label'))).toEqual([
      'A of H',
      'A of H',
      '10 of H',
    ])
  })

  it('names the points transferred and dismisses on acknowledgement', () => {
    const { onDismiss } = renderNotice()
    expect(screen.getByRole('dialog').textContent).toContain('110')
    fireEvent.click(screen.getByRole('button', { name: 'See the score' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('offers no way to decline — the outcome is already decided', () => {
    // A notice, not a confirmation. `findClaim` only fires on a position whose
    // every remaining trick was settled, so a Cancel would imply a choice that
    // does not exist. Same reasoning as AutoSetNotice.
    renderNotice()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
})

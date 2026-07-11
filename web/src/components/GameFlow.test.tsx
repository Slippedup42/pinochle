import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Card, Deck, Suit } from '../engine/card'
import { GameFlow } from './GameFlow'

// Deterministic dealt hands, standing in for Deck.deal()'s real (shuffled)
// output — these tests care about the misdeal-check wiring and the
// dealing -> auction handoff, not what a legitimate 12-card hand looks
// like, so short fixture hands are fine (same approach AuctionFlow.test.tsx
// takes with its buildTestHands).

function weakHand(): Card[] {
  return [new Card(Suit.Clubs, 'J', 1)] // no nines, never misdeal-eligible
}

/** `count` nines spread across suits/copies — cheap way to build a hand
 * that clears MISDEAL_NINE_THRESHOLD (misdeal.ts) without needing real
 * suit/copy uniqueness (nineCount just counts rank '9'). */
function handWithNines(count: number): Card[] {
  const suits = [Suit.Spades, Suit.Diamonds, Suit.Clubs, Suit.Hearts]
  const cards: Card[] = []
  let suitIdx = 0
  let copy: 1 | 2 = 1
  for (let i = 0; i < count; i++) {
    cards.push(new Card(suits[suitIdx % 4], '9', copy))
    copy = copy === 1 ? 2 : 1
    if (copy === 1) suitIdx++
  }
  return cards
}

type FourHands = [Card[], Card[], Card[], Card[]]

function mockDeals(...deals: FourHands[]): void {
  vi.spyOn(Deck.prototype, 'shuffle').mockImplementation(() => {})
  const dealSpy = vi.spyOn(Deck.prototype, 'deal')
  for (const hands of deals) dealSpy.mockReturnValueOnce(hands)
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('GameFlow (component)', () => {
  it('deals straight into the auction when no seat is misdeal-eligible', async () => {
    mockDeals([weakHand(), weakHand(), weakHand(), weakHand()])

    render(<GameFlow />)

    // Dealer is East (3); left of dealer is the human (0) — they bid first.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bid' })).not.toBeNull())
    expect(screen.queryByText('Misdeal?')).toBeNull()
  })

  it('asks the human to confirm a reshuffle when they hold 5+ nines, and proceeds on decline', async () => {
    mockDeals([handWithNines(5), weakHand(), weakHand(), weakHand()])

    render(<GameFlow />)

    await waitFor(() => expect(screen.getByText('Misdeal?')).not.toBeNull())
    expect(screen.getByText(/You have 5 nines/)).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Keep hand' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Bid' })).not.toBeNull())
    expect(screen.queryByText('Misdeal?')).toBeNull()
  })

  it('redeals when the human accepts the reshuffle', async () => {
    mockDeals(
      [handWithNines(6), weakHand(), weakHand(), weakHand()],
      [weakHand(), weakHand(), weakHand(), weakHand()],
    )

    render(<GameFlow />)

    await waitFor(() => expect(screen.getByText('Misdeal?')).not.toBeNull())
    expect(screen.getByText(/You have 6 nines/)).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Reshuffle' }))

    // Second deal has nobody eligible, so it lands straight in the auction.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Bid' })).not.toBeNull())
    expect(Deck.prototype.deal).toHaveBeenCalledTimes(2)
  })

  it("auto-reshuffles for an eligible AI seat without asking the human", async () => {
    mockDeals(
      [weakHand(), handWithNines(5), weakHand(), weakHand()], // West (AI) eligible
      [weakHand(), weakHand(), weakHand(), weakHand()],
    )

    render(<GameFlow />)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Bid' })).not.toBeNull())
    expect(screen.queryByText('Misdeal?')).toBeNull()
    expect(Deck.prototype.deal).toHaveBeenCalledTimes(2)
  })
})

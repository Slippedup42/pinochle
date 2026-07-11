import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Card, FORCED_BID, Suit } from '../engine/card'
import type { PlayerIndex } from '../engine/trick'
import { AuctionFlow } from './AuctionFlow'
import type { AuctionState } from './auctionReducer'
import { auctionReducer, initAuctionState } from './auctionReducer'
import type { AuctionResult } from './auctionTypes'

const SEAT_NAMES: Record<PlayerIndex, string> = { 0: 'You', 1: 'West', 2: 'Partner', 3: 'East' }
const SCORES = { 0: 0, 1: 0 }

function baseState(dealer: PlayerIndex = 3): AuctionState {
  const hands = [[], [], [], []] as [Card[], Card[], Card[], Card[]]
  return initAuctionState(hands, dealer, SEAT_NAMES, SCORES)
}

describe('auctionReducer', () => {
  it('rotates the turn to the next active seat after a bid, starting left of the dealer', () => {
    const state = baseState(3) // left of dealer is seat 0
    expect(state.bidding.turn).toBe(0)
    const next = auctionReducer(state, { type: 'BID', player: 0, amount: 300 })
    expect(next.bidding.currentBid).toBe(300)
    expect(next.bidding.everBid).toBe(true)
    expect(next.bidding.bidWinner).toBe(0)
    expect(next.bidding.turn).toBe(1)
    expect(next.phase).toBe('bidding')
    expect(next.log).toEqual([{ kind: 'bid', player: 0, name: 'You', amount: 300 }])
  })

  it('ends the auction and moves to the trump phase once 3 players have passed', () => {
    let state = baseState(3)
    state = auctionReducer(state, { type: 'BID', player: 0, amount: 300 })
    state = auctionReducer(state, { type: 'PASS_BID', player: 1 })
    expect(state.phase).toBe('bidding')
    state = auctionReducer(state, { type: 'PASS_BID', player: 2 })
    expect(state.phase).toBe('bidding')
    state = auctionReducer(state, { type: 'PASS_BID', player: 3 })
    expect(state.phase).toBe('trump')
    expect(state.bidWinner).toBe(0)
    expect(state.bid).toBe(300)
  })

  it('lets the bid pass back and forth before settling on the last (non-partner) bidder', () => {
    let state = baseState(3)
    state = auctionReducer(state, { type: 'BID', player: 0, amount: 300 })
    state = auctionReducer(state, { type: 'PASS_BID', player: 1 })
    state = auctionReducer(state, { type: 'PASS_BID', player: 2 })
    state = auctionReducer(state, { type: 'BID', player: 3, amount: 310 })
    expect(state.phase).toBe('bidding')
    expect(state.bidding.bidWinner).toBe(3)
    state = auctionReducer(state, { type: 'PASS_BID', player: 0 })
    expect(state.phase).toBe('trump')
    expect(state.bidWinner).toBe(3)
    expect(state.bid).toBe(310)
  })

  it('forces the dealer to take the contract at FORCED_BID when nobody ever bids', () => {
    let state = baseState(3)
    state = auctionReducer(state, { type: 'PASS_BID', player: 0 })
    state = auctionReducer(state, { type: 'PASS_BID', player: 1 })
    state = auctionReducer(state, { type: 'PASS_BID', player: 2 })
    expect(state.phase).toBe('trump')
    expect(state.bidWinner).toBe(3) // the dealer, never having gotten a turn
    expect(state.bid).toBe(FORCED_BID)
    expect(state.log.at(-1)).toEqual({ kind: 'forced-bid', player: 3, name: 'East', amount: FORCED_BID })
  })

  it('ignores BID/PASS_BID actions once bidding has ended', () => {
    let state = baseState(3)
    state = auctionReducer(state, { type: 'PASS_BID', player: 0 })
    state = auctionReducer(state, { type: 'PASS_BID', player: 1 })
    state = auctionReducer(state, { type: 'PASS_BID', player: 2 })
    const afterAuction = state
    const unchanged = auctionReducer(state, { type: 'BID', player: 1, amount: 999 })
    expect(unchanged).toBe(afterAuction)
  })

  it('records a trump call and moves to the partner-to-bidder pass step', () => {
    let state = baseState(3)
    state = auctionReducer(state, { type: 'PASS_BID', player: 0 })
    state = auctionReducer(state, { type: 'PASS_BID', player: 1 })
    state = auctionReducer(state, { type: 'PASS_BID', player: 2 }) // forces dealer (3)
    state = auctionReducer(state, { type: 'CHOOSE_TRUMP', player: 3, suit: Suit.Hearts })
    expect(state.trumpSuit).toBe(Suit.Hearts)
    expect(state.phase).toBe('passing-partner-to-bidder')
    expect(state.log.at(-1)).toEqual({ kind: 'trump', player: 3, name: 'East', suit: Suit.Hearts })
  })

  it('moves cards between hands and logs a count-only card-pass entry', () => {
    let state = baseState(3)
    const card = new Card(Suit.Spades, 'A', 1)
    state = { ...state, hands: [[card], [], [], []] as [Card[], Card[], Card[], Card[]], phase: 'passing-partner-to-bidder' }
    state = auctionReducer(state, { type: 'PASS_CARDS', from: 0, to: 1, cards: [card] })
    expect(state.hands[0]).toEqual([])
    expect(state.hands[1]).toEqual([card])
    expect(state.phase).toBe('passing-bidder-to-partner')
    expect(state.log.at(-1)).toEqual({
      kind: 'card-pass',
      fromPlayer: 0,
      fromName: 'You',
      toPlayer: 1,
      toName: 'West',
      count: 1,
    })
  })

  it('completes the auction after the second (bidder-to-partner) pass', () => {
    let state = baseState(3)
    state = { ...state, phase: 'passing-bidder-to-partner' }
    state = auctionReducer(state, { type: 'PASS_CARDS', from: 0, to: 2, cards: [] })
    expect(state.phase).toBe('complete')
  })
})

// -- Full component flow --------------------------------------------------
//
// AI seats (1, 2, 3) are dealt intentionally weak 3-card hands (no aces,
// marriages, runs, or arounds) so bidding.ts's bestBaseBid ceiling stays
// well under OPENER_THRESHOLD (320) and mock/aiDecisions.ts's aiDecideBid
// always passes for them — makes the human's path through the whole
// auction/trump/pass flow deterministic without stubbing the engine.

function buildTestHands(): [Card[], Card[], Card[], Card[]] {
  const human = [
    new Card(Suit.Clubs, 'A', 1),
    new Card(Suit.Diamonds, 'K', 1),
    new Card(Suit.Hearts, 'Q', 1),
    new Card(Suit.Spades, 'J', 1),
    new Card(Suit.Clubs, '10', 1),
  ]
  const west = [new Card(Suit.Spades, '9', 1), new Card(Suit.Hearts, 'J', 1), new Card(Suit.Diamonds, '10', 1)]
  const partner = [new Card(Suit.Clubs, '9', 1), new Card(Suit.Diamonds, 'J', 1), new Card(Suit.Spades, '10', 1)]
  const east = [new Card(Suit.Hearts, '9', 1), new Card(Suit.Clubs, 'J', 1), new Card(Suit.Spades, 'Q', 1)]
  return [human, west, partner, east]
}

afterEach(cleanup)

describe('AuctionFlow (component)', () => {
  it('walks the human through bidding, naming trump, and passing cards, then reports the result', () => {
    const hands = buildTestHands()
    const onComplete = vi.fn()

    render(
      <AuctionFlow
        initialHands={hands}
        seatNames={SEAT_NAMES}
        humanPlayer={0}
        dealer={3}
        scoresByTeam={SCORES}
        onComplete={onComplete}
      />,
    )

    // Left of dealer (3) is seat 0 — the human bids first.
    fireEvent.click(screen.getByRole('button', { name: 'Bid' }))

    // West, Partner, and East all pass automatically (weak hands) — the
    // auction should already have resolved to trump selection.
    expect(screen.getByText('Name trump')).not.toBeNull()

    fireEvent.click(screen.getByText('Hearts'))

    // Partner (AI) passes 3 cards to the human automatically; the human is
    // now on the bidder-to-partner leg and sees the pass selector.
    const passHeading = screen.getByRole('heading', { name: /Choose 3 cards to pass/ })
    const passPanel = within(passHeading.closest('div') as HTMLElement)

    fireEvent.click(passPanel.getByRole('img', { name: 'A of C' }))
    fireEvent.click(passPanel.getByRole('img', { name: 'K of D' }))
    fireEvent.click(passPanel.getByRole('img', { name: 'Q of H' }))
    fireEvent.click(passPanel.getByRole('button', { name: 'Confirm pass' }))

    expect(onComplete).toHaveBeenCalledOnce()
    const result = onComplete.mock.calls[0][0] as AuctionResult
    expect(result.bidWinner).toBe(0)
    expect(result.bid).toBe(300)
    expect(result.trumpSuit).toBe(Suit.Hearts)
    // The 3 cards the human chose to pass are gone from their final hand.
    expect(result.hands[0].some((c) => c.suit === Suit.Clubs && c.rank === 'A')).toBe(false)
    expect(result.hands[0].some((c) => c.suit === Suit.Diamonds && c.rank === 'K')).toBe(false)
    expect(result.hands[0].some((c) => c.suit === Suit.Hearts && c.rank === 'Q')).toBe(false)

    // The auction/pass log surfaced every AI decision along the way.
    expect(screen.getByText('West passed')).not.toBeNull()
    expect(screen.getByText('Partner passed 3 cards to You')).not.toBeNull()
  })
})

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Card, FORCED_BID, Suit } from '../engine/card'
import type { PlayerIndex } from '../engine/trick'
import { AI_BID_DELAY_MS, AuctionFlow } from './AuctionFlow'
import type { AuctionState } from './auctionReducer'
import { auctionReducer, initAuctionState, passedPlayersOf } from './auctionReducer'
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
    expect(next.bidding.bidHistory).toEqual([{ player: 0, amount: 300 }])
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
    expect(state.bidding.bidHistory).toEqual([
      { player: 0, amount: 300 },
      { player: 3, amount: 310 },
    ])
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

  it('ignores a stale PASS_BID for a player whose turn has already passed (React StrictMode double-invoke guard)', () => {
    const state = baseState(3) // left of dealer is seat 0
    const afterFirstPass = auctionReducer(state, { type: 'PASS_BID', player: 0 })
    expect(afterFirstPass.bidding.passes).toBe(1)
    expect(afterFirstPass.bidding.turn).toBe(1)
    const stale = auctionReducer(afterFirstPass, { type: 'PASS_BID', player: 0 })
    expect(stale).toBe(afterFirstPass)
  })

  it('ignores a stale BID for a player whose turn has already passed', () => {
    const state = baseState(3)
    const afterFirstBid = auctionReducer(state, { type: 'BID', player: 0, amount: 300 })
    expect(afterFirstBid.bidding.turn).toBe(1)
    const stale = auctionReducer(afterFirstBid, { type: 'BID', player: 0, amount: 310 })
    expect(stale).toBe(afterFirstBid)
  })

  it('records a trump call and moves to the passing phase', () => {
    let state = baseState(3)
    state = auctionReducer(state, { type: 'PASS_BID', player: 0 })
    state = auctionReducer(state, { type: 'PASS_BID', player: 1 })
    state = auctionReducer(state, { type: 'PASS_BID', player: 2 }) // forces dealer (3)
    state = auctionReducer(state, { type: 'CHOOSE_TRUMP', player: 3, suit: Suit.Hearts })
    expect(state.trumpSuit).toBe(Suit.Hearts)
    expect(state.phase).toBe('passing')
    expect(state.log.at(-1)).toEqual({ kind: 'trump', player: 3, name: 'East', suit: Suit.Hearts })
  })

  it('simultaneously exchanges cards when both passers have selected — both log entries appear at once', () => {
    let state = baseState(3)
    const card1 = new Card(Suit.Spades, 'A', 1)
    const card2 = new Card(Suit.Clubs, 'K', 1)
    state = { ...state, hands: [[card1], [], [card2], []] as [Card[], Card[], Card[], Card[]], phase: 'passing', bidWinner: 0 }

    // Partner (2) passes first — cards are stored but hand isn't modified yet
    state = auctionReducer(state, { type: 'PASS_CARDS', from: 2, cards: [card2] })
    expect(state.phase).toBe('passing')
    expect(state.passing.fromBidderCards).toBeNull()
    expect(state.passing.fromPartnerCards).toEqual([card2])
    expect(state.log).toHaveLength(0)

    // Bidder (0) passes too — exchange happens atomically
    state = auctionReducer(state, { type: 'PASS_CARDS', from: 0, cards: [card1] })
    expect(state.phase).toBe('pass-reveal')
    expect(state.hands[0]).toEqual([card2])
    expect(state.hands[2]).toEqual([card1])
    expect(state.log).toEqual([
      { kind: 'card-pass', fromPlayer: 2, fromName: 'Partner', toPlayer: 0, toName: 'You', count: 1 },
      { kind: 'card-pass', fromPlayer: 0, fromName: 'You', toPlayer: 2, toName: 'Partner', count: 1 },
    ])

    // Confirm reveal to reach complete
    state = auctionReducer(state, { type: 'CONFIRM_PASS_REVEAL' })
    expect(state.phase).toBe('complete')
  })

  it('completes the auction when both passers have selected their cards', () => {
    let state = baseState(3)
    state = { ...state, phase: 'passing', bidWinner: 0 }
    state = auctionReducer(state, { type: 'PASS_CARDS', from: 2, cards: [] })
    expect(state.phase).toBe('passing')
    state = auctionReducer(state, { type: 'PASS_CARDS', from: 0, cards: [] })
    expect(state.phase).toBe('pass-reveal')
    state = auctionReducer(state, { type: 'CONFIRM_PASS_REVEAL' })
    expect(state.phase).toBe('complete')
  })

  // -- Passed players are out for the hand (#93) ---------------------------

  it('skips a passed seat when the bidding wraps around (#93)', () => {
    let state = baseState(3) // seat 0 opens, seat 3 (You) is dealer
    state = auctionReducer(state, { type: 'BID', player: 0, amount: 300 })
    state = auctionReducer(state, { type: 'PASS_BID', player: 1 })
    state = auctionReducer(state, { type: 'PASS_BID', player: 2 })
    // Seats 1 and 2 are out; the turn must jump straight to seat 3.
    expect(state.bidding.turn).toBe(3)
    state = auctionReducer(state, { type: 'BID', player: 3, amount: 310 })
    // Wrapping past the two passed seats lands back on seat 0, not seat 1.
    expect(state.bidding.turn).toBe(0)
    state = auctionReducer(state, { type: 'BID', player: 0, amount: 320 })
    expect(state.bidding.turn).toBe(3)
  })

  it('never gives the turn to a seat that already passed, for any bid/pass sequence (#93)', () => {
    const violations: string[] = []

    function walk(state: AuctionState, asked: readonly PlayerIndex[]) {
      if (state.phase !== 'bidding' || asked.length > 12) return
      const turn = state.bidding.turn
      if (!state.bidding.active[turn]) {
        violations.push(`seat ${turn} asked again after passing; sequence was [${asked.join(',')}]`)
        return
      }
      walk(auctionReducer(state, { type: 'BID', player: turn, amount: state.bidding.currentBid + 10 }), [...asked, turn])
      walk(auctionReducer(state, { type: 'PASS_BID', player: turn }), [...asked, turn])
    }

    for (const dealer of [0, 1, 2, 3] as PlayerIndex[]) walk(baseState(dealer), [])
    expect(violations).toEqual([])
  })

  it('reports exactly the seats that have passed, as real seat indices (#93)', () => {
    let state = baseState(3)
    expect(passedPlayersOf(state.bidding.active)).toEqual([])
    state = auctionReducer(state, { type: 'BID', player: 0, amount: 300 })
    state = auctionReducer(state, { type: 'PASS_BID', player: 1 })
    expect(passedPlayersOf(state.bidding.active)).toEqual([1])
    state = auctionReducer(state, { type: 'PASS_BID', player: 2 })
    expect(passedPlayersOf(state.bidding.active)).toEqual([1, 2])
  })
})

// -- Full component flow --------------------------------------------------
//
// AI seats (1, 2, 3) are dealt intentionally weak 3-card hands (no aces,
// marriages, runs, or arounds) so bidding.ts's bestBaseBid ceiling stays
// well under OPENER_THRESHOLD (320) and chooseBid always passes for them
// (opening threshold not cleared, and the raise ceiling in the
// opponent-holds-the-bid branch is never reached either) — makes the
// human's path through the whole auction/trump/pass flow deterministic
// without stubbing the engine.

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

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// #170: raised from the 5 s default because the first test to call `render()`
// in a file also absorbs jsdom/React/RTL first-render warmup inside its own
// wall-clock budget — negligible on an idle machine, 2.5-4.5 s when several
// agents are building in parallel. Full rationale in TrickPlayFlow.test.tsx.
// Only the component suite needs it; the `auctionReducer` suite above is pure
// logic and stays at the strict default.
describe('AuctionFlow (component)', { timeout: 20_000 }, () => {
  it('walks the human through bidding, naming trump, and passing cards, then reports the result', () => {
    vi.useFakeTimers()
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

    // West, Partner, and East all pass automatically (weak hands) after delays.
    act(() => vi.advanceTimersByTime(AI_BID_DELAY_MS))
    act(() => vi.advanceTimersByTime(AI_BID_DELAY_MS))
    act(() => vi.advanceTimersByTime(AI_BID_DELAY_MS))

    expect(screen.getByText('Name trump')).not.toBeNull()

    fireEvent.click(screen.getByText('Hearts'))

    // Partner (AI) passes 3 cards to the human automatically after a delay.
    act(() => vi.advanceTimersByTime(AI_BID_DELAY_MS))

    // The human (bidder) sees the pass selector for their send-back.
    const passHeading = screen.getByRole('heading', { name: /Choose 3 cards to pass/ })
    const passPanel = within(passHeading.closest('div') as HTMLElement)

    fireEvent.click(passPanel.getByRole('img', { name: 'A of C' }))
    fireEvent.click(passPanel.getByRole('img', { name: 'K of D' }))
    fireEvent.click(passPanel.getByRole('img', { name: 'Q of H' }))
    fireEvent.click(passPanel.getByRole('button', { name: 'Confirm pass' }))

    // Pass-reveal dialog shows before completing
    expect(screen.getByText('Partner passed you 3 cards')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(onComplete).toHaveBeenCalledOnce()
    const result = onComplete.mock.calls[0][0] as AuctionResult
    expect(result.bidWinner).toBe(0)
    expect(result.bid).toBe(300)
    expect(result.trumpSuit).toBe(Suit.Hearts)
    // The 3 cards the human chose to pass are gone from their final hand.
    expect(result.hands[0].some((c) => c.suit === Suit.Clubs && c.rank === 'A')).toBe(false)
    expect(result.hands[0].some((c) => c.suit === Suit.Diamonds && c.rank === 'K')).toBe(false)
    expect(result.hands[0].some((c) => c.suit === Suit.Hearts && c.rank === 'Q')).toBe(false)
  })

  // This case used to read "lets a weak-handed AI open as first bidder (partner
  // has not yet had a turn)" and asserted seat 2 opening at 300 on a 3-card hand
  // worth nothing. That is not a rule the reference engine has: it came from the
  // `passesSoFar < 2 -> always open` branch aeb97b3 substituted for
  // `Player.choose_bid`'s dealer-protection tier, which the #126 audit removed.
  // The test was green throughout and documented the bug as intended behaviour —
  // exactly the trap #118 told this audit to watch for.
  it('passes the auction out to a forced bid when no hand justifies opening (#126)', () => {
    vi.useFakeTimers()
    const hands = buildTestHands()
    const onComplete = vi.fn()

    render(
      <AuctionFlow
        initialHands={hands}
        seatNames={SEAT_NAMES}
        humanPlayer={0}
        dealer={1}
        scoresByTeam={SCORES}
        onComplete={onComplete}
      />,
    )

    // Left of dealer (1) is seat 2 (Partner). Its ceiling is far under
    // OPENER_THRESHOLD and its partner is not the dealer, so it passes.
    act(() => vi.advanceTimersByTime(AI_BID_DELAY_MS))
    // East (seat 3) passes on the same reasoning — then it is the human's turn.
    act(() => vi.advanceTimersByTime(AI_BID_DELAY_MS))
    expect(screen.getByRole('button', { name: 'Pass' })).not.toBeNull()

    // The human passes too: 3 passes with nobody having bid sticks the dealer
    // (seat 1) with FORCED_BID. Bidder (1) and partner (3) are both AI, so
    // naming trump and the 3-card exchange need no human input.
    fireEvent.click(screen.getByRole('button', { name: 'Pass' }))
    act(() => vi.advanceTimersByTime(AI_BID_DELAY_MS))
    act(() => vi.advanceTimersByTime(AI_BID_DELAY_MS))

    expect(onComplete).toHaveBeenCalledOnce()
    const result = onComplete.mock.calls[0][0] as AuctionResult
    expect(result.bidWinner).toBe(1)
    expect(result.bid).toBe(FORCED_BID)
  })

  it('opens as first bidder on a hand that clears the opener threshold', () => {
    vi.useFakeTimers()
    const hands = buildTestHands()
    // Seat 2 gets a full club Run plus a spare Royal Marriage: Base Bid 210,
    // ceiling 340 at 0/0 — over OPENER_THRESHOLD (320).
    hands[2] = [
      ...(['A', '10', 'K', 'Q', 'J'] as const).map((r) => new Card(Suit.Clubs, r, 1)),
      new Card(Suit.Clubs, 'K', 2),
      new Card(Suit.Clubs, 'Q', 2),
    ]
    const onComplete = vi.fn()

    render(
      <AuctionFlow
        initialHands={hands}
        seatNames={SEAT_NAMES}
        humanPlayer={0}
        dealer={1}
        scoresByTeam={SCORES}
        onComplete={onComplete}
      />,
    )

    // Left of dealer (1) is seat 2 (Partner), and this hand is worth a contract.
    act(() => vi.advanceTimersByTime(AI_BID_DELAY_MS))
    // Asserted on the seat's call on the board, not on the bare text "300":
    // the Scoreboard shows the same number as the standing contract, so a plain
    // text query matches both and cannot tell "seat 2 opened" from "the high bid
    // is 300" — which is the whole point of the assertion (#191).
    expect(screen.getByLabelText('Partner: bid 300')).not.toBeNull()
  })
})
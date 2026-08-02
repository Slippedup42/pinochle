import { describe, expect, it } from 'vitest'
import { type AuctionState, auctionReducer, initAuctionState, passedPlayersOf } from '../components/auctionReducer'
import { Deck, FORCED_BID } from './card'
import { type AuctionContext, chooseBid } from './bidding'
import type { TeamId } from './round'
import type { PlayerIndex } from './trick'

const SEAT_NAMES: Record<PlayerIndex, string> = { 0: 'S0', 1: 'S1', 2: 'S2', 3: 'S3' }
const SCORES: Record<TeamId, number> = { 0: 0, 1: 0 }

/** Drives one full AI-vs-AI auction on a random deal, the same way
 * AuctionFlow drives it, and reports the settled contract plus every seat
 * that was put on turn. */
function runAuction(dealer: PlayerIndex) {
  const deck = new Deck()
  deck.shuffle()
  let state: AuctionState = initAuctionState(deck.deal(), dealer, SEAT_NAMES, SCORES)
  const askedAfterPassing: PlayerIndex[] = []
  const bidsPlaced: number[] = []
  const passed = new Set<PlayerIndex>()

  let guard = 0
  while (state.phase === 'bidding' && guard++ < 60) {
    const turn = state.bidding.turn
    if (passed.has(turn)) askedAfterPassing.push(turn)
    const context: AuctionContext = {
      everBid: state.bidding.everBid,
      passesSoFar: state.bidding.passes,
      bidHistory: state.bidding.bidHistory,
      dealer: state.dealer,
      scores: state.scoresByTeam,
      passedPlayers: passedPlayersOf(state.bidding.active),
    }
    const decision = chooseBid(turn, state.hands[turn], state.bidding.currentBid, 10, context, 'hard')
    if (decision === null) {
      passed.add(turn)
      state = auctionReducer(state, { type: 'PASS_BID', player: turn })
    } else {
      bidsPlaced.push(decision)
      state = auctionReducer(state, { type: 'BID', player: turn, amount: decision })
    }
  }
  return { phase: state.phase, bid: state.bid, winner: state.bidWinner, askedAfterPassing, bidsPlaced }
}

describe('AI-vs-AI auction simulation', () => {
  it('settles every deal on a contract without ever re-asking a passed seat (#93)', () => {
    for (let i = 0; i < 400; i++) {
      const { phase, bid, winner, askedAfterPassing } = runAuction((i % 4) as PlayerIndex)
      expect(askedAfterPassing).toEqual([])
      expect(phase).not.toBe('bidding') // no auction hangs
      expect(winner).not.toBeNull()
      expect(bid).toBeGreaterThanOrEqual(FORCED_BID)
    }
  })

  it('never takes the ladder off multiples of 10 (#177)', () => {
    // The end-to-end half of the invariant `bidding.test.ts` states over
    // `chooseBid` in isolation. It matters separately because #177's damage was
    // cumulative: one off-grid bid does not just misprice that one call, it
    // reseeds `currentBid` so every later rung is off the grid too, including
    // the "Minimum: 331" the human is then shown and cannot bid.
    const offGrid: number[] = []
    for (let i = 0; i < 400; i++) {
      const { bid, bidsPlaced } = runAuction((i % 4) as PlayerIndex)
      offGrid.push(...bidsPlaced.filter((amount) => amount % 10 !== 0))
      if (bid !== null && bid % 10 !== 0) offGrid.push(bid)
    }
    expect(offGrid.slice(0, 10)).toEqual([])
  })
})

// Auction/pass state machine backing AuctionFlow.tsx (#34). Split into its
// own module (rather than living in AuctionFlow.tsx) so the component file
// only exports the component — oxlint's react/only-export-components rule
// flags mixed component+logic exports since it breaks fast refresh.
//
// Mirrors pinochle_engine.py's Round._bidding_loop / _passing_phase (frozen
// Python reference; see round.ts's module docstring — the TS engine
// doesn't reimplement bidding/passing itself, so this is UI-layer state,
// not engine state). Turn order rotates clockwise from left of dealer; a
// player who passes is out for the rest of the auction; the auction ends
// after 3 passes, or the moment only one active bidder is left once
// someone has actually bid. If nobody ever bids, the dealer is forced to
// take it at FORCED_BID (card.ts).

import type { BidRecord } from '../engine/bidding'
import { FORCED_BID, type Card, type Suit } from '../engine/card'
import type { Hands, TeamId } from '../engine/round'
import type { PlayerIndex } from '../engine/trick'
import type { AuctionLogEntry } from './auctionTypes'

interface BiddingSubstate {
  readonly active: readonly [boolean, boolean, boolean, boolean]
  readonly turn: PlayerIndex
  readonly currentBid: number
  readonly everBid: boolean
  readonly passes: number
  readonly bidWinner: PlayerIndex | null
  readonly lastBidder: PlayerIndex | null
  /** Every bid placed this auction, in order — feeds chooseBid's AuctionContext. */
  readonly bidHistory: readonly BidRecord[]
}

export type AuctionPhase =
  | 'bidding'
  | 'trump'
  | 'passing-partner-to-bidder'
  | 'passing-bidder-to-partner'
  | 'complete'

export interface AuctionState {
  readonly hands: Hands
  readonly dealer: PlayerIndex
  readonly seatNames: Record<PlayerIndex, string>
  readonly scoresByTeam: Record<TeamId, number>
  readonly bidding: BiddingSubstate
  readonly bidWinner: PlayerIndex | null
  readonly bid: number
  readonly trumpSuit: Suit | null
  readonly phase: AuctionPhase
  readonly log: readonly AuctionLogEntry[]
}

export type AuctionAction =
  | { readonly type: 'BID'; readonly player: PlayerIndex; readonly amount: number }
  | { readonly type: 'PASS_BID'; readonly player: PlayerIndex }
  | { readonly type: 'CHOOSE_TRUMP'; readonly player: PlayerIndex; readonly suit: Suit }
  | { readonly type: 'PASS_CARDS'; readonly from: PlayerIndex; readonly to: PlayerIndex; readonly cards: readonly Card[] }

export function initAuctionState(
  hands: Hands,
  dealer: PlayerIndex,
  seatNames: Record<PlayerIndex, string>,
  scoresByTeam: Record<TeamId, number>,
): AuctionState {
  return {
    hands,
    dealer,
    seatNames,
    scoresByTeam,
    bidding: {
      active: [true, true, true, true],
      turn: ((dealer + 1) % 4) as PlayerIndex,
      currentBid: 0,
      everBid: false,
      passes: 0,
      bidWinner: null,
      lastBidder: null,
      bidHistory: [],
    },
    bidWinner: null,
    bid: 0,
    trumpSuit: null,
    phase: 'bidding',
    log: [],
  }
}

function isBiddingOver(b: BiddingSubstate): boolean {
  return b.passes >= 3 || (b.everBid && b.active.filter(Boolean).length === 1)
}

/** Next active seat starting from (and including) `from`, wrapping clockwise. */
function nextActiveTurn(active: readonly boolean[], from: PlayerIndex): PlayerIndex {
  let idx = from
  for (let i = 0; i < 4; i++) {
    if (active[idx]) return idx
    idx = ((idx + 1) % 4) as PlayerIndex
  }
  return from
}

/** After a BID/PASS_BID updates `bidding`, checks whether the auction is
 * over and, if so, finalizes the contract (including the forced-bid
 * fallback) and advances to the trump phase; otherwise just hands the
 * turn to the next active seat. */
function resolveBiddingOutcome(state: AuctionState): AuctionState {
  const { bidding } = state
  if (!isBiddingOver(bidding)) {
    return { ...state, bidding: { ...bidding, turn: nextActiveTurn(bidding.active, bidding.turn) } }
  }
  if (bidding.everBid && bidding.bidWinner !== null) {
    return { ...state, phase: 'trump', bidWinner: bidding.bidWinner, bid: bidding.currentBid }
  }
  const name = state.seatNames[state.dealer]
  const log: AuctionLogEntry[] = [
    ...state.log,
    { kind: 'forced-bid', player: state.dealer, name, amount: FORCED_BID },
  ]
  return { ...state, phase: 'trump', bidWinner: state.dealer, bid: FORCED_BID, log }
}

export function auctionReducer(state: AuctionState, action: AuctionAction): AuctionState {
  switch (action.type) {
    case 'BID': {
      if (state.phase !== 'bidding') return state
      const { player, amount } = action
      const bidding: BiddingSubstate = {
        ...state.bidding,
        currentBid: amount,
        everBid: true,
        bidWinner: player,
        lastBidder: player,
        turn: ((player + 1) % 4) as PlayerIndex,
        bidHistory: [...state.bidding.bidHistory, { player, amount }],
      }
      const log: AuctionLogEntry[] = [
        ...state.log,
        { kind: 'bid', player, name: state.seatNames[player], amount },
      ]
      return resolveBiddingOutcome({ ...state, bidding, log })
    }
    case 'PASS_BID': {
      if (state.phase !== 'bidding') return state
      const { player } = action
      const active = [...state.bidding.active] as [boolean, boolean, boolean, boolean]
      active[player] = false
      const bidding: BiddingSubstate = {
        ...state.bidding,
        active,
        passes: state.bidding.passes + 1,
        turn: ((player + 1) % 4) as PlayerIndex,
      }
      const log: AuctionLogEntry[] = [...state.log, { kind: 'pass-bid', player, name: state.seatNames[player] }]
      return resolveBiddingOutcome({ ...state, bidding, log })
    }
    case 'CHOOSE_TRUMP': {
      if (state.phase !== 'trump') return state
      const { player, suit } = action
      const log: AuctionLogEntry[] = [
        ...state.log,
        { kind: 'trump', player, name: state.seatNames[player], suit },
      ]
      return { ...state, trumpSuit: suit, phase: 'passing-partner-to-bidder', log }
    }
    case 'PASS_CARDS': {
      if (state.phase !== 'passing-partner-to-bidder' && state.phase !== 'passing-bidder-to-partner') return state
      const { from, to, cards } = action
      const hands = state.hands.map((h, i) => {
        if (i === from) return h.filter((c) => !cards.includes(c))
        if (i === to) return [...h, ...cards]
        return h
      }) as Hands
      const log: AuctionLogEntry[] = [
        ...state.log,
        {
          kind: 'card-pass',
          fromPlayer: from,
          fromName: state.seatNames[from],
          toPlayer: to,
          toName: state.seatNames[to],
          count: cards.length,
        },
      ]
      const nextPhase: AuctionPhase =
        state.phase === 'passing-partner-to-bidder' ? 'passing-bidder-to-partner' : 'complete'
      return { ...state, hands, log, phase: nextPhase }
    }
    default:
      return state
  }
}

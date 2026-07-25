import type { BidRecord } from '../engine/bidding'
import { FORCED_BID, type Card, type Suit } from '../engine/card'
import { partnerOf, type Hands, type TeamId } from '../engine/round'
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
  readonly bidHistory: readonly BidRecord[]
}

export type AuctionPhase =
  | 'bidding'
  | 'trump'
  | 'passing'
  | 'pass-reveal'
  | 'complete'

/** Tracks the 3-card pass state for simultaneous exchange (#80). Both
 * players choose their cards independently; once both have chosen, the
 * cards move atomically so neither sees what they will receive before
 * committing their own selection. */
interface PassingSubstate {
  readonly fromBidderCards: readonly Card[] | null
  readonly fromPartnerCards: readonly Card[] | null
}

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
  readonly passing: PassingSubstate
  readonly log: readonly AuctionLogEntry[]
}

export type AuctionAction =
  | { readonly type: 'BID'; readonly player: PlayerIndex; readonly amount: number }
  | { readonly type: 'PASS_BID'; readonly player: PlayerIndex }
  | { readonly type: 'CHOOSE_TRUMP'; readonly player: PlayerIndex; readonly suit: Suit }
  | { readonly type: 'PASS_CARDS'; readonly from: PlayerIndex; readonly cards: readonly Card[] }
  | { readonly type: 'CONFIRM_PASS_REVEAL' }

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
    passing: { fromBidderCards: null, fromPartnerCards: null },
    log: [],
  }
}

function isBiddingOver(b: BiddingSubstate): boolean {
  return b.passes >= 3 || (b.everBid && b.active.filter(Boolean).length === 1)
}

function nextActiveTurn(active: readonly boolean[], from: PlayerIndex): PlayerIndex {
  let idx = from
  for (let i = 0; i < 4; i++) {
    if (active[idx]) return idx
    idx = ((idx + 1) % 4) as PlayerIndex
  }
  return from
}

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
      if (state.phase !== 'bidding' || action.player !== state.bidding.turn) return state
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
      if (state.phase !== 'bidding' || action.player !== state.bidding.turn) return state
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
      return { ...state, trumpSuit: suit, phase: 'passing', passing: { fromBidderCards: null, fromPartnerCards: null }, log }
    }
    case 'PASS_CARDS': {
      if (state.phase !== 'passing' || state.bidWinner === null) return state
      const { from, cards } = action
      const isBidder = from === state.bidWinner
      const fromBidderCards = isBidder ? cards : state.passing.fromBidderCards
      const fromPartnerCards = isBidder ? state.passing.fromPartnerCards : cards
      const passing: PassingSubstate = { fromBidderCards, fromPartnerCards }

      if (fromBidderCards !== null && fromPartnerCards !== null) {
        const bidder = state.bidWinner
        const partner = partnerOf(bidder)
        const hands = state.hands.map((h, i) => {
          if (i === bidder) return [...h.filter((c) => !fromBidderCards.includes(c)), ...fromPartnerCards]
          if (i === partner) return [...h.filter((c) => !fromPartnerCards.includes(c)), ...fromBidderCards]
          return h
        }) as Hands
        const log: AuctionLogEntry[] = [
          ...state.log,
          { kind: 'card-pass', fromPlayer: partner, fromName: state.seatNames[partner], toPlayer: bidder, toName: state.seatNames[bidder], count: fromPartnerCards.length },
          { kind: 'card-pass', fromPlayer: bidder, fromName: state.seatNames[bidder], toPlayer: partner, toName: state.seatNames[partner], count: fromBidderCards.length },
        ]
        return { ...state, hands, passing, log, phase: 'pass-reveal' }
      }

      return { ...state, passing, log: state.log }
    }
    case 'CONFIRM_PASS_REVEAL': {
      if (state.phase !== 'pass-reveal') return state
      return { ...state, phase: 'complete' }
    }
    default:
      return state
  }
}
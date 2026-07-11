import { useEffect, useMemo, useReducer, useRef } from 'react'
import { bestBaseBid, chooseBid, chooseTrump, type AuctionContext } from '../engine/bidding'
import { OPENING_BID } from '../engine/card'
import { PASS_COUNT, choosePassCards } from '../engine/passing'
import { teamOf, type Hands, type TeamId } from '../engine/round'
import type { PlayerIndex } from '../engine/trick'
import { AuctionLog } from './AuctionLog'
import { auctionReducer, initAuctionState } from './auctionReducer'
import type { AuctionResult } from './auctionTypes'
import { partnerOf } from './auctionTypes'
import { BiddingControls } from './BiddingControls'
import { PassSelector } from './PassSelector'
import { Table } from './Table'
import type { TableState } from './tableTypes'
import { TrumpSelector } from './TrumpSelector'

// Min raise over the current bid once someone has opened — mirrors
// pinochle_engine.py's Round._bidding_loop, which always calls
// choose_bid(current_bid, 10, ...).
const MIN_INCREMENT = 10

export interface AuctionFlowProps {
  initialHands: Hands
  seatNames: Record<PlayerIndex, string>
  humanPlayer: PlayerIndex
  dealer: PlayerIndex
  scoresByTeam: Record<TeamId, number>
  /** Fired once, when both passes have completed, with everything a live
   * Round orchestrator (trick-play, #35) needs to take over. */
  onComplete?: (result: AuctionResult) => void
}

/**
 * Drives the auction (#34): bidding, the winner's trump call, and the
 * 3-card pass, mounted into the Table scaffold (#33) so the human always
 * sees seats/hands/scoreboard behind whichever control is active. Human
 * turns wait for input via BiddingControls/TrumpSelector/PassSelector; AI
 * turns resolve automatically (bidding.ts's real chooseBid/chooseTrump
 * (#29), passing.ts's real choosePassCards) and always log a visible
 * AuctionLog entry — no AI decision happens silently.
 */
export function AuctionFlow({ initialHands, seatNames, humanPlayer, dealer, scoresByTeam, onComplete }: AuctionFlowProps) {
  const [state, dispatch] = useReducer(
    auctionReducer,
    undefined,
    () => initAuctionState(initialHands, dealer, seatNames, scoresByTeam),
  )
  const completedRef = useRef(false)

  // Resolve AI turns automatically. Runs after every state change; each
  // branch either dispatches exactly one AI decision (re-triggering this
  // effect for the next turn) or returns without dispatching because it's
  // the human's turn / there's nothing left to do this phase.
  useEffect(() => {
    if (state.phase === 'bidding') {
      const turn = state.bidding.turn
      if (turn === humanPlayer) return
      const context: AuctionContext = {
        everBid: state.bidding.everBid,
        passesSoFar: state.bidding.passes,
        bidHistory: state.bidding.bidHistory,
        dealer: state.dealer,
        scores: state.scoresByTeam,
      }
      const decision = chooseBid(turn, state.hands[turn], state.bidding.currentBid, MIN_INCREMENT, context)
      if (decision === null) dispatch({ type: 'PASS_BID', player: turn })
      else dispatch({ type: 'BID', player: turn, amount: decision })
      return
    }

    if (state.phase === 'trump') {
      if (state.bidWinner === null || state.bidWinner === humanPlayer) return
      const suit = chooseTrump(state.hands[state.bidWinner])
      dispatch({ type: 'CHOOSE_TRUMP', player: state.bidWinner, suit })
      return
    }

    if (state.phase === 'passing-partner-to-bidder' || state.phase === 'passing-bidder-to-partner') {
      if (state.bidWinner === null || state.trumpSuit === null) return
      const partner = partnerOf(state.bidWinner)
      const isPartnerStep = state.phase === 'passing-partner-to-bidder'
      const sender = isPartnerStep ? partner : state.bidWinner
      const receiver = isPartnerStep ? state.bidWinner : partner
      if (sender === humanPlayer) return
      const cards = choosePassCards(state.hands[sender], PASS_COUNT, state.trumpSuit, sender === state.bidWinner)
      dispatch({ type: 'PASS_CARDS', from: sender, to: receiver, cards })
    }
  }, [state, humanPlayer])

  // Fire onComplete exactly once, when the pass phase finishes.
  useEffect(() => {
    if (state.phase !== 'complete' || completedRef.current) return
    if (state.bidWinner === null || state.trumpSuit === null) return
    completedRef.current = true
    onComplete?.({ hands: state.hands, trumpSuit: state.trumpSuit, bidWinner: state.bidWinner, bid: state.bid })
  }, [state, onComplete])

  const tableState: TableState = useMemo(() => {
    const seatFor = (p: PlayerIndex) => ({ player: p, name: seatNames[p], hand: state.hands[p] })
    const seats: TableState['seats'] = [seatFor(0), seatFor(1), seatFor(2), seatFor(3)]
    return {
      seats,
      humanPlayer,
      trick: [],
      trumpSuit: state.trumpSuit,
      currentBid: state.bid || state.bidding.currentBid,
      bidWinner: state.bidWinner,
      scoresByTeam: state.scoresByTeam,
    }
  }, [state, seatNames, humanPlayer])

  const overlay = useMemo(() => {
    if (state.phase === 'bidding' && state.bidding.turn === humanPlayer) {
      const minBid = state.bidding.everBid ? state.bidding.currentBid + 10 : OPENING_BID
      const myTeam = teamOf(humanPlayer)
      const oppTeam: TeamId = myTeam === 0 ? 1 : 0
      // bestBaseBid's returned total is already the capped ceiling (it
      // applies cappedBid internally per trump candidate before picking
      // the best one) — a direct, non-binding hint for the human bidder.
      const { total: suggestedCeiling } = bestBaseBid(
        state.hands[humanPlayer],
        state.scoresByTeam[myTeam],
        state.scoresByTeam[oppTeam],
      )
      return (
        <BiddingControls
          minBid={minBid}
          currentBid={state.bidding.currentBid}
          suggestedCeiling={suggestedCeiling}
          onBid={(amount) => dispatch({ type: 'BID', player: humanPlayer, amount })}
          onPass={() => dispatch({ type: 'PASS_BID', player: humanPlayer })}
        />
      )
    }

    if (state.phase === 'trump' && state.bidWinner === humanPlayer) {
      return <TrumpSelector onSelect={(suit) => dispatch({ type: 'CHOOSE_TRUMP', player: humanPlayer, suit })} />
    }

    if (
      (state.phase === 'passing-partner-to-bidder' || state.phase === 'passing-bidder-to-partner') &&
      state.bidWinner !== null
    ) {
      const partner = partnerOf(state.bidWinner)
      const isPartnerStep = state.phase === 'passing-partner-to-bidder'
      const sender = isPartnerStep ? partner : state.bidWinner
      const receiver = isPartnerStep ? state.bidWinner : partner
      if (sender === humanPlayer) {
        return (
          <PassSelector
            hand={state.hands[humanPlayer]}
            count={PASS_COUNT}
            onConfirm={(cards) => dispatch({ type: 'PASS_CARDS', from: sender, to: receiver, cards })}
          />
        )
      }
    }

    return null
  }, [state, humanPlayer])

  return <Table state={tableState} overlay={overlay} logPanel={<AuctionLog entries={state.log} />} />
}

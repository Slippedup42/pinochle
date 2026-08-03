import { useEffect, useMemo, useReducer, useRef } from 'react'
import { bestBaseBid, chooseBid, chooseTrump, type AuctionContext } from '../engine/bidding'
import { OPENING_BID } from '../engine/card'
import { PASS_COUNT, choosePassCards } from '../engine/passing'
import { partnerOf, teamOf, type Hands, type TeamId } from '../engine/round'
import type { PlayerIndex } from '../engine/trick'
import type { SkillLevel } from '../persistence/options'
import { DEFAULT_OPTIONS, type GameOptions } from '../persistence/options'
import { auctionReducer, initAuctionState, passedPlayersOf } from './auctionReducer'
import type { AuctionResult } from './auctionTypes'
import { BiddingControls } from './BiddingControls'
import { PassRevealDialog } from './PassRevealDialog'
import { PassSelector } from './PassSelector'
import { DEFAULT_TEAM_NAMES } from './scoreTypes'
import { Table } from './Table'
import type { SeatCall, SeatState, TableState } from './tableTypes'
import { TrumpSelector } from './TrumpSelector'

export const AI_BID_DELAY_MS = 600

const MIN_INCREMENT = 10

/** Returns the SkillLevel to use for a given AI player, based on options. */
function skillForPlayer(player: PlayerIndex, humanPlayer: PlayerIndex, options: GameOptions): SkillLevel {
  return partnerOf(player) === humanPlayer ? options.teammateSkill : options.opponentSkill
}

export interface AuctionFlowProps {
  initialHands: Hands
  seatNames: Record<PlayerIndex, string>
  humanPlayer: PlayerIndex
  dealer: PlayerIndex
  scoresByTeam: Record<TeamId, number>
  teamNames?: Record<TeamId, string>
  onOpenMenu?: () => void
  options?: GameOptions
  onComplete?: (result: AuctionResult) => void
}

export function AuctionFlow({
  initialHands,
  seatNames,
  humanPlayer,
  dealer,
  scoresByTeam,
  teamNames = DEFAULT_TEAM_NAMES,
  onOpenMenu,
  options = DEFAULT_OPTIONS,
  onComplete,
}: AuctionFlowProps) {
  const [state, dispatch] = useReducer(
    auctionReducer,
    undefined,
    () => initAuctionState(initialHands, dealer, seatNames, scoresByTeam),
  )
  const completedRef = useRef(false)

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
        passedPlayers: passedPlayersOf(state.bidding.active),
      }
      const skill = skillForPlayer(turn, humanPlayer, options)
      const decision = chooseBid(turn, state.hands[turn], state.bidding.currentBid, MIN_INCREMENT, context, skill)
      const timer = setTimeout(() => {
        if (decision === null) dispatch({ type: 'PASS_BID', player: turn })
        else dispatch({ type: 'BID', player: turn, amount: decision })
      }, AI_BID_DELAY_MS)
      return () => clearTimeout(timer)
    }

    if (state.phase === 'trump') {
      if (state.bidWinner === null || state.bidWinner === humanPlayer) return
      const bidWinner = state.bidWinner
      const skill = skillForPlayer(bidWinner, humanPlayer, options)
      const suit = chooseTrump(state.hands[bidWinner], skill)
      const timer = setTimeout(() => {
        dispatch({ type: 'CHOOSE_TRUMP', player: bidWinner, suit })
      }, AI_BID_DELAY_MS)
      return () => clearTimeout(timer)
    }

    if (state.phase === 'pass-reveal') {
      const bidder = state.bidWinner!
      const partner = partnerOf(bidder)
      if (humanPlayer !== bidder && humanPlayer !== partner) {
        dispatch({ type: 'CONFIRM_PASS_REVEAL' })
      }
      return
    }

    if (state.phase === 'passing') {
      if (state.bidWinner === null || state.trumpSuit === null) return
      const bidder = state.bidWinner
      const partner = partnerOf(bidder)
      const bidderReady = state.passing.fromBidderCards !== null
      const partnerReady = state.passing.fromPartnerCards !== null

      const needsAI = (bidder !== humanPlayer && !bidderReady) || (partner !== humanPlayer && !partnerReady)
      if (!needsAI) return

      const timer = setTimeout(() => {
        if (bidder !== humanPlayer && !bidderReady) {
          const skill = skillForPlayer(bidder, humanPlayer, options)
          const cards = choosePassCards(state.hands[bidder], PASS_COUNT, state.trumpSuit!, true, skill)
          dispatch({ type: 'PASS_CARDS', from: bidder, cards })
        }
        if (partner !== humanPlayer && !partnerReady) {
          const skill = skillForPlayer(partner, humanPlayer, options)
          const cards = choosePassCards(state.hands[partner], PASS_COUNT, state.trumpSuit!, false, skill)
          dispatch({ type: 'PASS_CARDS', from: partner, cards })
        }
      }, AI_BID_DELAY_MS)
      return () => clearTimeout(timer)
    }
  }, [state, humanPlayer])

  useEffect(() => {
    if (state.phase !== 'complete' || completedRef.current) return
    if (state.bidWinner === null || state.trumpSuit === null) return
    completedRef.current = true
    onComplete?.({ hands: state.hands, trumpSuit: state.trumpSuit, bidWinner: state.bidWinner, bid: state.bid, log: state.log })
  }, [state, onComplete])

  const tableState: TableState = useMemo(() => {
    // The order matters and is not arbitrary: a seat that has passed is out for
    // the rest of the hand (#93), so 'pass' outranks everything, including still
    // holding the high bid from before it passed. Below that, the standing high
    // bid outranks whose turn it is, so the number stays on the board while the
    // next seat is being asked rather than blinking out and back.
    const seatFor = (p: PlayerIndex): SeatState => {
      const active = state.bidding.active[p]
      const isBidWinner = p === state.bidding.bidWinner && state.bidding.currentBid > 0
      let call: SeatCall
      if (!active) {
        call = { kind: 'pass' }
      } else if (isBidWinner) {
        call = { kind: 'bid', amount: state.bidding.currentBid }
      } else if (state.phase === 'bidding' && p === state.bidding.turn) {
        call = { kind: 'turn' }
      } else {
        call = { kind: 'waiting' }
      }
      return { player: p, name: seatNames[p], hand: state.hands[p], call }
    }
    const seats: TableState['seats'] = [seatFor(0), seatFor(1), seatFor(2), seatFor(3)]
    return {
      seats,
      humanPlayer,
      trick: [],
      trumpSuit: state.trumpSuit,
      currentBid: state.bid || state.bidding.currentBid,
      bidWinner: state.bidWinner,
      scoresByTeam: state.scoresByTeam,
      teamNames,
      dealer: state.dealer,
    }
  }, [state, seatNames, humanPlayer, teamNames])

  const overlay = useMemo(() => {
    if (state.phase === 'bidding' && state.bidding.turn === humanPlayer) {
      const minBid = state.bidding.everBid ? state.bidding.currentBid + 10 : OPENING_BID
      const myTeam = teamOf(humanPlayer)
      const oppTeam: TeamId = myTeam === 0 ? 1 : 0
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
          showBaseBidHint={options.showBaseBidHint}
          onBid={(amount) => dispatch({ type: 'BID', player: humanPlayer, amount })}
          onPass={() => dispatch({ type: 'PASS_BID', player: humanPlayer })}
        />
      )
    }

    if (state.phase === 'trump' && state.bidWinner === humanPlayer) {
      return <TrumpSelector onSelect={(suit) => dispatch({ type: 'CHOOSE_TRUMP', player: humanPlayer, suit })} />
    }

    if (state.phase === 'passing' && state.bidWinner !== null && state.trumpSuit !== null) {
      const bidder = state.bidWinner
      const partner = partnerOf(bidder)
      const myPassDone =
        (humanPlayer === bidder && state.passing.fromBidderCards !== null) ||
        (humanPlayer === partner && state.passing.fromPartnerCards !== null)

      if (!myPassDone && (humanPlayer === bidder || humanPlayer === partner)) {
        return (
          <PassSelector
            hand={state.hands[humanPlayer]}
            count={PASS_COUNT}
            trumpSuit={state.trumpSuit}
            onConfirm={(cards) => dispatch({ type: 'PASS_CARDS', from: humanPlayer, cards })}
          />
        )
      }
    }

    if (state.phase === 'pass-reveal') {
      const bidder = state.bidWinner!
      const partner = partnerOf(bidder)
      const receivedCards =
        humanPlayer === bidder ? state.passing.fromPartnerCards
        : humanPlayer === partner ? state.passing.fromBidderCards
        : null
      const senderName =
        humanPlayer === bidder ? state.seatNames[partner]
        : humanPlayer === partner ? state.seatNames[bidder]
        : ''
      return (
        <PassRevealDialog
          cards={receivedCards}
          partnerName={senderName}
          onContinue={() => dispatch({ type: 'CONFIRM_PASS_REVEAL' })}
        />
      )
    }

    return null
  }, [state, humanPlayer, options.showBaseBidHint])

  // No `logPanel` (#191). The auction used to run a corner feed — "Molly bid
  // 320", "Amanda passed" — naming seats the board was already drawing, in a
  // box that covered part of it. Every event it reported is now on the circle at
  // the seat that caused it, so the feed was restating the board in words.
  //
  // What the panel's header carried and the circle does not: the dealer, and the
  // high bid attributed by name. Both are still on screen — the dealer as the
  // `D` badge in `Seat`, the contract as "Bid: 340 (Nerida)" in `Scoreboard`.
  // What is genuinely gone is the *history*: who bid what earlier in the
  // auction, as opposed to where it now stands. `state.log` is still built and
  // still handed to `onComplete`, so restoring a view of it is a render, not a
  // rebuild.
  return <Table state={tableState} overlay={overlay} onOpenMenu={onOpenMenu} />
}
import { useEffect, useMemo, useReducer, useRef } from 'react'
import type { Card, Suit } from '../engine/card'
import type { Hands, TeamId } from '../engine/round'
import { chooseFollowCard, chooseLeadCard, PlayTracker } from '../engine/tracker'
import type { PlayerIndex } from '../engine/trick'
import { Table } from './Table'
import type { TableState } from './tableTypes'
import { TrickLog } from './TrickLog'
import { buildTrick, initTrickPlayState, teammatesOf, trickPlayReducer } from './trickPlayReducer'
import type { TrickPlayResult } from './trickPlayTypes'

export interface TrickPlayFlowProps {
  hands: Hands
  trumpSuit: Suit
  bidWinner: PlayerIndex
  /** The agreed contract amount — display-only here (Scoreboard), same
   * value AuctionResult.bid carries out of the auction phase. */
  bid: number
  seatNames: Record<PlayerIndex, string>
  humanPlayer: PlayerIndex
  scoresByTeam: Record<TeamId, number>
  /** Fired once, when all 12 tricks have been played, with the trick-point
   * contribution each team makes to a live Round orchestrator's (#47)
   * `scoreRound` call. */
  onComplete?: (result: TrickPlayResult) => void
}

// Brief pauses so AI turns and trick resolution read as a real hand being
// played rather than the state jumping silently — #35's core requirement.
// Exported (not just local) so tests can drive fake timers by these exact
// values instead of hardcoding a duplicate copy of them.
export const AI_PLAY_DELAY_MS = 700
export const TRICK_SETTLE_MS = 1200

/**
 * Drives the trick-taking phase (#35): legal-move highlighting on the
 * human's hand, playing a card into the center trick area, settling a
 * completed trick on its winner, and advancing turn order across all 12
 * tricks. Mounted into the Table scaffold (#33) — the same logPanel slot
 * AuctionFlow (#34) uses for its log, plus a further extension to
 * Table/Seat (`humanPlayable`/`trickWinner`) so the human's own hand cards
 * are directly clickable (legal ones highlighted, illegal ones dimmed)
 * rather than routed through a modal overlay control, since trick-play
 * only ever needs the human to pick one card from their own hand instead
 * of entering an amount or naming a suit.
 *
 * AI turns resolve via the real chooseLeadCard/chooseFollowCard
 * (tracker.ts, #31/#32) — not a mock — after a short delay, and always log
 * a visible TrickLog entry; no AI decision happens silently, same
 * principle AuctionFlow's AuctionLog follows for the auction/pass phase.
 */
export function TrickPlayFlow({
  hands,
  trumpSuit,
  bidWinner,
  bid,
  seatNames,
  humanPlayer,
  scoresByTeam,
  onComplete,
}: TrickPlayFlowProps) {
  const [state, dispatch] = useReducer(
    trickPlayReducer,
    undefined,
    () => initTrickPlayState(hands, trumpSuit, bidWinner, seatNames),
  )
  // Accumulates every card played so far this round (tracker.ts's
  // PlayTracker) — mutated directly alongside each PLAY_CARD dispatch
  // rather than derived from reducer state, since it's an append-only
  // strategy input the AI reads, not something any render needs back.
  const trackerRef = useRef(new PlayTracker())
  const completedRef = useRef(false)

  // Resolve AI turns automatically, after a brief delay so the play reads
  // as a real decision rather than an instant jump. Runs after every state
  // change; only actually schedules a play when it's an AI seat's turn.
  useEffect(() => {
    if (state.phase !== 'playing' || state.turn === humanPlayer) return
    const player = state.turn
    const timer = setTimeout(() => {
      const hand = state.hands[player]
      const trick = buildTrick(state.trumpSuit, state.currentTrick)
      const legal = trick.legalMoves(hand)
      const card =
        state.currentTrick.length === 0
          ? chooseLeadCard(hand, state.trumpSuit, trackerRef.current)
          : chooseFollowCard(hand, legal, state.currentTrick, state.trumpSuit, teammatesOf(player), trackerRef.current)
      trackerRef.current.record(card)
      dispatch({ type: 'PLAY_CARD', player, card })
    }, AI_PLAY_DELAY_MS)
    return () => clearTimeout(timer)
  }, [state, humanPlayer])

  // Once a trick completes, pause so the human can see all 4 cards and the
  // winner highlight before it's cleared for the next trick.
  useEffect(() => {
    if (state.phase !== 'trick-complete') return
    const timer = setTimeout(() => dispatch({ type: 'CLEAR_TRICK' }), TRICK_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [state.phase, state.trickWinners.length])

  // Fire onComplete exactly once, when all 12 tricks are done.
  useEffect(() => {
    if (state.phase !== 'complete' || completedRef.current) return
    completedRef.current = true
    onComplete?.({ trickPointsByTeam: state.trickPointsByTeam, trickWinners: state.trickWinners })
  }, [state, onComplete])

  const legalMovesForHuman = useMemo(() => {
    if (state.phase !== 'playing' || state.turn !== humanPlayer) return null
    const trick = buildTrick(state.trumpSuit, state.currentTrick)
    return trick.legalMoves(state.hands[humanPlayer])
  }, [state, humanPlayer])

  const tableState: TableState = useMemo(() => {
    const seatFor = (p: PlayerIndex) => ({ player: p, name: seatNames[p], hand: state.hands[p] })
    const seats: TableState['seats'] = [seatFor(0), seatFor(1), seatFor(2), seatFor(3)]
    const humanPlayable: TableState['humanPlayable'] = legalMovesForHuman
      ? {
          legalCards: legalMovesForHuman,
          onPlay: (card: Card) => {
            trackerRef.current.record(card)
            dispatch({ type: 'PLAY_CARD', player: humanPlayer, card })
          },
        }
      : undefined

    return {
      seats,
      humanPlayer,
      trick: state.currentTrick,
      trumpSuit: state.trumpSuit,
      currentBid: bid,
      bidWinner: state.bidWinner,
      scoresByTeam,
      humanPlayable,
      trickWinner: state.phase === 'trick-complete' ? (state.trickWinners.at(-1) ?? null) : null,
    }
  }, [state, seatNames, humanPlayer, bid, scoresByTeam, legalMovesForHuman])

  return <Table state={tableState} logPanel={<TrickLog entries={state.log} />} />
}

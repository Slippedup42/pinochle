import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { Card, Suit } from '../engine/card'
import { shouldConcede } from '../engine/evaluator'
import { isAutoSet, partnerOf, teamOf, type Hands, type TeamId } from '../engine/round'
import { SKILL_PARAMS } from '../engine/skills'
import { chooseFollowCard, chooseLeadCard, PlayTracker } from '../engine/tracker'
import type { PlayerIndex } from '../engine/trick'
import type { SkillLevel } from '../persistence/options'
import { DEFAULT_OPTIONS, type GameOptions } from '../persistence/options'
import { DEFAULT_TEAM_NAMES } from './scoreTypes'
import { Table } from './Table'
import type { TableState } from './tableTypes'
import { AuctionLog } from './AuctionLog'
import { AutoSetNotice } from './AutoSetNotice'
import { ConfirmDialog } from './ConfirmDialog'
import { TrickLog } from './TrickLog'
import {
  buildTrick,
  initTrickPlayState,
  teammatesOf,
  trickPlayReducer,
  type TrickPlayState,
} from './trickPlayReducer'
import type { TrickPlayResult } from './trickPlayTypes'
import type { AuctionLogEntry } from './auctionTypes'

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
  /** Meld points per team, computed during the meld phase. Feeds the
   * scoreboard, `shouldConcede`'s fold model, and the auto-SET check (#178)
   * that detects a mathematically impossible contract before the first lead. */
  meldPointsByTeam: Record<TeamId, number>
  /** Full auction/pass event log (#77), kept visible during trick-play so
   * the human can review every bid, who bid, and the amounts. */
  auctionLog?: readonly AuctionLogEntry[]
  /** Randomized per-game team display names (#73), threaded straight into
   * the TableState this component builds for Table/Scoreboard. Defaults to
   * scoreTypes.ts's DEFAULT_TEAM_NAMES ("Team A"/"Team B") when omitted —
   * GameFlow.tsx always supplies real per-game names in practice. */
  teamNames?: Record<TeamId, string>
  /** Dealer seat (#76) — threaded through so the dealer badge shows on the
   * table during trick-play too. AuctionFlow already tracks it; GameFlow
   * passes it along. */
  dealer: PlayerIndex
  /** Local autosave (#54): resume from a saved trick-play checkpoint
   * (GameFlowState.trickPlayCheckpoint) instead of dealing out `hands`
   * fresh via initTrickPlayState. Only ever set by GameFlow.tsx's "Continue"
   * path — a normal auction-to-trick-play handoff omits this. */
  initialState?: TrickPlayState
  /** Local autosave (#54): fired after each completed trick (never
   * mid-trick or mid-AI-delay) with the current TrickPlayState, so
   * GameFlow.tsx can checkpoint it — see GameFlowState.trickPlayCheckpoint. */
  onCheckpoint?: (state: TrickPlayState) => void
  /** Opens the persistent mid-game menu (#54: New Game / Continue /
   * Options) — rendered by Table.tsx as a small corner button. Omit to
   * render without one (e.g. existing tests that don't exercise it). */
  onOpenMenu?: () => void
  /** Options toggles (#54) affecting rendering. Defaults to
   * DEFAULT_OPTIONS (current pre-#54 behavior) when omitted. */
  options?: GameOptions
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

/** Returns the SkillLevel to use for a given AI player, based on options. */
function skillForPlayer(player: PlayerIndex, humanPlayer: PlayerIndex, options: GameOptions): SkillLevel {
  return partnerOf(player) === humanPlayer ? options.teammateSkill : options.opponentSkill
}

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
  meldPointsByTeam,
  auctionLog,
  seatNames,
  humanPlayer,
  scoresByTeam,
  teamNames = DEFAULT_TEAM_NAMES,
  dealer,
  initialState,
  onCheckpoint,
  onOpenMenu,
  options = DEFAULT_OPTIONS,
  onComplete,
}: TrickPlayFlowProps) {
  const [state, dispatch] = useReducer(
    trickPlayReducer,
    undefined,
    () => initialState ?? initTrickPlayState(hands, trumpSuit, bidWinner, seatNames),
  )
  // Accumulates every card played so far this round (tracker.ts's
  // PlayTracker) — mutated directly alongside each PLAY_CARD dispatch
  // rather than derived from reducer state, since it's an append-only
  // strategy input the AI reads, not something any render needs back.
  const trackerRef = useRef(new PlayTracker())
  const completedRef = useRef(false)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)
  // Set when the auto-SET rule (#178) fires, cleared when the player
  // acknowledges the notice. While true it holds the round open: the CONCEDE
  // has already been dispatched and the hand is decided, but `onComplete`
  // (below) waits for this to clear before handing off, so the round summary
  // cannot appear before the explanation of why no cards were played.
  const [autoSetFired, setAutoSetFired] = useState(false)

  // Concede/fold for an AI bid winner (#123), in the same window the human's
  // fold button gets: after meld, before the first card of the round.
  //
  // Declared *before* the AI-play effect on purpose. Both run in the same
  // commit, so this one dispatches CONCEDE while that one is still only
  // scheduling a timer; the resulting re-render lands on `phase: 'complete'`,
  // whose cleanup clears that timer before it can fire. Ordering them the other
  // way would let a card hit the table first on a hand the AI meant to throw in.
  //
  // The `cardsPlayed === 0` guard is what makes this safe to re-run: the effect
  // re-fires on every state change, and on a #54 resume `initialState` can drop
  // us into a contract already under way, where the concede window has closed.
  const foldAskedRef = useRef(false)
  const cardsPlayed = state.log.filter((e) => e.kind === 'card-play').length
  useEffect(() => {
    if (foldAskedRef.current) return
    if (state.phase !== 'playing' || cardsPlayed > 0) return
    foldAskedRef.current = true

    const biddingTeam = teamOf(bidWinner)
    const biddingMeld = meldPointsByTeam[biddingTeam]

    // Auto-SET (#178) comes first, and applies to *every* bid winner including
    // the human — hence ahead of the `bidWinner === humanPlayer` guard below
    // and of any skill lookup. When meld plus all 250 trick points still falls
    // short of the bid the contract is arithmetically dead, and `shouldConcede`
    // is a fitted probability model: a hand that cannot be made must never
    // reach a probabilistic evaluator to be talked into playing on.
    //
    // CONCEDE is dispatched immediately rather than on the player's
    // acknowledgement, so `state.phase` becomes 'complete' in this same commit
    // and the AI-play effect below stops for the same reason it stops after a
    // human fold. What waits for the acknowledgement is `onComplete`, not the
    // fold.
    if (isAutoSet(biddingMeld, bid)) {
      setAutoSetFired(true)
      dispatch({ type: 'CONCEDE' })
      return
    }

    if (bidWinner === humanPlayer) return

    const skill = skillForPlayer(bidWinner, humanPlayer, options)
    if (SKILL_PARAMS[skill].foldPolicy !== 'model') return

    if (
      shouldConcede({
        hand: state.hands[bidWinner],
        trump: state.trumpSuit,
        bid,
        biddingMeld,
        defendingMeld: meldPointsByTeam[(1 - biddingTeam) as TeamId],
      })
    ) {
      dispatch({ type: 'CONCEDE' })
    }
  }, [state, cardsPlayed, bidWinner, humanPlayer, options, bid, meldPointsByTeam])

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
      const isBidderFirstLead = state.trickNumber === 0 && player === state.bidWinner && state.currentTrick.length === 0
      const skill = skillForPlayer(player, humanPlayer, options)
      const isBiddingTeam = teamOf(player) === teamOf(state.bidWinner)
      const card =
        state.currentTrick.length === 0
          ? chooseLeadCard(hand, state.trumpSuit, trackerRef.current, isBidderFirstLead, skill, isBiddingTeam)
          : chooseFollowCard(hand, legal, state.currentTrick, state.trumpSuit, teammatesOf(player), trackerRef.current, skill)
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

  // Fire onComplete exactly once, when all 12 tricks are done (or the hand was
  // conceded). An unacknowledged auto-SET notice (#178) holds this back — the
  // round is already decided, but handing off would unmount this component and
  // take the explanation with it, leaving the player at a round summary for a
  // hand they never saw played.
  useEffect(() => {
    if (state.phase !== 'complete' || completedRef.current || autoSetFired) return
    completedRef.current = true
    const result: TrickPlayResult = {
      trickPointsByTeam: state.trickPointsByTeam,
      trickWinners: state.trickWinners,
      ...(state.conceded ? { conceded: true } : {}),
    }
    onComplete?.(result)
  }, [state, onComplete, autoSetFired])

  // Local autosave (#54): checkpoint after each completed trick — i.e.
  // whenever currentTrick is empty (a fresh trick just started, or all 12
  // are done). Deliberately excludes mid-trick states (1-3 cards played)
  // and the 'trick-complete' settle pause (currentTrick still has all 4
  // cards until CLEAR_TRICK fires) — "not mid-animation", per #54.
  useEffect(() => {
    if (state.currentTrick.length > 0) return
    // Don't checkpoint an auto-SET (#178) that has not been acknowledged yet.
    // The state is already 'complete', so saving it would resume straight past
    // the explanation into the round summary. Leaving the checkpoint null makes
    // a resume re-enter trick-play from scratch, where the rule fires again and
    // the notice is shown again — the round is decided either way, so the only
    // difference is whether the player gets told.
    if (autoSetFired) return
    onCheckpoint?.(state)
  }, [state, onCheckpoint, autoSetFired])

  // Concede/fold (#83): show a fold button when the human won the bid, hide
  // it after they play their first card or the hand ends.
  const humanHasPlayedACard = state.log.some(
    (e) => e.kind === 'card-play' && e.player === humanPlayer,
  )
  const canConcede = state.phase !== 'complete' && bidWinner === humanPlayer && !humanHasPlayedACard

  const legalMovesForHuman = useMemo(() => {
    if (state.phase !== 'playing' || state.turn !== humanPlayer) return null
    const trick = buildTrick(state.trumpSuit, state.currentTrick)
    let moves = trick.legalMoves(state.hands[humanPlayer])
    // Bidder must lead trump on their first lead (#82)
    if (state.trickNumber === 0 && state.turn === state.bidWinner && state.currentTrick.length === 0) {
      const trumpCards = moves.filter((c) => c.suit === state.trumpSuit)
      if (trumpCards.length > 0) moves = trumpCards
    }
    return moves
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
      teamNames,
      humanPlayable,
      dealer,
      meldPoints: meldPointsByTeam[teamOf(state.bidWinner)],
      trickWinner: state.phase === 'trick-complete' ? (state.trickWinners.at(-1) ?? null) : null,
    }
  }, [state, seatNames, humanPlayer, bid, scoresByTeam, teamNames, meldPointsByTeam, legalMovesForHuman])

  const handleConcede = useCallback(() => {
    dispatch({ type: 'CONCEDE' })
    setShowConfirmDialog(false)
  }, [])

  const biddingTeamId = teamOf(bidWinner)
  const defendingTeamId = (1 - biddingTeamId) as TeamId

  return (
    <div className="relative">
      {autoSetFired && (
        <AutoSetNotice
          biddingTeamName={teamNames[biddingTeamId]}
          defendingTeamName={teamNames[defendingTeamId]}
          bid={bid}
          biddingMeld={meldPointsByTeam[biddingTeamId]}
          defendingMeld={meldPointsByTeam[defendingTeamId]}
          humanIsBidder={bidWinner === humanPlayer}
          onDismiss={() => setAutoSetFired(false)}
        />
      )}
      {canConcede && (
        <>
          <button
            type="button"
            onClick={() => setShowConfirmDialog(true)}
            // Safe-area insets (#161): pinned to the top-right corner, which is
            // where the status bar / notch sits on an installed instance.
            className="absolute top-[calc(0.5rem_+_var(--safe-top))] right-[calc(0.5rem_+_var(--safe-right))] z-20 rounded bg-red-800 px-3 py-1 text-xs font-semibold text-white hover:bg-red-900"
          >
            Concede hand
          </button>
          {showConfirmDialog && (
            <ConfirmDialog
              message={`Are you sure? Your team will score -${bid} points`}
              confirmLabel="Concede"
              onConfirm={handleConcede}
              onCancel={() => setShowConfirmDialog(false)}
            />
          )}
        </>
      )}
      <Table
        state={tableState}
        logPanel={
          <div className="flex flex-col gap-2">
            {auctionLog && auctionLog.length > 0 && <AuctionLog entries={auctionLog} />}
            {!options.hideTrickLog && <TrickLog entries={state.log} />}
          </div>
        }
        onOpenMenu={onOpenMenu}
        trickNumber={state.trickNumber + 1}
      />
    </div>
  )
}

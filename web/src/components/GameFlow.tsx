import { useCallback, useEffect, useReducer } from 'react'
import { Deck } from '../engine/card'
import { MISDEAL_NINE_THRESHOLD, nineCount } from '../engine/misdeal'
import type { Hands } from '../engine/round'
import type { PlayerIndex } from '../engine/trick'
import { clearSave, saveGame } from '../persistence/gameSave'
import { DEFAULT_OPTIONS, type GameOptions } from '../persistence/options'
import { AuctionFlow } from './AuctionFlow'
import type { AuctionResult } from './auctionTypes'
import {
  gameFlowReducer,
  HUMAN_PLAYER,
  initGameFlowState,
  INITIAL_DEALER,
  SEAT_NAMES,
  type GameFlowState,
} from './gameFlowReducer'
import { GameOverScreen } from './GameOverScreen'
import { MisdealPrompt } from './MisdealPrompt'
import { RoundSummary } from './RoundSummary'
import { Table } from './Table'
import type { TableState } from './tableTypes'
import { TrickPlayFlow } from './TrickPlayFlow'
import type { TrickPlayState } from './trickPlayReducer'
import type { TrickPlayResult } from './trickPlayTypes'

/**
 * Top-level round/game state machine (#47): deal -> misdeal check (house
 * rule, pinochle_rules.md) -> auction (AuctionFlow, #34) -> trick-play
 * (TrickPlayFlow, #35) -> round summary (#36) -> loop into another round or
 * game-over (#36). Follows the same reducer-driven, plain-data-props
 * pattern as auctionReducer.ts/trickPlayReducer.ts (gameFlowReducer.ts) —
 * this is the phase *above* those two, orchestrating which phase component
 * is mounted rather than turns within a single phase.
 *
 * Dealing and the misdeal/reshuffle house rule live here rather than in
 * AuctionFlow, since a reshuffle has to happen before the auction even
 * starts and AuctionFlow only ever receives an already-finalized hand.
 */
export interface GameFlowProps {
  /** Local autosave (#54): resume from a previously saved state (the main
   * menu's "Continue") instead of starting a fresh deal. Omit to start a
   * new game via the normal deal -> misdeal-check flow (also what existing
   * callers/tests that don't know about #54 get). */
  initialState?: GameFlowState
  /** Options toggles (#54) affecting rendering. Defaults to
   * DEFAULT_OPTIONS (current pre-#54 behavior) when omitted. */
  options?: GameOptions
  /** Opens the persistent mid-game menu (#54: New Game / Continue /
   * Options) — threaded down to every Table.tsx render (dealing/misdeal,
   * auction, trick-play) so a player is never stranded once a round has
   * started. Omit to render without one. */
  onOpenMenu?: () => void
}

export function GameFlow({ initialState, options = DEFAULT_OPTIONS, onOpenMenu }: GameFlowProps = {}) {
  const [state, dispatch] = useReducer(
    gameFlowReducer,
    undefined,
    () => initialState ?? initGameFlowState(INITIAL_DEALER),
  )

  // Deal (or redeal) a fresh shuffled 48-card hand whenever entering the
  // 'dealing' phase — a fresh game start, a misdeal reshuffle, and the next
  // round after a round-summary continue all funnel through here, so
  // there's exactly one place real (Math.random-based) dealing happens.
  useEffect(() => {
    if (state.phase !== 'dealing') return
    const deck = new Deck()
    deck.shuffle()
    const hands = deck.deal()
    dispatch({ type: 'HANDS_DEALT', hands })
  }, [state.phase])

  // Local autosave (#54): checkpoint after every state change except
  // 'dealing' (near-instant and hands are still empty there — the effect
  // above resolves it before the next paint in practice, so skipping it
  // just avoids a redundant/incomplete write). Every other phase change is
  // a natural checkpoint: hands dealt, misdeal resolved, auction complete
  // (trump/bid known), each trick-play checkpoint (see TRICK_CHECKPOINT
  // below), round-summary, and game-over.
  useEffect(() => {
    if (state.phase === 'dealing') return
    saveGame(state)
  }, [state])

  // Stable dispatch-wrapping callbacks (#54): TrickPlayFlow's onCheckpoint
  // effect has no "already fired" guard — it's meant to fire once per
  // trick, not once ever — so if this callback got a new identity every
  // GameFlow render (as an inline arrow function here would), the effect
  // would re-fire on every render, dispatch again, trigger another render,
  // and loop forever. useReducer's dispatch is referentially stable across
  // renders, so wrapping it in useCallback with no other dependencies keeps
  // these callbacks stable too. AUCTION_COMPLETE/TRICK_COMPLETE don't
  // strictly need this (their onComplete effects guard against re-firing
  // with a ref), but it's cheap and keeps the pattern consistent.
  const handleAuctionComplete = useCallback(
    (result: AuctionResult) => dispatch({ type: 'AUCTION_COMPLETE', result }),
    [],
  )
  const handleTrickComplete = useCallback(
    (result: TrickPlayResult) => dispatch({ type: 'TRICK_COMPLETE', result }),
    [],
  )
  const handleTrickCheckpoint = useCallback(
    (snapshot: TrickPlayState) => dispatch({ type: 'TRICK_CHECKPOINT', snapshot }),
    [],
  )

  // Misdeal/reshuffle house rule (pinochle_rules.md): check each seat in
  // fixed order (mirrors human_play.py's `_check_misdeal` loop over
  // `self.players`). A seat with fewer than 5 nines is skipped
  // automatically; an eligible AI seat always takes the reshuffle
  // automatically; an eligible human seat waits here for their own choice,
  // made via the MisdealPrompt overlay rendered below.
  useEffect(() => {
    if (state.phase !== 'misdeal-check') return
    const idx = state.misdealCheckIndex
    if (idx >= 4) return
    const player = idx as PlayerIndex
    const eligible = nineCount(state.hands[player]) >= MISDEAL_NINE_THRESHOLD
    if (!eligible) {
      dispatch({ type: 'MISDEAL_ADVANCE' })
      return
    }
    if (player !== HUMAN_PLAYER) {
      dispatch({ type: 'MISDEAL_RESHUFFLE' })
    }
    // else: human is eligible — wait for their explicit choice, below.
  }, [state.phase, state.misdealCheckIndex, state.hands])

  if (state.phase === 'auction') {
    return (
      <AuctionFlow
        initialHands={state.hands}
        seatNames={SEAT_NAMES}
        humanPlayer={HUMAN_PLAYER}
        dealer={state.dealer}
        scoresByTeam={state.scoresByTeam}
        onOpenMenu={onOpenMenu}
        options={options}
        onComplete={handleAuctionComplete}
      />
    )
  }

  if (state.phase === 'trick-play' && state.auctionResult) {
    const { hands, trumpSuit, bidWinner, bid } = state.auctionResult
    return (
      <TrickPlayFlow
        hands={hands.map((h) => [...h]) as Hands}
        trumpSuit={trumpSuit}
        bidWinner={bidWinner}
        bid={bid}
        seatNames={SEAT_NAMES}
        humanPlayer={HUMAN_PLAYER}
        scoresByTeam={state.scoresByTeam}
        // Local autosave (#54): resume mid-round from the last checkpoint
        // when there is one (only set right after LOAD_SAVE resumed a save
        // straight into this phase — a normal auction handoff clears it),
        // otherwise TrickPlayFlow deals `hands` out fresh as before.
        initialState={state.trickPlayCheckpoint ?? undefined}
        onCheckpoint={handleTrickCheckpoint}
        onOpenMenu={onOpenMenu}
        options={options}
        onComplete={handleTrickComplete}
      />
    )
  }

  if (state.phase === 'round-summary' && state.roundSummary) {
    return <RoundSummary data={state.roundSummary} onContinue={() => dispatch({ type: 'CONTINUE_ROUND' })} />
  }

  if (state.phase === 'game-over' && state.gameOverData) {
    return (
      <GameOverScreen
        data={state.gameOverData}
        onNewGame={() => {
          // Local autosave (#54): the finished game's save would otherwise
          // briefly linger on disk (the autosave effect above skips writes
          // while phase === 'dealing', so it isn't overwritten until the
          // next real checkpoint) — clear it explicitly so a refresh in
          // that window can't offer "Continue" back into a game that's
          // already over.
          clearSave()
          dispatch({ type: 'NEW_GAME', dealer: INITIAL_DEALER })
        }}
      />
    )
  }

  // 'dealing' (near-instant, resolved by the effect above before the next
  // paint in practice) and 'misdeal-check' both render the table
  // underneath, the same shell AuctionFlow uses — misdeal-check adds the
  // human's reshuffle prompt once the check reaches their seat.
  const seatFor = (p: PlayerIndex) => ({ player: p, name: SEAT_NAMES[p], hand: state.hands[p] })
  const tableState: TableState = {
    seats: [seatFor(0), seatFor(1), seatFor(2), seatFor(3)],
    humanPlayer: HUMAN_PLAYER,
    trick: [],
    trumpSuit: null,
    currentBid: 0,
    bidWinner: null,
    scoresByTeam: state.scoresByTeam,
  }

  const humanMisdealEligible =
    state.phase === 'misdeal-check' &&
    state.misdealCheckIndex === HUMAN_PLAYER &&
    nineCount(state.hands[HUMAN_PLAYER]) >= MISDEAL_NINE_THRESHOLD

  const overlay = humanMisdealEligible ? (
    <MisdealPrompt
      nineCount={nineCount(state.hands[HUMAN_PLAYER])}
      onReshuffle={() => dispatch({ type: 'MISDEAL_RESHUFFLE' })}
      onDecline={() => dispatch({ type: 'MISDEAL_ADVANCE' })}
    />
  ) : undefined

  return (
    <Table
      state={tableState}
      overlay={overlay}
      onOpenMenu={onOpenMenu}
      hideOpponentCards={options.hideOpponentCards}
    />
  )
}

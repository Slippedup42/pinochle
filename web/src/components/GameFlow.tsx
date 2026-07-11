import { useEffect, useReducer } from 'react'
import { Deck } from '../engine/card'
import { MISDEAL_NINE_THRESHOLD, nineCount } from '../engine/misdeal'
import type { Hands } from '../engine/round'
import type { PlayerIndex } from '../engine/trick'
import { AuctionFlow } from './AuctionFlow'
import { gameFlowReducer, HUMAN_PLAYER, initGameFlowState, INITIAL_DEALER, SEAT_NAMES } from './gameFlowReducer'
import { GameOverScreen } from './GameOverScreen'
import { MisdealPrompt } from './MisdealPrompt'
import { RoundSummary } from './RoundSummary'
import { Table } from './Table'
import type { TableState } from './tableTypes'
import { TrickPlayFlow } from './TrickPlayFlow'

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
export function GameFlow() {
  const [state, dispatch] = useReducer(gameFlowReducer, INITIAL_DEALER, initGameFlowState)

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
        onComplete={(result) => dispatch({ type: 'AUCTION_COMPLETE', result })}
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
        onComplete={(result) => dispatch({ type: 'TRICK_COMPLETE', result })}
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
        onNewGame={() => dispatch({ type: 'NEW_GAME', dealer: INITIAL_DEALER })}
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

  return <Table state={tableState} overlay={overlay} />
}

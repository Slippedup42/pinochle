// Round/game state machine backing GameFlow.tsx (#47). Split into its own
// module (rather than living in GameFlow.tsx) so the component file only
// exports the component — oxlint's react/only-export-components rule flags
// mixed component+logic exports since it breaks fast refresh (same reason
// auctionReducer.ts/trickPlayReducer.ts are split out from their
// components).
//
// This is the phase *above* AuctionFlow (#34)/TrickPlayFlow (#35): it
// doesn't reimplement bidding or trick-taking, it decides which of those
// phase components is mounted and carries their results (AuctionResult,
// TrickPlayResult) into round scoring (melds.ts/round.ts's scoreRound) and
// game-over detection (game.ts's checkGameOutcome), then loops into the
// next round or ends the game. Dealing and the misdeal/reshuffle house rule
// (pinochle_rules.md) live here too, since a reshuffle has to happen before
// the auction even starts — the phase components below only ever receive
// an already-finalized hand.

import { checkGameOutcome } from '../engine/game'
import { scoreMelds } from '../engine/melds'
import { sampleNames } from '../engine/names'
import { scoreRound, teamOf, type Hands, type TeamId } from '../engine/round'
import { sampleTeamNames } from '../engine/teamNames'
import type { PlayerIndex } from '../engine/trick'
import type { AuctionResult } from './auctionTypes'
import type { GameOverData, RoundSummaryData } from './scoreTypes'
import type { TrickPlayState } from './trickPlayReducer'
import type { TrickPlayResult } from './trickPlayTypes'

export type GameFlowPhase =
  | 'dealing'
  | 'misdeal-check'
  | 'auction'
  | 'trick-play'
  | 'round-summary'
  | 'game-over'

export interface GameFlowState {
  readonly phase: GameFlowPhase
  readonly hands: Hands
  readonly dealer: PlayerIndex
  /** Cumulative game score per team, carried across rounds. */
  readonly scoresByTeam: Record<TeamId, number>
  /** Seat (0..3) the misdeal check has reached; 4 once every seat has been
   * cleared without a reshuffle, per human_play.py's `_check_misdeal` loop
   * over `self.players` in fixed seat order. */
  readonly misdealCheckIndex: number
  readonly auctionResult: AuctionResult | null
  readonly roundSummary: RoundSummaryData | null
  readonly gameOverData: GameOverData | null
  /** Local autosave (#54): a snapshot of TrickPlayFlow's internal state,
   * taken after each completed trick (never mid-trick/mid-AI-delay — see
   * TrickPlayFlow.tsx's onCheckpoint). null outside the trick-play phase.
   * On resume, GameFlow.tsx passes this to TrickPlayFlow as its
   * `initialState`, bypassing the normal from-scratch deal-based init so a
   * reload lands back on the exact trick in progress rather than the start
   * of the round. */
  readonly trickPlayCheckpoint: TrickPlayState | null
  /** Randomized per-seat display names (#73): seat 0 (the human) is always
   * 'You'; seats 1/2/3 get 3 unique names drawn from names.ts's NAME_POOL.
   * Generated once when a new game starts (initGameFlowState/NEW_GAME) —
   * not regenerated on every render/action — so a resumed game (via the
   * autosave/resume machinery, persistence/gameSave.ts) keeps the same
   * opponent names rather than redrawing them. */
  readonly seatNames: Record<PlayerIndex, string>
  /** Randomized per-team display names (#73), drawn from teamNames.ts's
   * TEAM_NAME_POOL — same once-per-new-game generation and
   * autosave/resume persistence as seatNames above. */
  readonly teamNames: Record<TeamId, string>
}

export type GameFlowAction =
  | { readonly type: 'HANDS_DEALT'; readonly hands: Hands }
  | { readonly type: 'MISDEAL_ADVANCE' }
  | { readonly type: 'MISDEAL_RESHUFFLE' }
  | { readonly type: 'AUCTION_COMPLETE'; readonly result: AuctionResult }
  | { readonly type: 'TRICK_COMPLETE'; readonly result: TrickPlayResult }
  | { readonly type: 'CONTINUE_ROUND' }
  | { readonly type: 'NEW_GAME'; readonly dealer: PlayerIndex }
  /** Local autosave (#54): records a trick-play checkpoint (see
   * GameFlowState.trickPlayCheckpoint) as trick-play progresses. */
  | { readonly type: 'TRICK_CHECKPOINT'; readonly snapshot: TrickPlayState }
  /** Local autosave (#54): replaces the whole state with a previously
   * saved one (the main menu's "Continue"). A plain assignment rather than
   * a merge — resuming should reproduce the saved game exactly, not layer
   * onto whatever the reducer happened to be initialized with. */
  | { readonly type: 'LOAD_SAVE'; readonly state: GameFlowState }

// Static table config GameFlow.tsx renders with — split out here (rather
// than exported alongside the component) so GameFlow.tsx only exports the
// component itself; oxlint's react/only-export-components rule flags mixed
// component+value exports since it breaks fast refresh (same reason these
// don't live in AuctionFlow.tsx/TrickPlayFlow.tsx either).
export const HUMAN_PLAYER: PlayerIndex = 0
export const INITIAL_DEALER: PlayerIndex = 3

const TEAM_IDS: readonly TeamId[] = [0, 1]

/** Draws a fresh set of randomized seat names (#73): seat 0 is always
 * 'You', seats 1/2/3 get 3 unique names from names.ts's NAME_POOL. */
function randomSeatNames(): Record<PlayerIndex, string> {
  const [west, partner, east] = sampleNames(3)
  return { 0: 'You', 1: west, 2: partner, 3: east }
}

/** Draws a fresh set of randomized team names (#73) from teamNames.ts's
 * TEAM_NAME_POOL. */
function randomTeamNames(): Record<TeamId, string> {
  const [team0, team1] = sampleTeamNames(2)
  return { 0: team0, 1: team1 }
}

export function initGameFlowState(dealer: PlayerIndex): GameFlowState {
  return {
    phase: 'dealing',
    hands: [[], [], [], []] as Hands,
    dealer,
    scoresByTeam: { 0: 0, 1: 0 },
    misdealCheckIndex: 0,
    auctionResult: null,
    roundSummary: null,
    gameOverData: null,
    trickPlayCheckpoint: null,
    seatNames: randomSeatNames(),
    teamNames: randomTeamNames(),
  }
}

/** Melds each hand (post-pass, pre-trick, i.e. still the full 12 cards)
 * under trump, summed per team — the missing ingredient (alongside
 * TrickPlayResult's trick points) `scoreRound` needs. */
function meldPointsByTeam(
  hands: AuctionResult['hands'],
  trumpSuit: AuctionResult['trumpSuit'],
): Record<TeamId, number> {
  const totals: Record<TeamId, number> = { 0: 0, 1: 0 }
  for (let i = 0; i < 4; i++) {
    const player = i as PlayerIndex
    const { total } = scoreMelds(hands[player], trumpSuit)
    totals[teamOf(player)] += total
  }
  return totals
}

export function gameFlowReducer(state: GameFlowState, action: GameFlowAction): GameFlowState {
  switch (action.type) {
    case 'HANDS_DEALT': {
      return {
        ...state,
        hands: action.hands,
        misdealCheckIndex: 0,
        phase: 'misdeal-check',
        auctionResult: null,
        roundSummary: null,
        trickPlayCheckpoint: null,
      }
    }
    case 'MISDEAL_ADVANCE': {
      if (state.phase !== 'misdeal-check') return state
      const nextIndex = state.misdealCheckIndex + 1
      if (nextIndex >= 4) return { ...state, phase: 'auction', misdealCheckIndex: nextIndex }
      return { ...state, misdealCheckIndex: nextIndex }
    }
    case 'MISDEAL_RESHUFFLE': {
      if (state.phase !== 'misdeal-check') return state
      // Redeal and recheck from scratch — a fresh deal could hand 5+ nines
      // to someone else, or the same player again (pinochle_rules.md).
      return { ...state, phase: 'dealing' }
    }
    case 'AUCTION_COMPLETE': {
      if (state.phase !== 'auction') return state
      // trickPlayCheckpoint is cleared (not carried over) here: this is a
      // genuinely fresh trick-play phase driven by a real auction just
      // finishing, not a resume-from-save — TrickPlayFlow.tsx will mount
      // and re-checkpoint at trick 0 on its own once it does.
      return { ...state, phase: 'trick-play', auctionResult: action.result, trickPlayCheckpoint: null }
    }
    case 'TRICK_COMPLETE': {
      if (state.phase !== 'trick-play' || state.auctionResult === null) return state
      const { hands, trumpSuit, bidWinner, bid } = state.auctionResult
      const meldPoints = meldPointsByTeam(hands, trumpSuit)
      const bidWinnerTeam = teamOf(bidWinner)
      const roundScoreByTeam = scoreRound({
        meldPointsByTeam: meldPoints,
        trickPointsByTeam: action.result.trickPointsByTeam,
        bidWinnerTeam,
        bid,
      })
      const cumulativeScoresByTeam: Record<TeamId, number> = { 0: 0, 1: 0 }
      for (const team of TEAM_IDS) {
        cumulativeScoresByTeam[team] = state.scoresByTeam[team] + roundScoreByTeam[team]
      }
      const roundSummary: RoundSummaryData = {
        meldPointsByTeam: meldPoints,
        trickPointsByTeam: action.result.trickPointsByTeam,
        roundScoreByTeam,
        bidWinnerTeam,
        bid,
        cumulativeScoresByTeam,
        teamNames: state.teamNames,
      }
      return {
        ...state,
        phase: 'round-summary',
        roundSummary,
        scoresByTeam: cumulativeScoresByTeam,
        trickPlayCheckpoint: null,
      }
    }
    case 'CONTINUE_ROUND': {
      if (state.phase !== 'round-summary' || state.roundSummary === null) return state
      const winner = checkGameOutcome(state.scoresByTeam, state.roundSummary.bidWinnerTeam)
      if (winner !== null) {
        return {
          ...state,
          phase: 'game-over',
          gameOverData: { winningTeam: winner, finalScoresByTeam: state.scoresByTeam, teamNames: state.teamNames },
        }
      }
      return {
        ...state,
        phase: 'dealing',
        dealer: ((state.dealer + 1) % 4) as PlayerIndex,
        auctionResult: null,
        roundSummary: null,
      }
    }
    case 'NEW_GAME': {
      return {
        ...state,
        phase: 'dealing',
        dealer: action.dealer,
        scoresByTeam: { 0: 0, 1: 0 },
        auctionResult: null,
        roundSummary: null,
        gameOverData: null,
        trickPlayCheckpoint: null,
        // Fresh names per new game (#73) — a brand new game, not a resume,
        // so opponents/teams should be redrawn rather than carried over.
        seatNames: randomSeatNames(),
        teamNames: randomTeamNames(),
      }
    }
    case 'TRICK_CHECKPOINT': {
      if (state.phase !== 'trick-play') return state
      return { ...state, trickPlayCheckpoint: action.snapshot }
    }
    case 'LOAD_SAVE': {
      return action.state
    }
    default:
      return state
  }
}

// Trick-play state machine backing TrickPlayFlow.tsx (#35). Split into its
// own module (rather than living in TrickPlayFlow.tsx) so the component
// file only exports the component — oxlint's react/only-export-components
// rule flags mixed component+logic exports since it breaks fast refresh
// (same reason auctionReducer.ts is split out from AuctionFlow.tsx).
//
// Mirrors round.ts's playTrickTakingPhase loop (frozen reference for the
// rules: Trick.legalMoves/winner/points, teamOf, the 12th-trick bonus) but
// broken into individual PLAY_CARD/CLEAR_TRICK actions instead of running
// all 12 tricks synchronously in one call — the UI needs to pause after
// each AI play (a brief delay, #35) and after each completed trick (so the
// human can see who won before it's cleared), which a single blocking
// function can't do. playTrickTakingPhase itself stays the source of truth
// for headless/non-UI callers; this reducer reimplements the same
// per-trick resolution one play at a time.

import type { Card, Suit } from '../engine/card'
import { findClaim, partnerOf, teamOf, type ClaimResult, type Hands, type TeamId } from '../engine/round'
import { type PlayerIndex, Trick, type TrickPlay } from '../engine/trick'
import type { ClaimSummary, TrickPlayLogEntry } from './trickPlayTypes'

const TRICK_COUNT = 12
const LAST_TRICK_BONUS = 10 // team that wins the 12th trick gets +10, matches round.ts

export type TrickPlayPhase = 'playing' | 'trick-complete' | 'complete'

export interface TrickPlayState {
  readonly hands: Hands
  readonly trumpSuit: Suit
  readonly bidWinner: PlayerIndex
  readonly seatNames: Record<PlayerIndex, string>
  /** 0-indexed trick counter (0..11), matching round.ts's TRICK_COUNT loop. */
  readonly trickNumber: number
  /** Leader of the *current* trick (the previous trick's winner, or the bid winner for trick 0). */
  readonly leader: PlayerIndex
  /** Whose turn it is to play next, within the current trick. */
  readonly turn: PlayerIndex
  /** Plays made so far in the current trick, in play order (0-4 entries). */
  readonly currentTrick: readonly TrickPlay[]
  /** Winning player of each completed trick, in order. */
  readonly trickWinners: readonly PlayerIndex[]
  readonly trickPointsByTeam: Record<TeamId, number>
  readonly phase: TrickPlayPhase
  readonly log: readonly TrickPlayLogEntry[]
  /** True when the human has conceded the hand (#83). */
  readonly conceded: boolean
  /** Set when the hand ended on "the rest are mine" (#208). The message the UI
   *  shows, and the flag that says the remaining tricks were awarded rather
   *  than played. */
  readonly claim: ClaimSummary | null
}

export type TrickPlayAction =
  | { readonly type: 'PLAY_CARD'; readonly player: PlayerIndex; readonly card: Card }
  | { readonly type: 'CLEAR_TRICK' }
  | { readonly type: 'CONCEDE' }

export function initTrickPlayState(
  hands: Hands,
  trumpSuit: Suit,
  bidWinner: PlayerIndex,
  seatNames: Record<PlayerIndex, string>,
): TrickPlayState {
  return {
    hands,
    trumpSuit,
    bidWinner,
    seatNames,
    trickNumber: 0,
    leader: bidWinner,
    turn: bidWinner,
    currentTrick: [],
    trickWinners: [],
    trickPointsByTeam: { 0: 0, 1: 0 },
    phase: 'playing',
    log: [],
    conceded: false,
    claim: null,
  }
}

/**
 * Applies "the rest are mine" (#208) if the position allows it, else returns the
 * state unchanged.
 *
 * Called wherever a seat is about to lead with a clean table — after a trick is
 * cleared, and once at the start of the hand — because `findClaim`'s guarantee
 * is about a clean lead and says nothing mid-trick.
 *
 * The awarded points are added to the running total exactly as a played-out
 * trick would add them, so nothing downstream needs to know this happened:
 * `scoreRound` sees the same trick points either way. That is the whole design
 * constraint, and `round.test.ts` pins it against full play-out on random deals.
 */
export function applyClaimIfAvailable(state: TrickPlayState): TrickPlayState {
  if (state.phase !== 'playing' || state.currentTrick.length > 0) return state
  const result: ClaimResult | null = findClaim(state.hands, state.trumpSuit, state.turn)
  if (result === null) return state

  const team = teamOf(result.claimer)
  const claim: ClaimSummary = {
    player: result.claimer,
    name: state.seatNames[result.claimer],
    cards: result.cards,
    points: result.trickPoints,
    tricks: result.tricks,
  }
  return {
    ...state,
    phase: 'complete',
    claim,
    currentTrick: [],
    trickPointsByTeam: {
      ...state.trickPointsByTeam,
      [team]: state.trickPointsByTeam[team] + result.trickPoints,
    },
    // The claimer would have won every skipped trick, so the record says so
    // rather than leaving the hand looking like it stopped early.
    trickWinners: [
      ...state.trickWinners,
      ...Array.from({ length: result.tricks }, () => result.claimer),
    ],
    log: [
      ...state.log,
      {
        kind: 'claim',
        player: result.claimer,
        name: state.seatNames[result.claimer],
        cards: result.cards,
        points: result.trickPoints,
        tricks: result.tricks,
      },
    ],
  }
}

/** Rebuilds a live Trick instance from plain TrickPlay data, so legal-move
 * filtering and winner/points resolution can reuse trick.ts's rules
 * instead of duplicating them here. Cheap enough to call on every render —
 * at most 3 plays to replay before the 4th is added. */
export function buildTrick(trumpSuit: Suit, plays: readonly TrickPlay[]): Trick {
  const trick = new Trick(trumpSuit)
  for (const p of plays) trick.play(p.player, p.card)
  return trick
}

/** Teammates (self + partner) for `player`, per round.ts's fixed seating —
 * the shape chooseFollowCard (tracker.ts) wants for its "is my team
 * already winning this trick" check. */
export function teammatesOf(player: PlayerIndex): PlayerIndex[] {
  return [player, partnerOf(player)]
}

export function trickPlayReducer(state: TrickPlayState, action: TrickPlayAction): TrickPlayState {
  switch (action.type) {
    case 'PLAY_CARD': {
      if (state.phase !== 'playing' || action.player !== state.turn) return state
      const { player, card } = action
      const hands = state.hands.map((h, i) => (i === player ? h.filter((c) => c !== card) : h)) as Hands
      const currentTrick: TrickPlay[] = [...state.currentTrick, { player, card }]
      const log: TrickPlayLogEntry[] = [
        ...state.log,
        {
          kind: 'card-play',
          player,
          name: state.seatNames[player],
          card,
          isLead: state.currentTrick.length === 0,
        },
      ]

      if (currentTrick.length < 4) {
        return { ...state, hands, currentTrick, log, turn: ((player + 1) % 4) as PlayerIndex }
      }

      // 4th card of the trick — resolve the winner and settle (pause on
      // 'trick-complete'; the caller clears it via CLEAR_TRICK once the
      // human has had a moment to see who won).
      const trick = buildTrick(state.trumpSuit, currentTrick)
      const winner = trick.winner()
      const isLastTrick = state.trickNumber === TRICK_COUNT - 1
      const points = trick.points() + (isLastTrick ? LAST_TRICK_BONUS : 0)
      const winningTeam = teamOf(winner)
      const trickPointsByTeam = {
        ...state.trickPointsByTeam,
        [winningTeam]: state.trickPointsByTeam[winningTeam] + points,
      }
      const trickWinners = [...state.trickWinners, winner]
      const finalLog: TrickPlayLogEntry[] = [
        ...log,
        { kind: 'trick-won', player: winner, name: state.seatNames[winner], points, trickNumber: state.trickNumber },
      ]

      return {
        ...state,
        hands,
        currentTrick,
        trickPointsByTeam,
        trickWinners,
        log: finalLog,
        phase: 'trick-complete',
      }
    }
    case 'CLEAR_TRICK': {
      if (state.phase !== 'trick-complete') return state
      const winner = state.trickWinners[state.trickWinners.length - 1]
      const nextTrickNumber = state.trickNumber + 1
      if (nextTrickNumber >= TRICK_COUNT) {
        return { ...state, phase: 'complete', currentTrick: [] }
      }
      // The winner of the trick just settled leads the next one — and is the
      // seat a claim would be made by, so the check goes here (#208).
      return applyClaimIfAvailable({
        ...state,
        phase: 'playing',
        currentTrick: [],
        leader: winner,
        turn: winner,
        trickNumber: nextTrickNumber,
      })
    }
    case 'CONCEDE': {
      if (state.phase !== 'playing') return state
      return { ...state, phase: 'complete', conceded: true }
    }
    default:
      return state
  }
}

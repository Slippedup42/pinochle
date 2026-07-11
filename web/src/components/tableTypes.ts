// Shared prop shapes for the table layout scaffold (#33). Built from the
// real engine types (card.ts/trick.ts/round.ts) rather than ad-hoc UI
// types, so a later issue (bid/pass UI, trick-play UI, a live game loop)
// can hand this component tree actual Round/Game state without changing
// these shapes — only where the values come from changes.

import type { Card, Suit } from '../engine/card'
import type { TeamId } from '../engine/round'
import type { PlayerIndex, TrickPlay } from '../engine/trick'

/** One seat at the table. `hand` is the real per-player Card list; seats
 * other than `TableState['humanPlayer']` only ever render `hand.length`
 * (face-down fan / count), never the cards themselves, since a real
 * player's hand is hidden information. */
export interface SeatState {
  readonly player: PlayerIndex
  readonly name: string
  readonly hand: readonly Card[]
}

export interface TableState {
  readonly seats: readonly [SeatState, SeatState, SeatState, SeatState]
  readonly humanPlayer: PlayerIndex
  /** Cards played so far in the current trick, in play order. */
  readonly trick: readonly TrickPlay[]
  readonly trumpSuit: Suit
  readonly currentBid: number
  readonly bidWinner: PlayerIndex
  readonly scoresByTeam: Record<TeamId, number>
}

/** Table position, independent of PlayerIndex — the human seat is always
 * `'bottom'`, with the other three seats rotated clockwise around it so
 * partners (per round.ts's teamOf, players 2 apart) land opposite each
 * other regardless of which PlayerIndex is the human. */
export type SeatPosition = 'bottom' | 'left' | 'top' | 'right'

const POSITIONS_CLOCKWISE_FROM_HUMAN: readonly SeatPosition[] = [
  'bottom',
  'left',
  'top',
  'right',
]

export function seatPosition(player: PlayerIndex, humanPlayer: PlayerIndex): SeatPosition {
  const offset = (player - humanPlayer + 4) % 4
  return POSITIONS_CLOCKWISE_FROM_HUMAN[offset]
}

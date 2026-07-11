// Shared data shapes for the trick-play flow (#35). Built from the real
// engine types (card.ts/round.ts/trick.ts) rather than ad-hoc UI types,
// same approach auctionTypes.ts took for the auction/pass flow (#34) — so
// a live Round orchestrator (#47, once it lands) can drive this UI and
// consume its result without the component/reducer shapes changing.

import type { Card } from '../engine/card'
import type { TeamId } from '../engine/round'
import type { PlayerIndex } from '../engine/trick'
import { SUIT_NAME } from './auctionTypes'

/**
 * One entry in the trick-play event log. Every card played — human and AI
 * alike — and every completed trick's outcome gets an entry, so a human
 * player can follow the hand as it's played instead of just watching
 * seats/hands change silently underneath them. Same principle
 * auctionTypes.ts's AuctionLogEntry follows for the auction/pass phase.
 */
export type TrickPlayLogEntry =
  | {
      readonly kind: 'card-play'
      readonly player: PlayerIndex
      readonly name: string
      readonly card: Card
      readonly isLead: boolean
    }
  | {
      readonly kind: 'trick-won'
      readonly player: PlayerIndex
      readonly name: string
      readonly points: number
      readonly trickNumber: number
    }

/** Renders one log entry as a single line of human-readable text. Pure and
 * exported on its own so TrickLog's formatting logic is unit-testable
 * without mounting a component (mirrors formatAuctionLogEntry). */
export function formatTrickPlayLogEntry(entry: TrickPlayLogEntry): string {
  switch (entry.kind) {
    case 'card-play':
      return `${entry.name} ${entry.isLead ? 'led' : 'played'} the ${entry.card.rank} of ${SUIT_NAME[entry.card.suit]}`
    case 'trick-won':
      return `${entry.name} won the trick (${entry.points} point${entry.points === 1 ? '' : 's'})`
  }
}

/**
 * Everything a live Round orchestrator (#47) needs once all 12 tricks have
 * been played: the trick-point contribution each team makes to
 * `scoreRound` (round.ts) and the winner of each trick, in order. Mirrors
 * round.ts's `TrickTakingResult` exactly — same data, just produced one
 * play at a time (with UI pauses in between) instead of by a single
 * blocking `playTrickTakingPhase` call.
 */
export interface TrickPlayResult {
  readonly trickPointsByTeam: Record<TeamId, number>
  readonly trickWinners: readonly PlayerIndex[]
}

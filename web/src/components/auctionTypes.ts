// Shared data shapes for the bid/pass auction flow (#34). Built from the
// real engine types (bidding.ts/round.ts/passing.ts) rather than ad-hoc UI
// types, same approach tableTypes.ts took for the table scaffold (#33) and
// scoreTypes.ts took for the round-summary/game-over screens (#36): plain
// data in, so a live Round orchestrator (once #17-style bidding/passing
// lands in the engine, or issue #29's chooseBid/chooseTrump wrapper ships)
// can drive this UI without the components themselves changing.

import type { Card, Suit } from '../engine/card'
import type { TeamId } from '../engine/round'
import type { PlayerIndex } from '../engine/trick'

/**
 * One entry in the auction/pass event log. AI decisions are never silent —
 * every bid, pass, forced contract, trump call, and card exchange gets an
 * entry here so a human player can follow what happened without having to
 * infer it from hand/table state changing underneath them. Pass entries
 * deliberately omit which cards moved (`card-pass` only carries a count):
 * passed cards are private between the sender and receiver, same as a real
 * hand-off across the table, and the recipient's own hand already reflects
 * the result when it's the human on one end of the exchange.
 */
export type AuctionLogEntry =
  | { readonly kind: 'bid'; readonly player: PlayerIndex; readonly name: string; readonly amount: number }
  | { readonly kind: 'pass-bid'; readonly player: PlayerIndex; readonly name: string }
  | { readonly kind: 'forced-bid'; readonly player: PlayerIndex; readonly name: string; readonly amount: number }
  | { readonly kind: 'trump'; readonly player: PlayerIndex; readonly name: string; readonly suit: Suit }
  | {
      readonly kind: 'card-pass'
      readonly fromPlayer: PlayerIndex
      readonly fromName: string
      readonly toPlayer: PlayerIndex
      readonly toName: string
      readonly count: number
    }

export const SUIT_NAME: Record<Suit, string> = {
  S: 'Spades',
  H: 'Hearts',
  D: 'Diamonds',
  C: 'Clubs',
}

/** Renders one log entry as a single line of human-readable text. Pure and
 * exported on its own so AuctionLog's formatting logic is unit-testable
 * without mounting a component. */
export function formatAuctionLogEntry(entry: AuctionLogEntry): string {
  switch (entry.kind) {
    case 'bid':
      return `${entry.name} bid ${entry.amount}`
    case 'pass-bid':
      return `${entry.name} passed`
    case 'forced-bid':
      return `${entry.name} is stuck with the forced bid of ${entry.amount} (everyone passed)`
    case 'trump':
      return `${entry.name} named ${SUIT_NAME[entry.suit]} trump`
    case 'card-pass':
      return `${entry.fromName} passed ${entry.count} card${entry.count === 1 ? '' : 's'} to ${entry.toName}`
  }
}

/** Everything a live Round orchestrator needs once the auction and pass
 * phases finish: the post-pass hands, the agreed contract, and who holds
 * it — the inputs `playTrickTakingPhase` (round.ts) expects. */
export interface AuctionResult {
  readonly hands: readonly [readonly Card[], readonly Card[], readonly Card[], readonly Card[]]
  readonly trumpSuit: Suit
  readonly bidWinner: PlayerIndex
  readonly bid: number
}

/** Fixed team pairing, matches round.ts's `teamOf`. */
export function partnerOf(player: PlayerIndex): PlayerIndex {
  return ((player + 2) % 4) as PlayerIndex
}

export type ScoresByTeam = Record<TeamId, number>

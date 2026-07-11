// Static demo state for the auction flow UI (#34). Built from the real
// engine types (Deck/Card) rather than hand-rolled fixtures, same approach
// tableState.ts took for the table scaffold (#33) — this file is what a
// later issue (a live game loop) needs to replace once dealing/rotation is
// driven by an actual Game, not AuctionFlow's props/callers.

import { Deck } from '../engine/card'
import type { Hands, TeamId } from '../engine/round'
import type { PlayerIndex } from '../engine/trick'

export const SEAT_NAMES: Record<PlayerIndex, string> = {
  0: 'You',
  1: 'West',
  2: 'Partner',
  3: 'East',
}

export const HUMAN_PLAYER: PlayerIndex = 0
export const DEALER: PlayerIndex = 3

export function buildMockAuctionHands(): Hands {
  const deck = new Deck()
  deck.shuffle()
  return deck.deal()
}

export function buildMockAuctionScores(): Record<TeamId, number> {
  return { 0: 180, 1: 220 }
}

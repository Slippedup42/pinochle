// Misdeal / reshuffle house rule — pinochle_rules.md's "Misdeal / Reshuffle
// (House Rule)" section. Previously only implemented in the Python
// reference's human-interactive path (human_play.py's
// InteractiveRound._check_misdeal); the TS port makes it a real rule for
// every game (human and AI-only alike) from the start, per
// pinochle_rules.md's Implementation Notes.
//
// Deliberately just the pure "does this hand qualify" check. The actual
// "check each seat in order, ask a human, auto-take for AI, redeal and
// recheck from scratch on any reshuffle" loop is UI-layer orchestration
// state (gameFlowReducer.ts) — same split bidding.ts/passing.ts keep
// between pure hand valuation and the auction-loop state driving it.

import type { Card } from './card'

// Any player holding this many nines (out of the 2 in the deck per suit,
// so up to 8 total) may request a reshuffle at what would be their first
// bid turn.
export const MISDEAL_NINE_THRESHOLD = 5

export function nineCount(hand: readonly Card[]): number {
  return hand.reduce((count, c) => count + (c.rank === '9' ? 1 : 0), 0)
}

/** True if this hand qualifies for the misdeal/reshuffle request. */
export function isMisdealEligible(hand: readonly Card[]): boolean {
  return nineCount(hand) >= MISDEAL_NINE_THRESHOLD
}

// Shared prop shapes for the table layout scaffold (#33). Built from the
// real engine types (card.ts/trick.ts/round.ts) rather than ad-hoc UI
// types, so a later issue (bid/pass UI, trick-play UI, a live game loop)
// can hand this component tree actual Round/Game state without changing
// these shapes — only where the values come from changes.

import type { Card, Suit } from '../engine/card'
import type { TeamId } from '../engine/round'
import type { PlayerIndex, TrickPlay } from '../engine/trick'

/**
 * What a seat has said in the auction, as data rather than as a formatted
 * string (#191).
 *
 * It used to be `statusText?: string` — "Pass", "(300)", "(Waiting)" — rendered
 * as one dim line under the player's name. Paul's dad asked for the auction to
 * read like trick play does: the call shown big, at the seat's own place on the
 * board. A pre-formatted string cannot do that, because the three cases want
 * genuinely different type: a bid is a number and should dominate, a pass is a
 * word, and waiting is the absence of news and should recede. Keeping the kind
 * lets `TrickArea` make that call at the point of rendering.
 *
 * `'turn'` is the seat currently being asked, which the old string had no case
 * for at all — it rendered nothing, so the one seat you most want to watch was
 * the one the board said least about.
 */
export type SeatCall =
  | { readonly kind: 'bid'; readonly amount: number }
  | { readonly kind: 'pass' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'turn' }

/** One seat at the table. `hand` is the real per-player Card list; seats
 * other than `TableState['humanPlayer']` only ever render `hand.length`
 * (face-down fan / count), never the cards themselves, since a real
 * player's hand is hidden information. */
export interface SeatState {
  readonly player: PlayerIndex
  readonly name: string
  readonly hand: readonly Card[]
  /** Auction-phase call, rendered big in the trick circle by `TrickArea`.
   * Omitted outside the auction. */
  readonly call?: SeatCall
}

export interface TableState {
  readonly seats: readonly [SeatState, SeatState, SeatState, SeatState]
  readonly humanPlayer: PlayerIndex
  /** Cards played so far in the current trick, in play order. */
  readonly trick: readonly TrickPlay[]
  /** null before the auction (#34) has settled on a trump suit. */
  readonly trumpSuit: Suit | null
  readonly currentBid: number
  /** null before the auction (#34) has a winner. */
  readonly bidWinner: PlayerIndex | null
  readonly scoresByTeam: Record<TeamId, number>
  /** Randomized per-game team display names (#73), replacing the old
   * static "Team A"/"Team B" labels — threaded down to Scoreboard. */
  readonly teamNames: Record<TeamId, string>
  /** Trick-play (#35): legal cards for the human's turn to play, and the
   * callback to fire when one of them is clicked/tapped. Omitted outside
   * the human's trick-play turn (auction phases, AI turns, mid-settle) —
   * the human's hand then renders as plain, non-interactive cards, same as
   * during the auction. */
  readonly humanPlayable?: { readonly legalCards: readonly Card[]; readonly onPlay: (card: Card) => void }
  /** Trick-play (#35): the just-completed trick's winner, highlighted in
   * TrickArea while it settles before being cleared for the next trick.
   * null/undefined outside that settle pause. */
  readonly trickWinner?: PlayerIndex | null
  /** Which seat is the dealer (#76) — shown during the auction phase so the
   * human knows who has the last bid. Optional because some callers (e.g.
   * TrickPlayFlow) don't track it. */
  readonly dealer?: PlayerIndex
  /** Meld points of the bidding team, shown in the header after meld
   * declaration. Only meaningful during trick-play; omitted before that. */
  readonly meldPoints?: number
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

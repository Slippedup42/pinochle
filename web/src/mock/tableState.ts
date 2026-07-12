// Static demo state for the table layout scaffold (#33). Built from the
// real engine types (Deck/Card/Trick) rather than hand-rolled fixtures,
// so this file — and this file alone — is what a later issue needs to
// replace with a live Round/Game once bidding/passing/trick-play (#17
// and friends) actually drive the table; Table/Seat/TrickArea/Scoreboard
// don't need to change.

import { Deck, Suit } from '../engine/card'
import type { TableState } from '../components/tableTypes'
import { Trick } from '../engine/trick'
import type { PlayerIndex } from '../engine/trick'

const SEAT_NAMES: Record<PlayerIndex, string> = {
  0: 'You',
  1: 'West',
  2: 'Partner',
  3: 'East',
}

const HUMAN_PLAYER: PlayerIndex = 0
const BID_WINNER: PlayerIndex = 0
const TRUMP_SUIT: Suit = Suit.Hearts
const CURRENT_BID = 340

export function buildMockTableState(): TableState {
  const deck = new Deck()
  deck.shuffle()
  const hands = deck.deal()

  // Show a trick already in progress: the two seats after the human have
  // led and followed, so the center area and the remaining hand sizes
  // stay consistent with each other.
  const trick = new Trick(TRUMP_SUIT)
  const leadPlayer: PlayerIndex = 2
  const secondPlayer: PlayerIndex = 3
  const leadCard = hands[leadPlayer].pop()
  const secondCard = hands[secondPlayer].pop()
  if (leadCard) trick.play(leadPlayer, leadCard)
  if (secondCard) trick.play(secondPlayer, secondCard)

  const seats: TableState['seats'] = [
    { player: 0, name: SEAT_NAMES[0], hand: hands[0] },
    { player: 1, name: SEAT_NAMES[1], hand: hands[1] },
    { player: 2, name: SEAT_NAMES[2], hand: hands[2] },
    { player: 3, name: SEAT_NAMES[3], hand: hands[3] },
  ]

  return {
    seats,
    humanPlayer: HUMAN_PLAYER,
    trick: trick.plays,
    trumpSuit: TRUMP_SUIT,
    currentBid: CURRENT_BID,
    bidWinner: BID_WINNER,
    scoresByTeam: { 0: 180, 1: 220 },
    teamNames: { 0: 'Team A', 1: 'Team B' },
  }
}

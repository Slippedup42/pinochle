// Round — trick-taking phase and round-level (contract) scoring. Ported
// from pinochle_engine.py's Round._trick_taking_loop / Round._score_round
// (frozen Python reference).
//
// Bidding and the 3-card pass (#17) aren't reimplemented here — this
// module picks up *after* trump is set and hands are finalized (post
// pass), taking the bid winner and the agreed contract as given inputs.
// A future Round orchestrator (once #17 lands) is expected to run, in
// order: deal -> bidding (#17) -> passing (#17) -> scoreMelds (melds.ts,
// per player) -> playTrickTakingPhase -> scoreRound -> feed the result
// into game.ts's checkGameOutcome. Using PlayerIndex/TeamId from this
// module and trick.ts keeps that future glue code consistent with
// however bidding/passing chooses to represent players/hands.

import type { Card, Suit } from './card'
import { type PlayerIndex, Trick } from './trick'

export type TeamId = 0 | 1

/** Fixed seating per pinochle_rules.md: Player 0 & 2 = Team A (0), Player 1 & 3 = Team B (1). */
export function teamOf(player: PlayerIndex): TeamId {
  return (player % 2) as TeamId
}

export type Hands = [Card[], Card[], Card[], Card[]]

/**
 * Picks which legal card `player` plays. `trick` gives access to
 * `trumpSuit`, `leadSuit`, and the plays made so far this trick.
 * Left fully generic on purpose — real strategy (Proficient-tier AI,
 * or human input) is out of scope for this port; this only enforces
 * legality and resolves the outcome.
 */
export type ChooseCardFn = (
  player: PlayerIndex,
  hand: readonly Card[],
  legalMoves: readonly Card[],
  trick: Trick,
) => Card

export interface TrickTakingResult {
  trickPointsByTeam: Record<TeamId, number>
  /** Winning player of each of the 12 tricks, in order (for UI/debugging/replay). */
  trickWinners: PlayerIndex[]
}

const TRICK_COUNT = 12
const LAST_TRICK_BONUS = 10 // team that wins the 12th trick gets +10

/**
 * Plays all 12 tricks of a round. `hands` are cloned internally (not
 * mutated in place), so the caller's arrays are safe to reuse/inspect
 * afterward. The contract winner (`bidWinner`) leads the first trick;
 * each subsequent trick is led by the previous trick's winner, per
 * pinochle_rules.md Phase 4.
 */
export function playTrickTakingPhase(
  hands: Readonly<Hands>,
  trumpSuit: Suit,
  bidWinner: PlayerIndex,
  chooseCard: ChooseCardFn,
): TrickTakingResult {
  const workingHands = hands.map((h) => [...h]) as Hands
  const trickPointsByTeam: Record<TeamId, number> = { 0: 0, 1: 0 }
  const trickWinners: PlayerIndex[] = []

  let leader = bidWinner
  for (let trickNum = 0; trickNum < TRICK_COUNT; trickNum++) {
    const trick = new Trick(trumpSuit)
    let player = leader
    for (let seat = 0; seat < 4; seat++) {
      const hand = workingHands[player]
      const legal = trick.legalMoves(hand)
      const card = chooseCard(player, hand, legal, trick)
      const idx = hand.findIndex((c) => c.equals(card))
      if (idx === -1) {
        throw new Error(
          `chooseCard returned a card not in player ${player}'s hand: ${card.toString()}`,
        )
      }
      hand.splice(idx, 1)
      trick.play(player, card)
      player = ((player + 1) % 4) as PlayerIndex
    }

    const winner = trick.winner()
    let points = trick.points()
    if (trickNum === TRICK_COUNT - 1) points += LAST_TRICK_BONUS
    trickPointsByTeam[teamOf(winner)] += points
    trickWinners.push(winner)
    leader = winner
  }

  return { trickPointsByTeam, trickWinners }
}

export interface RoundScoreInput {
  meldPointsByTeam: Record<TeamId, number>
  trickPointsByTeam: Record<TeamId, number>
  bidWinnerTeam: TeamId
  bid: number
}

/**
 * Contract check, per pinochle_rules.md Phase 5: if the bidding team's
 * meld + trick total is less than their bid, they score -bid for the
 * round ("going set"). The defending team always scores their own
 * meld + trick points, regardless of what happens to the bidding team.
 */
export function scoreRound(input: RoundScoreInput): Record<TeamId, number> {
  const { meldPointsByTeam, trickPointsByTeam, bidWinnerTeam, bid } = input
  const scores: Record<TeamId, number> = { 0: 0, 1: 0 }
  for (const team of [0, 1] as const) {
    const total = meldPointsByTeam[team] + trickPointsByTeam[team]
    scores[team] = team === bidWinnerTeam && total < bid ? -bid : total
  }
  return scores
}

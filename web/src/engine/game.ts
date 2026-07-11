// Game — cumulative team scores and the +-1000 win/loss thresholds.
// Ported from pinochle_engine.py's Game class (frozen Python reference).
//
// Deliberately scoped to just the threshold check, not a full game loop:
// running an actual multi-round game needs Round's bidding/pass phases
// (#17) to exist first. A future Game orchestrator adds each round's
// scoreRound() result (round.ts) onto each team's running total, then
// calls checkGameOutcome() to see whether the game just ended.

import { GAME_LOSE_SCORE, GAME_WIN_SCORE } from './card'
import type { TeamId } from './round'

const TEAM_IDS: readonly TeamId[] = [0, 1]

/**
 * Checks the win/loss thresholds after a round's scores have already
 * been added to each team's cumulative total. Returns the winning team,
 * or null if the game continues. Per pinochle_rules.md "Game Win / Loss":
 *
 *   - A team's cumulative score at or below -1000 ends the game
 *     immediately; the OTHER team wins, regardless of that team's score.
 *   - Otherwise, if either team has reached +1000, the bidding team wins
 *     the tie if both crossed it in the same round; else whichever team
 *     crossed it wins.
 */
export function checkGameOutcome(
  cumulativeScores: Record<TeamId, number>,
  bidWinnerTeam: TeamId,
): TeamId | null {
  const busted = TEAM_IDS.filter((t) => cumulativeScores[t] <= GAME_LOSE_SCORE)
  if (busted.length > 0) {
    return TEAM_IDS.find((t) => !busted.includes(t)) ?? null
  }

  const over = TEAM_IDS.filter((t) => cumulativeScores[t] >= GAME_WIN_SCORE)
  if (over.length > 0) {
    return over.includes(bidWinnerTeam) ? bidWinnerTeam : over[0]
  }

  return null
}

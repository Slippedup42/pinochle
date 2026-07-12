// Shared prop shapes for the round-summary and game-over screens (#36).
// Built from the real engine types (round.ts's TeamId/scoreRound,
// game.ts's checkGameOutcome) rather than ad-hoc UI types, so a later
// issue wiring a live Round/Game loop into these screens only needs to
// supply these shapes — the components themselves don't change. Mirrors
// the approach tableTypes.ts took for the table layout scaffold (#33).

import type { TeamId } from '../engine/round'

/** Fallback team display names (#73) for callers that don't have live
 * per-game team names yet — e.g. AuctionFlow/TrickPlayFlow's `teamNames`
 * prop defaults to this when omitted (component tests that predate #73 and
 * don't care about team-name text). GameFlow.tsx always supplies real,
 * randomized `GameFlowState.teamNames` instead, so this default is never
 * seen in an actual game. */
export const DEFAULT_TEAM_NAMES: Record<TeamId, string> = {
  0: 'Team A',
  1: 'Team B',
}

/**
 * Everything the round-summary screen needs to render one just-completed
 * round: the meld/trick breakdown that fed `scoreRound()`, that function's
 * net-points-per-team output, and each team's cumulative total afterward
 * (the "running score" line). `bid`/`bidWinnerTeam` are included so the
 * screen can say whether the bidding team made or went set on their
 * contract, per round.ts's scoreRound rule (net score is -bid when set).
 */
export interface RoundSummaryData {
  readonly meldPointsByTeam: Record<TeamId, number>
  readonly trickPointsByTeam: Record<TeamId, number>
  /** scoreRound()'s output: net points added to each team's cumulative
   * total this round (negative for the bidding team if they went set). */
  readonly roundScoreByTeam: Record<TeamId, number>
  readonly bidWinnerTeam: TeamId
  readonly bid: number
  /** Cumulative totals after this round's score has been added. */
  readonly cumulativeScoresByTeam: Record<TeamId, number>
  /** Randomized per-game team display names (#73), from
   * GameFlowState.teamNames — replaces the old static "Team A"/"Team B"
   * labels. */
  readonly teamNames: Record<TeamId, string>
}

/** Everything the win/loss screen needs once `checkGameOutcome` (game.ts)
 * returns a non-null winner. */
export interface GameOverData {
  readonly winningTeam: TeamId
  readonly finalScoresByTeam: Record<TeamId, number>
  /** Randomized per-game team display names (#73), from
   * GameFlowState.teamNames — replaces the old static "Team A"/"Team B"
   * labels. */
  readonly teamNames: Record<TeamId, string>
}

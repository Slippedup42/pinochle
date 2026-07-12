// Static demo data for the round-summary and game-over screens (#36).
// Built with the same shapes `scoreRound`/`checkGameOutcome` (engine/
// round.ts, engine/game.ts) actually produce, so this file — and this
// file alone — is what a later issue needs to replace once a live
// round/game loop (bid/pass/trick-play UI, separate issues) drives these
// screens for real. RoundSummary/GameOverScreen don't need to change.

import type { GameOverData, RoundSummaryData } from '../components/scoreTypes'

const BID_WINNER_TEAM = 0
const BID = 340

export function buildMockRoundSummary(): RoundSummaryData {
  const meldPointsByTeam = { 0: 60, 1: 24 }
  const trickPointsByTeam = { 0: 130, 1: 120 }
  const bidTeamTotal = meldPointsByTeam[BID_WINNER_TEAM] + trickPointsByTeam[BID_WINNER_TEAM]
  const roundScoreByTeam = {
    0: bidTeamTotal < BID ? -BID : bidTeamTotal,
    1: meldPointsByTeam[1] + trickPointsByTeam[1],
  }

  return {
    meldPointsByTeam,
    trickPointsByTeam,
    roundScoreByTeam,
    bidWinnerTeam: BID_WINNER_TEAM,
    bid: BID,
    cumulativeScoresByTeam: {
      0: 420 + roundScoreByTeam[0],
      1: 380 + roundScoreByTeam[1],
    },
    teamNames: { 0: 'Team A', 1: 'Team B' },
  }
}

export function buildMockGameOver(): GameOverData {
  return {
    winningTeam: 0,
    finalScoresByTeam: { 0: 1040, 1: 760 },
    teamNames: { 0: 'Team A', 1: 'Team B' },
  }
}

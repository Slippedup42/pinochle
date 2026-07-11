import type { TeamId } from '../engine/round'
import { TEAM_NAMES, type GameOverData } from './scoreTypes'

export interface GameOverScreenProps {
  data: GameOverData
  onNewGame: () => void
}

const TEAM_IDS: readonly TeamId[] = [0, 1]

/**
 * Final win/loss overlay (#36), shown once a round's cumulative scores
 * cross +-1000 and `checkGameOutcome` (game.ts) returns a winning team.
 * Purely a rendering of `GameOverData` plus a "start new game" action —
 * the caller (a future game-orchestrator issue) owns actually resetting
 * game state when `onNewGame` fires.
 */
export function GameOverScreen({ data, onNewGame }: GameOverScreenProps) {
  const { winningTeam, finalScoresByTeam } = data

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-6 text-center text-neutral-900 shadow-xl">
        <h2 className="text-2xl font-bold">{TEAM_NAMES[winningTeam]} wins!</h2>

        <dl className="mt-4 flex justify-center gap-8 text-sm">
          {TEAM_IDS.map((team) => (
            <div key={team}>
              <dt className="text-neutral-500">{TEAM_NAMES[team]}</dt>
              <dd className={`text-lg font-semibold ${team === winningTeam ? 'text-green-700' : ''}`}>
                {finalScoresByTeam[team]}
              </dd>
            </div>
          ))}
        </dl>

        <button
          type="button"
          onClick={onNewGame}
          className="mt-6 w-full rounded bg-green-800 px-4 py-2 font-semibold text-white hover:bg-green-900"
        >
          Start new game
        </button>
      </div>
    </div>
  )
}

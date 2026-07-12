import type { TeamId } from '../engine/round'
import type { RoundSummaryData } from './scoreTypes'

export interface RoundSummaryProps {
  data: RoundSummaryData
  /** Called when the player dismisses the summary to continue. Optional
   * since this screen doesn't own round-advance logic (that's the
   * trick-play/bid UI, separate issues) — omit to render without a
   * continue control. */
  onContinue?: () => void
}

const TEAM_IDS: readonly TeamId[] = [0, 1]

/**
 * End-of-round overlay (#36): meld + trick points per team for the round
 * just completed, whether the bidding team made or went set on their
 * contract, and the running game score after this round's points were
 * added. Purely a rendering of `RoundSummaryData` — the caller (a future
 * round-loop/game-orchestrator issue) decides when to show it and what
 * `onContinue` does.
 */
export function RoundSummary({ data, onContinue }: RoundSummaryProps) {
  const { meldPointsByTeam, trickPointsByTeam, roundScoreByTeam, bidWinnerTeam, bid, cumulativeScoresByTeam, teamNames } =
    data
  // scoreRound() only ever produces a negative net score for the bidding
  // team, and only when they fell short of their bid ("going set").
  const wentSet = roundScoreByTeam[bidWinnerTeam] < 0

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-6 text-neutral-900 shadow-xl">
        <h2 className="text-lg font-semibold">Round summary</h2>
        <p className="mt-1 text-sm text-neutral-600">
          {teamNames[bidWinnerTeam]} bid {bid} and{' '}
          {wentSet ? 'went set' : 'made their contract'}.
        </p>

        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="text-left text-neutral-500">
              <th className="font-normal" />
              {TEAM_IDS.map((team) => (
                <th key={team} className="pl-4 font-medium text-neutral-900">
                  {teamNames[team]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="py-1 text-neutral-500">Meld</td>
              {TEAM_IDS.map((team) => (
                <td key={team} className="pl-4">
                  {meldPointsByTeam[team]}
                </td>
              ))}
            </tr>
            <tr>
              <td className="py-1 text-neutral-500">Tricks</td>
              {TEAM_IDS.map((team) => (
                <td key={team} className="pl-4">
                  {trickPointsByTeam[team]}
                </td>
              ))}
            </tr>
            <tr className="border-t border-neutral-200 font-semibold">
              <td className="py-1 text-neutral-500 font-normal">Round score</td>
              {TEAM_IDS.map((team) => (
                <td key={team} className="pl-4">
                  {roundScoreByTeam[team]}
                </td>
              ))}
            </tr>
            <tr className="font-semibold">
              <td className="py-1 text-neutral-500 font-normal">Game score</td>
              {TEAM_IDS.map((team) => (
                <td key={team} className="pl-4">
                  {cumulativeScoresByTeam[team]}
                </td>
              ))}
            </tr>
          </tbody>
        </table>

        {onContinue && (
          <button
            type="button"
            onClick={onContinue}
            className="mt-6 w-full rounded bg-green-800 px-4 py-2 font-semibold text-white hover:bg-green-900"
          >
            Continue
          </button>
        )}
      </div>
    </div>
  )
}

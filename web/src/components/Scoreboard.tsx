import type { Suit } from '../engine/card'
import type { TeamId } from '../engine/round'
import { RED_SUITS, SUIT_GLYPH } from './suitGlyphs'

export interface ScoreboardProps {
  scoresByTeam: Record<TeamId, number>
  /** Randomized per-game team display names (#73), replacing the old
   * static "Team A"/"Team B" labels. */
  teamNames: Record<TeamId, string>
  currentBid: number
  /** undefined while the auction (#34) hasn't produced a bid winner yet. */
  bidWinnerName?: string
  /** null while the auction (#34) hasn't settled on trump yet. */
  trumpSuit: Suit | null
  /** Meld points of the bidding team, shown after meld declaration. */
  meldPoints?: number
}

/** Top strip: cumulative team scores, the standing bid, and trump. Stays
 * mounted throughout bidding/passing/trick-play so those flows (separate
 * issues) can render alongside it without needing their own scoreboard. */
export function Scoreboard({ scoresByTeam, teamNames, currentBid, bidWinnerName, trumpSuit, meldPoints }: ScoreboardProps) {
  const trumpColor = trumpSuit && RED_SUITS.includes(trumpSuit) ? 'text-red-400' : 'text-white'

  return (
    // The strip owns the top safe-area inset (#161) rather than the Table root,
    // so its own background fills the space behind the status bar instead of
    // leaving a bare band of table felt above it. Gutters are tightened from
    // gap-x-6/px-4 so the five items pack into fewer wrapped lines on a phone.
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 bg-green-950 pt-[calc(0.375rem_+_var(--safe-top))] pr-[calc(0.5rem_+_var(--safe-right))] pb-1.5 pl-[calc(0.5rem_+_var(--safe-left))] text-sm text-white shadow-md">
      <span>
        Trump:{' '}
        <span className={`text-lg font-semibold ${trumpColor}`}>
          {trumpSuit ? SUIT_GLYPH[trumpSuit] : '—'}
        </span>
      </span>
      <span>
        {teamNames[0]}: <span className="font-semibold">{scoresByTeam[0]}</span>
      </span>
      <span>
        {teamNames[1]}: <span className="font-semibold">{scoresByTeam[1]}</span>
      </span>
      <span>
        Bid: <span className="font-semibold">{currentBid || '—'}</span>
        {bidWinnerName ? ` (${bidWinnerName})` : ''}
      </span>
      {meldPoints !== undefined && (
        <span>
          Meld: <span className="font-semibold text-amber-300">{meldPoints}</span>
        </span>
      )}
    </div>
  )
}

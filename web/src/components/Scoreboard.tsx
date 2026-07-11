import type { Suit } from '../engine/card'
import type { TeamId } from '../engine/round'
import { RED_SUITS, SUIT_GLYPH } from './suitGlyphs'

export interface ScoreboardProps {
  scoresByTeam: Record<TeamId, number>
  currentBid: number
  /** undefined while the auction (#34) hasn't produced a bid winner yet. */
  bidWinnerName?: string
  /** null while the auction (#34) hasn't settled on trump yet. */
  trumpSuit: Suit | null
}

/** Top strip: cumulative team scores, the standing bid, and trump. Stays
 * mounted throughout bidding/passing/trick-play so those flows (separate
 * issues) can render alongside it without needing their own scoreboard. */
export function Scoreboard({ scoresByTeam, currentBid, bidWinnerName, trumpSuit }: ScoreboardProps) {
  const trumpColor = trumpSuit && RED_SUITS.includes(trumpSuit) ? 'text-red-400' : 'text-white'

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-1 bg-green-950 px-4 py-2 text-sm text-white shadow-md">
      <span>
        Trump:{' '}
        <span className={`text-lg font-semibold ${trumpColor}`}>
          {trumpSuit ? SUIT_GLYPH[trumpSuit] : '—'}
        </span>
      </span>
      <span>
        Team A: <span className="font-semibold">{scoresByTeam[0]}</span>
      </span>
      <span>
        Team B: <span className="font-semibold">{scoresByTeam[1]}</span>
      </span>
      <span>
        Bid: <span className="font-semibold">{currentBid || '—'}</span>
        {bidWinnerName ? ` (${bidWinnerName})` : ''}
      </span>
    </div>
  )
}

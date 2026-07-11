import { formatTrickPlayLogEntry, type TrickPlayLogEntry } from './trickPlayTypes'

export interface TrickLogProps {
  /** Oldest-first; rendered newest-first so the latest event is always visible without scrolling. */
  entries: readonly TrickPlayLogEntry[]
}

/**
 * Visible feed of trick-play events (#35) — every card played (human and
 * AI alike) and every trick's winner shows up here as it happens, so a
 * human player can follow the hand instead of just watching cards and
 * hand counts change silently underneath them. Mirrors AuctionLog's
 * layout/behavior for the auction/pass phase.
 */
export function TrickLog({ entries }: TrickLogProps) {
  if (entries.length === 0) return null

  const newestFirst = [...entries].reverse()

  return (
    <div className="pointer-events-none w-full max-w-xs">
      <ol className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-lg bg-black/60 p-3 text-xs text-white shadow-lg">
        {newestFirst.map((entry, i) => (
          <li key={newestFirst.length - i} className={i === 0 ? 'font-semibold' : 'text-white/70'}>
            {formatTrickPlayLogEntry(entry)}
          </li>
        ))}
      </ol>
    </div>
  )
}

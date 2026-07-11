import { type AuctionLogEntry, formatAuctionLogEntry } from './auctionTypes'

export interface AuctionLogProps {
  /** Oldest-first; rendered newest-first so the latest event is always visible without scrolling. */
  entries: readonly AuctionLogEntry[]
}

/**
 * Visible feed of auction/pass events (#34) — every AI bid, pass, forced
 * contract, trump call, and card exchange shows up here as it happens, so
 * a human player can follow the auction instead of just watching table
 * state change silently underneath them.
 */
export function AuctionLog({ entries }: AuctionLogProps) {
  if (entries.length === 0) return null

  const newestFirst = [...entries].reverse()

  return (
    <div className="pointer-events-none w-full max-w-xs">
      <ol className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-lg bg-black/60 p-3 text-xs text-white shadow-lg">
        {newestFirst.map((entry, i) => (
          <li key={newestFirst.length - i} className={i === 0 ? 'font-semibold' : 'text-white/70'}>
            {formatAuctionLogEntry(entry)}
          </li>
        ))}
      </ol>
    </div>
  )
}

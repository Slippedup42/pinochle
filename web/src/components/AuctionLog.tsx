import { type AuctionLogEntry, formatAuctionLogEntry } from './auctionTypes'
import type { PlayerIndex } from '../engine/trick'

export interface AuctionLogProps {
  /** Oldest-first; rendered newest-first so the latest event is always visible without scrolling. */
  entries: readonly AuctionLogEntry[]
  /** The current high bid in the auction. */
  currentBid?: number
  /** The player index of the current highest bidder. */
  bidWinner?: PlayerIndex
  /** The display name of the current highest bidder. */
  bidWinnerName?: string
  /** The display name of the dealer. */
  dealerName?: string
}

/**
 * Visible feed of auction/pass events (#34) — every AI bid, pass, forced
 * contract, trump call, and card exchange shows up here as it happens, so
 * a human player can follow the auction instead of just watching table
 * state change silently underneath them.
 */
export function AuctionLog({ entries, currentBid, bidWinner, bidWinnerName, dealerName }: AuctionLogProps) {
  const newestFirst = [...entries].reverse()

  return (
    <div className="pointer-events-none w-full max-w-xs">
      <div className="flex flex-col gap-1 rounded-lg bg-black/60 p-3 text-xs text-white shadow-lg">
        {(currentBid !== undefined || dealerName) && (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 border-b border-white/20 pb-1.5 font-semibold">
            {currentBid !== undefined && currentBid > 0 && bidWinnerName && (
              <span className="text-amber-300">High: {currentBid} ({bidWinnerName})</span>
            )}
            {currentBid !== undefined && currentBid === 0 && (
              <span className="text-white/60">No bids yet</span>
            )}
            {dealerName && <span className="text-white/50">Dealer: {dealerName}</span>}
          </div>
        )}
        {entries.length > 0 && (
          <ol className="flex max-h-44 flex-col gap-1 overflow-y-auto">
            {newestFirst.map((entry, i) => (
              <li key={newestFirst.length - i} className={i === 0 ? 'font-semibold' : 'text-white/70'}>
                {formatAuctionLogEntry(entry)}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

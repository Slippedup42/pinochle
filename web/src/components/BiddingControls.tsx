import { useState } from 'react'

export interface BiddingControlsProps {
  /** Lowest legal bid right now — `OPENING_BID` before anyone has bid,
   * `currentBid + 10` afterward (round.ts's `_bidding_loop` increment). */
  minBid: number
  /** The standing bid, for display context ("current bid: N"). Only
   * meaningful once someone has bid; 0 beforehand. */
  currentBid: number
  /** Non-binding hint from the human's own hand (bidding.ts's
   * `bestBaseBid`), shown so the bid amount isn't a guess in the dark. */
  suggestedCeiling: number
  /** Options toggle (#54): whether to show the "Your hand suggests up to
   * N" sentence at all — players who want to bid on pure judgment can turn
   * it off. Defaults to true (current/original behavior) when omitted. */
  showBaseBidHint?: boolean
  onBid: (amount: number) => void
  onPass: () => void
}

/**
 * Human bid-amount entry/raise/pass controls for the auction (#34). Pure
 * props in, `onBid`/`onPass` out — AuctionFlow owns turn order, legality,
 * and what happens next.
 */
export function BiddingControls({
  minBid,
  currentBid,
  suggestedCeiling,
  showBaseBidHint = true,
  onBid,
  onPass,
}: BiddingControlsProps) {
  const [amount, setAmount] = useState(minBid)
  const isValid = amount >= minBid && amount % 10 === 0

  return (
    <div className="w-full max-w-xs rounded-lg bg-white p-4 text-neutral-900 shadow-xl">
      <h3 className="text-sm font-semibold">Your bid</h3>
      <p className="mt-1 text-xs text-neutral-600">
        {currentBid > 0 ? `Current bid: ${currentBid}. ` : ''}
        Minimum: {minBid}.{showBaseBidHint ? ` Your hand suggests up to ${suggestedCeiling}.` : ''}
      </p>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          aria-label="Decrease bid by 10"
          onClick={() => setAmount((a) => Math.max(minBid, a - 10))}
          className="rounded bg-neutral-200 px-3 py-1 font-semibold hover:bg-neutral-300"
        >
          −
        </button>
        <input
          type="number"
          step={10}
          min={minBid}
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          aria-label="Bid amount"
          className="w-20 rounded border border-neutral-300 px-2 py-1 text-center"
        />
        <button
          type="button"
          aria-label="Increase bid by 10"
          onClick={() => setAmount((a) => a + 10)}
          className="rounded bg-neutral-200 px-3 py-1 font-semibold hover:bg-neutral-300"
        >
          +
        </button>
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={!isValid}
          onClick={() => onBid(amount)}
          className="flex-1 rounded bg-green-800 px-4 py-2 font-semibold text-white hover:bg-green-900 disabled:cursor-not-allowed disabled:bg-neutral-300"
        >
          Bid
        </button>
        <button
          type="button"
          onClick={onPass}
          className="flex-1 rounded bg-neutral-200 px-4 py-2 font-semibold text-neutral-900 hover:bg-neutral-300"
        >
          Pass
        </button>
      </div>
    </div>
  )
}

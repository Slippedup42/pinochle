// Stand-in AI bid/trump decisions for the auction flow UI (#34).
//
// Issue #29 (a stateful chooseBid/chooseTrump AI decision wrapper, mirroring
// pinochle_engine.py's Player.choose_bid/choose_trump) may land separately
// and isn't a dependency of this UI — these are deliberately simplified
// heuristics built directly on bidding.ts's valuation math (bestBaseBid,
// maxBid, OPENER_THRESHOLD) so the auction has *something* driving AI
// seats today. AuctionFlow.tsx is the only caller; once #29 ships, swap
// these two functions for the real wrapper there and this file goes away.
//
// Simplifications vs. the full Python Player.choose_bid: no dealer-
// protection opener, no "3rd bidder always opens" rule, no partner-raised-
// over-me re-raise logic. What's kept: the opener threshold, raising up to
// the score-adjusted/capped ceiling, and never outbidding your own partner
// (the one context rule that matters most for the auction not looking
// broken — two AI teammates bidding each other up).

import { bestBaseBid, maxBid, OPENER_THRESHOLD } from '../engine/bidding'
import { type Card, OPENING_BID, type Suit } from '../engine/card'
import { teamOf, type TeamId } from '../engine/round'
import type { PlayerIndex } from '../engine/trick'

const MIN_INCREMENT = 10

/**
 * Returns the amount to bid, or null to pass. `everBid`/`currentBid` follow
 * round.ts's `_bidding_loop` convention: before anyone has bid, the only
 * question is whether to open at `OPENING_BID`; afterward it's whether to
 * raise by `MIN_INCREMENT`.
 */
export function aiDecideBid(
  player: PlayerIndex,
  hand: readonly Card[],
  currentBid: number,
  everBid: boolean,
  lastBidder: PlayerIndex | null,
  scoresByTeam: Record<TeamId, number>,
): number | null {
  const myTeam = teamOf(player)
  const oppTeam = (myTeam === 0 ? 1 : 0) as TeamId
  const { trump, total } = bestBaseBid(hand, scoresByTeam[myTeam], scoresByTeam[oppTeam])
  const cap = maxBid(hand, trump)
  const ceiling = cap === null ? total : Math.min(total, cap)

  if (!everBid) {
    return ceiling >= OPENER_THRESHOLD ? OPENING_BID : null
  }

  if (lastBidder !== null && teamOf(lastBidder) === myTeam) {
    return null // never outbid your own partner
  }

  const nextBid = currentBid + MIN_INCREMENT
  return nextBid <= ceiling ? nextBid : null
}

/** Best-suit-by-hand-value trump call, same valuation bestBaseBid already
 * does internally to pick a bid — no separate scoring needed. */
export function aiChooseTrump(hand: readonly Card[]): Suit {
  return bestBaseBid(hand).trump
}

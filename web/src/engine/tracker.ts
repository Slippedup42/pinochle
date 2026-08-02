// Card-counting tracker + lead-card/follow-card AI — ported from
// pinochle_engine.py's PlayTracker class, choose_lead_card, and
// choose_follow_card functions (frozen Python reference).
//
// PlayTracker accumulates played-card counts across a round; both the
// lead-card strategy and the follow-card strategy here consume the same
// tracker instance. Its public shape is kept deliberately small -
// `record` / `playedCount` are all either strategy currently needs.

import type { SkillLevel } from '../persistence/options'
import { type Card, RANK_VALUE, RANKS, type Rank, type Suit } from './card'
import type { PlayerIndex, TrickPlay } from './trick'
import { SKILL_PARAMS } from './skills'

const POINT_RANKS = new Set(['A', '10', 'K'])
/** 6 ranks x 2 copies, matching Python's `TOTAL_TRUMP_COPIES`. `chooseFollowCard`
 *  calls trump "secure" once this many copies are accounted for. */
const TOTAL_TRUMP_COPIES = 12

/** Tracks cards played so far this round, across all 4 hands. */
export class PlayTracker {
  private readonly played = new Map<string, number>()

  private static key(suit: Suit, rank: Rank): string {
    return `${suit}:${rank}`
  }

  record(card: Card): void {
    const key = PlayTracker.key(card.suit, card.rank)
    this.played.set(key, (this.played.get(key) ?? 0) + 1)
  }

  playedCount(suit: Suit, rank: Rank): number {
    return this.played.get(PlayTracker.key(suit, rank)) ?? 0
  }
}

function handCount(hand: readonly Card[], suit: Suit, rank: Rank): number {
  return hand.reduce((count, c) => count + (c.suit === suit && c.rank === rank ? 1 : 0), 0)
}

function suitLength(hand: readonly Card[], suit: Suit): number {
  return hand.reduce((count, c) => count + (c.suit === suit ? 1 : 0), 0)
}

/**
 * A card is safe to lead once every higher-ranked card in its suit is
 * accounted for - either already played, or still in your own hand (a
 * card you hold yourself can't beat you).
 */
function isSafe(card: Card, hand: readonly Card[], tracker: PlayTracker): boolean {
  if (card.rank === 'A') return true
  const idx = RANK_VALUE[card.rank]
  for (const rank of RANKS) {
    const value = RANK_VALUE[rank]
    if (value > idx) {
      const accounted = tracker.playedCount(card.suit, rank) + handCount(hand, card.suit, rank)
      if (accounted < 2) return false
    }
  }
  return true
}

/**
 * Exactly 1 copy of this Ace in hand, and the other copy hasn't been
 * played yet - a live liability that needs to move before someone else's
 * lead traps you into losing it to the tie-break rule.
 */
function isUnsecuredAce(card: Card, hand: readonly Card[], tracker: PlayTracker): boolean {
  if (card.rank !== 'A') return false
  if (handCount(hand, card.suit, 'A') !== 1) return false // 0 copies (n/a) or 2 copies (secure double, no rush)
  return tracker.playedCount(card.suit, 'A') === 0
}

/**
 * Offense trump lead: when the bidding team is leading, draw trump by
 * leading the trump Ace if held. Without a trump Ace, abandon the aggressive
 * trump-draw plan and lead non-trump conservatively.
 */
function offenseTrumpLead(hand: readonly Card[], trump: Suit, tracker: PlayTracker): Card {
  const trumpAces = hand.filter((c) => c.suit === trump && c.rank === 'A')
  if (trumpAces.length > 0) return trumpAces[0]
  const nonTrump = hand.filter((c) => c.suit !== trump)
  if (nonTrump.length > 0) return leadSafeCascade(nonTrump, trump, tracker)
  return leadSafeCascade(hand, trump, tracker)
}

/**
 * Defending team lead: never lead trump — it helps the bidder consolidate
 * control — so run the safe-card cascade over the non-trump cards only.
 * Trump is led only when the hand is entirely trump, i.e. there is no other
 * legal lead at all.
 *
 * Corrected by the #126 audit. This used to avoid trump only when every trump
 * copy was already accounted for, and otherwise ran the cascade over the whole
 * hand — which leads an unsecured trump Ace, the cascade's very first tier. It
 * had borrowed `_trump_fully_accounted` from Python's `choose_expert_lead_card`
 * — a function belonging to the expert tier this engine does not port, where
 * that predicate gates a different rule entirely (endgame sequencing: hold
 * trump back so one is still in hand to win trick 12's +10 bonus). Python's
 * `_defender_lead` has no such condition: with `rollout_evaluator=None`, the
 * only mode reachable from the ported Proficient `choose_lead_card`, it
 * restricts to non-trump unconditionally.
 */
function defenderLead(hand: readonly Card[], trump: Suit, tracker: PlayTracker): Card {
  const nonTrump = hand.filter((c) => c.suit !== trump)
  if (nonTrump.length > 0) return leadSafeCascade(nonTrump, trump, tracker)
  return leadSafeCascade(hand, trump, tracker)
}

/**
 * The original Proficient safe-card cascade, extracted so offense/defender
 * wraps can call it with a filtered hand. Priority:
 *   1. Unsecured trump Ace
 *   2. Other unsecured Aces (longest suit first)
 *   3. Safe cards, cascading top-down by rank (longest suit first within a rank)
 *   4. Junk lead (non-point, non-trump) to surrender — shortest suit first
 *   5. Non-point trump as a last resort before giving up a point card
 */
function leadSafeCascade(hand: readonly Card[], trump: Suit, tracker: PlayTracker): Card {
  const trumpAces = hand.filter((c) => c.suit === trump && c.rank === 'A' && isUnsecuredAce(c, hand, tracker))
  if (trumpAces.length > 0) return trumpAces[0]

  const otherUnsecuredAces = hand.filter(
    (c) => c.rank === 'A' && c.suit !== trump && isUnsecuredAce(c, hand, tracker),
  )
  if (otherUnsecuredAces.length > 0) {
    otherUnsecuredAces.sort((a, b) => suitLength(hand, b.suit) - suitLength(hand, a.suit))
    return otherUnsecuredAces[0]
  }

  const safeCards = hand.filter((c) => isSafe(c, hand, tracker))
  if (safeCards.length > 0) {
    safeCards.sort((a, b) => {
      const byRank = RANK_VALUE[b.rank] - RANK_VALUE[a.rank]
      return byRank !== 0 ? byRank : suitLength(hand, b.suit) - suitLength(hand, a.suit)
    })
    return safeCards[0]
  }

  const junk = hand.filter((c) => !POINT_RANKS.has(c.rank) && c.suit !== trump)
  if (junk.length > 0) {
    junk.sort((a, b) => suitLength(hand, a.suit) - suitLength(hand, b.suit))
    return junk[0]
  }

  const junkTrump = hand.filter((c) => !POINT_RANKS.has(c.rank) && c.suit === trump)
  if (junkTrump.length > 0) {
    junkTrump.sort((a, b) => suitLength(hand, a.suit) - suitLength(hand, b.suit))
    return junkTrump[0]
  }

  return hand.reduce((lowest, c) => (RANK_VALUE[c.rank] < RANK_VALUE[lowest.rank] ? c : lowest))
}

/**
 * Choose what to lead when you have control. Priority, matching Python's
 * `choose_lead_card`:
 *   0. Bidder's first lead (#82) — must lead trump if any is held
 *   1. When the side is known: the bidding team draws trump
 *      (`offenseTrumpLead`), the defending team avoids it (`defenderLead`)
 *   2. Otherwise the safe-card cascade (`leadSafeCascade`)
 *
 * @param isBidderFirstLead - When true (bidder opening the first trick of the
 *   round), forces a trump lead if the player has any trump cards remaining.
 * @param skill - Skill level, read for `playPolicy` (#153). `'simple'` uses
 *   simplified logic: prefers low non-trump non-count cards. Defaults to 'hard'
 *   (`'cascade'`, the full Proficient cascade).
 * @param isBiddingTeam - Which side this seat is on. Undefined = fallback.
 */
export function chooseLeadCard(
  hand: readonly Card[],
  trump: Suit,
  tracker: PlayTracker,
  isBidderFirstLead = false,
  skill: SkillLevel = 'hard',
  isBiddingTeam?: boolean,
): Card {
  // Simplified leading — prefer low non-trump non-count cards. Reached by
  // `easy` and nothing else, which is the mapping the `meld_only` test this
  // replaces produced (#153); `playPolicy` is the field to change, not the
  // valuation one, because that one also decides how the seat bids.
  if (SKILL_PARAMS[skill].playPolicy === 'simple') {
    const safeLeads = hand.filter((c) => c.suit !== trump && c.rank !== 'A' && c.rank !== '10' && c.rank !== 'K')
    const pool = safeLeads.length > 0 ? safeLeads : hand
    return pool.reduce((lowest, c) => (c.rankValue < lowest.rankValue ? c : lowest))
  }

  // Bidder's first lead must be trump if they have any — rule #82
  if (isBidderFirstLead) {
    const trumps = hand.filter((c) => c.suit === trump)
    if (trumps.length > 0) {
      const unsecuredAce = trumps.find((c) => c.rank === 'A' && isUnsecuredAce(c, hand, tracker))
      if (unsecuredAce) return unsecuredAce
      const ace = trumps.find((c) => c.rank === 'A')
      if (ace) return ace
      return maxByRank(trumps)
    }
  }

  // Dispatch by side when known: bidding team draws trump, defending team avoids it
  if (isBiddingTeam === true) return offenseTrumpLead(hand, trump, tracker)
  if (isBiddingTeam === false) return defenderLead(hand, trump, tracker)

  // Fallback when side is unknown (old callers): original safe-card cascade
  return leadSafeCascade(hand, trump, tracker)
}

function minByRank(cards: readonly Card[]): Card {
  return cards.reduce((lowest, c) => (c.rankValue < lowest.rankValue ? c : lowest))
}

function maxByRank(cards: readonly Card[]): Card {
  return cards.reduce((highest, c) => (c.rankValue > highest.rankValue ? c : highest))
}

/**
 * Who's currently winning the trick-in-progress: highest trump if any
 * trump has been played, else highest card of the lead suit. Ties go to
 * whichever copy was played first (`reduce` only replaces the running
 * winner on a strictly-greater rank), matching `Trick.winner`'s
 * first-copy-wins behavior for the same reason.
 */
function currentWinner(trickPlays: readonly TrickPlay[], trump: Suit): TrickPlay {
  const trumpPlays = trickPlays.filter((p) => p.card.suit === trump)
  const pool = trumpPlays.length > 0
    ? trumpPlays
    : trickPlays.filter((p) => p.card.suit === trickPlays[0].card.suit)
  return pool.reduce((best, p) => (p.card.rankValue > best.card.rankValue ? p : best))
}

/**
 * Choose which legal card to play when following (not leading).
 * `legalMoves` already has the mandatory beat-if-possible / trump-if-void
 * rules applied by `Trick.legalMoves` - this only picks which one to use.
 *
 * `legalMoves` is always restricted to exactly one of three shapes by the
 * rules, and each gets its own tiered strategy:
 *   - Forced to follow a non-trump lead suit:
 *       1. Forced beat (every legal card already beats the current
 *          winner) - play the lowest one that still wins, saving bigger
 *          cards for later.
 *       2. Partner is currently winning - feed them points: the highest
 *          King/10 available, or (if none) the lowest card, to avoid
 *          donating a live Ace unless forced.
 *       3. Otherwise - play the lowest non-point card, falling back to
 *          the lowest legal card if only point cards are available.
 *   - Forced to play trump (void in the lead suit):
 *       1. Trump is secure (every copy - in hand plus already played -
 *          is accounted for, i.e. no trump left unseen) - play the
 *          lowest trump, conserving high trump for later control.
 *       2. Not secure - surrender the lowest point trump if there is
 *          one (get a liability out before it's trapped), else the
 *          lowest trump.
 *   - Sluff (void in both lead suit and trump): free choice across
 *     suits - work toward voiding the shortest suit, lowest rank within
 *     it.
 *
 * @param skill Skill level, read for `playPolicy` (#153). `'simple'` plays the
 *   lowest legal card. Defaults to 'hard' (`'cascade'`, the tiered logic above).
 */
export function chooseFollowCard(
  hand: readonly Card[],
  legalMoves: readonly Card[],
  trickPlays: readonly TrickPlay[],
  trump: Suit,
  myTeamPlayers: readonly PlayerIndex[],
  tracker?: PlayTracker,
  skill: SkillLevel = 'hard',
): Card {
  if (legalMoves.length === 1) return legalMoves[0]

  // Simplified following: always play the lowest legal card (#153)
  if (SKILL_PARAMS[skill].playPolicy === 'simple') {
    return legalMoves.reduce((lowest, c) => (c.rankValue < lowest.rankValue ? c : lowest))
  }

  const leadSuit = trickPlays.length > 0 ? trickPlays[0].card.suit : undefined
  const winner = trickPlays.length > 0 ? currentWinner(trickPlays, trump) : undefined
  const partnerWinning = winner !== undefined && myTeamPlayers.includes(winner.player)

  const allLeadSuit = leadSuit !== undefined && legalMoves.every((c) => c.suit === leadSuit)
  const allTrump = legalMoves.every((c) => c.suit === trump)

  if (allLeadSuit && leadSuit !== trump) {
    const forcedBeat = winner !== undefined && legalMoves.every((c) => c.rankValue > winner.card.rankValue)
    if (forcedBeat) return minByRank(legalMoves)

    if (partnerWinning) {
      const feedCards = legalMoves.filter((c) => c.rank === 'K' || c.rank === '10')
      if (feedCards.length > 0) return maxByRank(feedCards)
      return minByRank(legalMoves) // avoid donating a live Ace unless forced
    }

    const nonPoints = legalMoves.filter((c) => !POINT_RANKS.has(c.rank))
    if (nonPoints.length > 0) return minByRank(nonPoints)
    return minByRank(legalMoves)
  }

  if (allTrump) {
    let trumpSecure = true
    if (tracker !== undefined) {
      const playedTrump = RANKS.reduce((sum, r) => sum + tracker.playedCount(trump, r), 0)
      const handTrump = suitLength(hand, trump)
      trumpSecure = playedTrump + handTrump >= TOTAL_TRUMP_COPIES
    }
    if (trumpSecure) return minByRank(legalMoves)

    const points = legalMoves.filter((c) => POINT_RANKS.has(c.rank))
    if (points.length > 0) return minByRank(points)
    return minByRank(legalMoves)
  }

  // sluff - free choice across suits, work toward a void in the shortest suit
  const legalSorted = [...legalMoves].sort((a, b) => {
    const bySuitLength = suitLength(hand, a.suit) - suitLength(hand, b.suit)
    return bySuitLength !== 0 ? bySuitLength : a.rankValue - b.rankValue
  })
  return legalSorted[0]
}

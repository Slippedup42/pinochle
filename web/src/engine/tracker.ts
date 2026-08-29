// Card-counting tracker + lead-card/follow-card AI — ported from
// pinochle_engine.py's PlayTracker class, choose_lead_card, and
// choose_follow_card functions. Python is the reference implementation this
// was ported from, but what lives here is trick-play *strategy*, not rules,
// and strategy is the half that is allowed to diverge on the TS side (#213).
// TrumpMemory below (#158) is exactly that: it has no Python counterpart, and
// is not a parity gap to close.
//
// PlayTracker accumulates played-card counts across a round; both the
// lead-card strategy and the follow-card strategy here consume the same
// tracker instance. Its public shape is kept deliberately small -
// `record` / `playedCount` are all either strategy currently needs.
//
// Since #158 there is a second, weaker source of the same kind of fact:
// `TrumpMemory` (trumpMemory.ts), one per *seat* rather than one per round,
// capacity-limited to `2 x skill level` trump. `seenCount` below routes each
// question to whichever of the two owns it — the exact tracker for side suits,
// the seat's memory for trump — and that split is the only thing in this file
// that behaves differently at different skill levels.

import type { SkillLevel } from '../persistence/options'
import {
  type Card,
  handCount,
  maxByRank,
  minByRank,
  RANK_VALUE,
  RANKS,
  type Rank,
  suitLength,
  type Suit,
  TOTAL_TRUMP_COPIES,
} from './card'
import { POINT_RANKS, type PlayerIndex, type TrickPlay } from './trick'
import { SKILL_PARAMS } from './skills'
import type { TrumpMemory } from './trumpMemory'

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

/**
 * What one seat believes it has seen of a given card (#158) — the input to
 * every "can this still be beaten" question below.
 *
 *   **Side suits** come from `PlayTracker`, which counts perfectly and is not
 *   capacity-limited (#157 scoped the cap to trump), so side-suit safety is
 *   exact at every skill level.
 *
 *   **Trump** comes from the seat's `TrumpMemory` when it has one: capacity
 *   `2 x skill level`, most-recent-wins. `undefined` means either the caller
 *   supplied no memory or `safeCounterPolicy` is `'off'`, and then this falls
 *   back to the exact count — the pre-#158 reading, and what the `'off'` A/B
 *   arm has to reproduce byte for byte to be a baseline.
 *
 * The direction of the error matters more than its size. `TrumpMemory.seenCount`
 * can only ever *under*-report, because forgetting removes sightings and never
 * invents them, and an under-report makes `isBoss` below answer "beatable".
 * So a seat that cannot remember plays as though the card can be beaten, which
 * is the conservative resolution #158 asks for, and it is structural rather
 * than a branch someone has to remember to write.
 */
function seenCount(
  suit: Suit,
  rank: Rank,
  trump: Suit,
  tracker: PlayTracker | undefined,
  memory: TrumpMemory | undefined,
): number {
  if (suit === trump && memory !== undefined) return memory.seenCount(rank)
  return tracker?.playedCount(suit, rank) ?? 0
}

/**
 * Whether this card **cannot be beaten in its own suit**: every higher-ranked
 * card of that suit is accounted for, either seen already or sitting in your own
 * hand (a card you hold yourself cannot beat you).
 *
 * "In its own suit" is the whole caveat and it is not a shortcut (#158). A card
 * that is boss in a side suit can still be ruffed by an opponent who happens to
 * be void, and no amount of counting tells you whether they are — `PlayTracker`
 * records what was played, not who is out of what. So this predicate is never
 * a promise that the trick will be won; it is a promise that nobody takes it
 * *with a bigger card of this suit*. Callers must not read more into it.
 *
 * Formerly `isSafe`, unchanged in arithmetic and renamed because #158 gave it a
 * second caller with a different question in mind — leading a card safely, and
 * taking a trick with a counter that will hold.
 */
function isBoss(
  card: Card,
  hand: readonly Card[],
  trump: Suit,
  tracker: PlayTracker | undefined,
  memory: TrumpMemory | undefined,
): boolean {
  if (card.rank === 'A') return true
  const idx = RANK_VALUE[card.rank]
  for (const rank of RANKS) {
    const value = RANK_VALUE[rank]
    if (value > idx) {
      const accounted = seenCount(card.suit, rank, trump, tracker, memory) + handCount(hand, card.suit, rank)
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
function isUnsecuredAce(
  card: Card,
  hand: readonly Card[],
  trump: Suit,
  tracker: PlayTracker,
  memory: TrumpMemory | undefined,
): boolean {
  if (card.rank !== 'A') return false
  if (handCount(hand, card.suit, 'A') !== 1) return false // 0 copies (n/a) or 2 copies (secure double, no rush)
  return seenCount(card.suit, 'A', trump, tracker, memory) === 0
}

/**
 * Offense trump lead: when the bidding team is leading, draw trump by
 * leading the trump Ace if held. Without a trump Ace, abandon the aggressive
 * trump-draw plan and lead non-trump conservatively.
 *
 * #159 proposed replacing this with "hold trump back to ruff a counter-heavy
 * trick later", and measured it instead. Two findings, both in `web/README.md`:
 *
 *   - **The holding back is already here.** Over 300 headless games this is
 *     reached 9651 times on a bidding-side lead. 3444 are all-trump hands with
 *     no other legal lead, 421 take the Ace tier below, and the other 5786 lead
 *     a side suit while still holding trump. The Ace is the only trump the
 *     offense ever *chooses* to lead.
 *   - **Suppressing that one exception loses**, by 13.63 points a deal (95% CI
 *     -16.85 to -10.60, 5000 paired deals), with make-rate falling alongside it
 *     — a boss trump that takes the trick and draws a round of trump in one move
 *     is not a card to sit on. Narrowing the tier to *unsecured* Aces measures
 *     identically, because the mandatory trump lead on trick 1 plus the
 *     beat-if-possible rule means the twin is always gone by the time this is
 *     reached: unsecured on 0 of those 421.
 *
 * So this is unchanged, and it is reached only after the opening trick — the
 * bidder's first lead is answered by `chooseLeadCard`'s `isBidderFirstLead`
 * branch before it ever gets here, and nobody on the bidding side is on lead
 * before trick 2.
 */
function offenseTrumpLead(
  hand: readonly Card[],
  trump: Suit,
  tracker: PlayTracker,
  memory: TrumpMemory | undefined,
): Card {
  const trumpAces = hand.filter((c) => c.suit === trump && c.rank === 'A')
  if (trumpAces.length > 0) return trumpAces[0]
  const nonTrump = hand.filter((c) => c.suit !== trump)
  if (nonTrump.length > 0) return leadSafeCascade(nonTrump, trump, tracker, memory)
  return leadSafeCascade(hand, trump, tracker, memory)
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
function defenderLead(
  hand: readonly Card[],
  trump: Suit,
  tracker: PlayTracker,
  memory: TrumpMemory | undefined,
): Card {
  const nonTrump = hand.filter((c) => c.suit !== trump)
  if (nonTrump.length > 0) return leadSafeCascade(nonTrump, trump, tracker, memory)
  return leadSafeCascade(hand, trump, tracker, memory)
}

/**
 * The original Proficient safe-card cascade, extracted so offense/defender
 * wraps can call it with a filtered hand. Priority:
 *   1. Unsecured trump Ace
 *   2. Other unsecured Aces (longest suit first)
 *   3. Safe cards, cascading top-down by rank (longest suit first within a rank)
 *   4. Junk lead (non-point, non-trump) to surrender — shortest suit first
 *   5. Non-point trump as a last resort before giving up a point card
 *
 * Tier 3 is the leading half of #158: *"a counter that is provably boss is safe
 * to lead; one that is not, is not."* That was already true of side suits, where
 * `PlayTracker` counts exactly. What #158 adds is that when the card in question
 * is **trump**, the count comes from this seat's `TrumpMemory` instead — so an
 * `easy` seat holding the trump 10 with both Aces long gone often does not know
 * it, and drops to the junk tier rather than cashing it. That is the skill dial
 * during trick play, and it is reached here only on an all-trump hand:
 * `offenseTrumpLead` and `defenderLead` both filter trump out first whenever the
 * hand has anything else.
 */
function leadSafeCascade(
  hand: readonly Card[],
  trump: Suit,
  tracker: PlayTracker,
  memory: TrumpMemory | undefined,
): Card {
  const trumpAces = hand.filter((c) => c.suit === trump && c.rank === 'A' && isUnsecuredAce(c, hand, trump, tracker, memory))
  if (trumpAces.length > 0) return trumpAces[0]

  const otherUnsecuredAces = hand.filter(
    (c) => c.rank === 'A' && c.suit !== trump && isUnsecuredAce(c, hand, trump, tracker, memory),
  )
  if (otherUnsecuredAces.length > 0) {
    otherUnsecuredAces.sort((a, b) => suitLength(hand, b.suit) - suitLength(hand, a.suit))
    return otherUnsecuredAces[0]
  }

  const safeCards = hand.filter((c) => isBoss(c, hand, trump, tracker, memory))
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
 *   0. Bidder's first lead (#82) — must lead trump if any is held, choosing
 *      an unsecured trump Ace, then any trump Ace, then the highest
 *      *non-counter* trump (Q -> J -> 9, #159), then the highest trump
 *   1. When the side is known: the bidding team draws trump
 *      (`offenseTrumpLead`), the defending team avoids it (`defenderLead`)
 *   2. Otherwise the safe-card cascade (`leadSafeCascade`)
 *
 * Tier 0 is the only place this AI plans past the current trick, and it is a
 * weak form of it: it spends the one lead the bidder is guaranteed on drawing
 * the opponents' counters out at no cost, rather than on winning a trick now.
 * #159's stronger proposal — hold trump back afterwards to ruff a counter-heavy
 * trick and take `LAST_TRICK_BONUS` — was measured and rejected; see
 * `offenseTrumpLead`.
 *
 * @param isBidderFirstLead - When true (bidder opening the first trick of the
 *   round), forces a trump lead if the player has any trump cards remaining.
 * @param skill - Skill level, read for `playPolicy` (#153). Since #156 every
 *   shipped row is `'cascade'` — the full Proficient cascade — so this argument
 *   no longer varies the strategy in a real game — except through
 *   `safeCounterPolicy`, which does not change the rule but does change how well
 *   this seat can answer it (#158). `'simple'` (low non-trump non-counter)
 *   survives as an A/B arm, reachable only through an override. Defaults to
 *   'hard'.
 * @param isBiddingTeam - Which side this seat is on. Undefined = fallback.
 * @param trumpMemory - This seat's capacity-limited view of the trump seen so
 *   far (#157), consulted only when `safeCounterPolicy` is `'counted'`. Omit it
 *   and trump safety is read from the exact `tracker`, as before #158.
 */
export function chooseLeadCard(
  hand: readonly Card[],
  trump: Suit,
  tracker: PlayTracker,
  isBidderFirstLead = false,
  skill: SkillLevel = 'hard',
  isBiddingTeam?: boolean,
  trumpMemory?: TrumpMemory,
): Card {
  // The one gate. `undefined` here means every question below about trump is
  // answered from `PlayTracker`'s exact count, which is what the pre-#158 code
  // did and what the `'off'` A/B arm must keep doing.
  const memory = SKILL_PARAMS[skill].safeCounterPolicy === 'counted' ? trumpMemory : undefined

  // Simplified leading — prefer low non-trump non-count cards. No shipped
  // `SKILL_PARAMS` row selects this since #156 moved `easy` onto the cascade
  // with everyone else, so nothing reaches it in a real game; it stays as the
  // `'simple'` arm of `PLAY_AB_POLICIES`, the baseline every remaining child of
  // epic #152 is measured against, and is reachable only by overriding the dial.
  if (SKILL_PARAMS[skill].playPolicy === 'simple') {
    const safeLeads = hand.filter((c) => c.suit !== trump && c.rank !== 'A' && c.rank !== '10' && c.rank !== 'K')
    const pool = safeLeads.length > 0 ? safeLeads : hand
    return pool.reduce((lowest, c) => (c.rankValue < lowest.rankValue ? c : lowest))
  }

  // Bidder's first lead must be trump if they have any — rule #82
  if (isBidderFirstLead) {
    const trumps = hand.filter((c) => c.suit === trump)
    if (trumps.length > 0) {
      const unsecuredAce = trumps.find((c) => c.rank === 'A' && isUnsecuredAce(c, hand, trump, tracker, memory))
      if (unsecuredAce) return unsecuredAce
      const ace = trumps.find((c) => c.rank === 'A')
      if (ace) return ace
      // Aceless: the highest *non-counter* trump, cascading Q -> J -> 9 (#159).
      // This was `maxByRank`, which leads the 10 — ten points handed to whoever
      // holds the Ace, in exchange for drawing one round of trump. The Queen
      // drags out a King and an Ace while donating nothing, and can leave this
      // hand's own 10 as the boss trump. Worth +7.6 to +9.8 points a deal across
      // three seeds of 5000 paired deals, with make-rate up on all three; see
      // `web/README.md`.
      const nonCounters = trumps.filter((c) => !POINT_RANKS.has(c.rank))
      if (nonCounters.length > 0) return maxByRank(nonCounters)
      return maxByRank(trumps) // nothing but counters held — take the round of trump
    }
  }

  // Dispatch by side when known: bidding team draws trump, defending team avoids it
  if (isBiddingTeam === true) return offenseTrumpLead(hand, trump, tracker, memory)
  if (isBiddingTeam === false) return defenderLead(hand, trump, tracker, memory)

  // Fallback when side is unknown (old callers): original safe-card cascade
  return leadSafeCascade(hand, trump, tracker, memory)
}

/**
 * Partner is winning and you cannot take the trick off them: bank a counter
 * into it, and make it the **cheapest** one you hold (#154).
 *
 * A, 10 and K are worth exactly 10 points each (`pinochle_rules.md:140`), so
 * which counter goes in does not change what the trick pays — only what is left
 * in hand afterwards. The K is therefore strictly the one to spend: it banks the
 * same 10 while the 10 it keeps is beaten by nothing but an Ace and will often
 * take a later trick outright. This used to be `maxByRank`, which threw the 10
 * and kept the K — identical points for a worse hand, on every deal.
 *
 * The Ace stays out of it, so a hand holding an Ace and no other counter donates
 * junk rather than the boss of the suit. That exclusion is measured, not
 * assumed. A literal reading of the rule — "play your lowest legal point" —
 * orders K -> 10 -> A and would put the Ace in, and #154 ran that variant as its
 * own arm. Over 5000 paired deals it is a null against the old `maxByRank`
 * (+0.4 per deal, 95% CI -1.7 to +2.5, p = 0.58) and loses to this one by
 * +3.6 per deal (95% CI +2.0 to +5.1) — donating the Ace gives back the whole
 * gain of spending the King. Both results reproduce on a second seed. See
 * `web/README.md`.
 */
function feedPartner(legalMoves: readonly Card[]): Card {
  const counters = legalMoves.filter((c) => c.rank === 'K' || c.rank === '10')
  if (counters.length > 0) return minByRank(counters)
  return minByRank(legalMoves) // no cheap counter — donate junk, not a live Ace
}

/**
 * Forced to take the trick: every legal card already beats whoever is winning,
 * so the only question left is which one to spend (#155). Paul's rule — "if you
 * are going to beat, you want to take with either no point, or take with the
 * lowest point that cannot be beat":
 *
 *   1. A non-counter (Q, J, 9) if any legal beater is one — take the trick
 *      without also donating 10 points into it.
 *   2. Otherwise the lowest counter that cannot itself be beaten (#158).
 *   3. Otherwise the lowest counter.
 *
 * Tiers 1 and 3 pick the card `minByRank` picked before this function existed:
 * pinochle's rank order (9 J Q K 10 A) happens to put every non-counter strictly
 * below every counter, so "lowest legal card" already read as "cheapest free
 * beat, else cheapest counter". Tier 2 is the one that changes a card, and it is
 * #158's whole content.
 *
 * ## What tier 2 does, and what it deliberately does not claim
 *
 * Every legal move here is a counter, and they are all of one suit — the branch
 * above only reaches this with a single-suit legal set. So the candidates are
 * some subset of {K, 10, A} and the question is which of them will still be
 * standing when the trick closes. `isBoss` answers it *in suit*, and that is the
 * strongest claim available: an opponent who is void and holds a trump takes the
 * trick whatever is played here, and nothing in `PlayTracker` says who is void.
 * Playing the boss card is therefore not "winning the trick", it is "not losing
 * it to a bigger card of this suit" — which is the loss this rule exists to
 * avoid, since spending a King into a trick an opponent's Ace then takes hands
 * over 20 points rather than 10.
 *
 * Two consequences of that, both intended:
 *
 *   - **The Ace always qualifies**, so whenever an Ace is legal this tier picks
 *     something, and it degenerates to "the cheapest counter that holds, else
 *     the Ace". With nothing known that is the Ace — spending the boss to be
 *     certain, rather than gambling a King on information the seat does not
 *     have. That is the conservative direction #158 asks for.
 *   - **Nobody left to play means nothing is outstanding.** Last to the trick,
 *     no card can be beaten, so the tier collapses to the cheapest counter — the
 *     King — instead of throwing an Ace at a trick already won. This is a
 *     property of the position, not of the counting, so it holds at every skill
 *     level, and it is why turning #158 on cannot make the fourth seat worse.
 *
 * @param seatsStillToPlay - How many seats follow this one in the trick, 0-3.
 * @param counted - `safeCounterPolicy === 'counted'`. When false this is exactly
 *   the post-#155 function, which is what makes the A/B a one-field comparison.
 */
function chooseForcedBeat(
  legalMoves: readonly Card[],
  hand: readonly Card[],
  trump: Suit,
  tracker: PlayTracker | undefined,
  memory: TrumpMemory | undefined,
  seatsStillToPlay: number,
  counted: boolean,
): Card {
  const nonCounters = legalMoves.filter((c) => !POINT_RANKS.has(c.rank))
  if (nonCounters.length > 0) return minByRank(nonCounters)

  if (counted) {
    if (seatsStillToPlay <= 0) return minByRank(legalMoves)
    const boss = legalMoves.filter((c) => isBoss(c, hand, trump, tracker, memory))
    if (boss.length > 0) return minByRank(boss)
  }

  return minByRank(legalMoves)
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
 *          winner, measured as trick-winning power rather than raw rank
 *          - #155) - take it with a non-counter if one is legal, else
 *          with the cheapest counter that cannot itself be beaten in
 *          suit (#158). See `chooseForcedBeat`.
 *       2. Partner is currently winning - feed them points: the lowest
 *          King/10 available (#154 - every counter pays 10, so spend the
 *          weakest), or (if none) the lowest card, to avoid donating a
 *          live Ace unless forced.
 *       3. Otherwise - play the lowest non-point card, falling back to
 *          the lowest legal card if only point cards are available.
 *   - Forced to play trump (void in the lead suit, or trump was led):
 *       0. Forced to *overtrump* - a trump is already winning the trick
 *          and every legal move beats it, so the rules have restricted
 *          this seat to beaters. Same selection as the lead-suit forced
 *          beat above, and the one place #157's capacity-limited trump
 *          memory decides a card (#158).
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
 * Tier 0 of the trump branch is new in #158 and is worth saying why it is not
 * scope creep. #155 wrote the forced-beat selection rule but could only reach
 * the *lead-suit* branch, because that is where the detection lived; the trump
 * branch had no notion of a forced beat at all and answered an overtrump with
 * "surrender the lowest point trump", which spends a King into a trick an
 * opponent's Ace is about to take. The issue's own worked example — both trump
 * Aces gone makes the 10 boss, then the Kings after the 10s — is a *trump*
 * example, so tier 2 of `chooseForcedBeat` cannot be implemented as specified
 * without a forced beat in trump to implement it in. Tier 1 comes along with it
 * because a rule that prefers a free beat everywhere except trump would be
 * incoherent, not because it was measured separately.
 *
 * Note what is deliberately left alone: `trumpSecure` below still reads
 * `PlayTracker`'s exact count, not the memory. "Is every trump accounted for"
 * is a different question from "can this card be beaten", #157 recorded the
 * exact tracker as load-bearing for the parity fixtures, and degrading that one
 * is its own issue with its own measurement.
 *
 * @param skill Skill level, read for `playPolicy` (#153) and
 *   `safeCounterPolicy` (#158). Since #156 every shipped row is `'cascade'`, so
 *   the tiers themselves are the same at every level; what the level changes is
 *   how much of the trump this seat can still recall when tier 2 of
 *   `chooseForcedBeat` asks. `'simple'` (play the lowest legal card) survives as
 *   an A/B arm, reachable only through an override. Defaults to 'hard'.
 * @param trumpMemory This seat's capacity-limited trump view (#157). Consulted
 *   only when `safeCounterPolicy` is `'counted'`; omitted, trump questions fall
 *   back to the exact `tracker`, which is the pre-#158 reading.
 */
export function chooseFollowCard(
  hand: readonly Card[],
  legalMoves: readonly Card[],
  trickPlays: readonly TrickPlay[],
  trump: Suit,
  myTeamPlayers: readonly PlayerIndex[],
  tracker?: PlayTracker,
  skill: SkillLevel = 'hard',
  trumpMemory?: TrumpMemory,
): Card {
  if (legalMoves.length === 1) return legalMoves[0]

  // Simplified following: always play the lowest legal card (#153). Unreachable
  // from a shipped `SKILL_PARAMS` row since #156, and kept for the same reason
  // as its counterpart in `chooseLeadCard` above — it is the A/B baseline.
  if (SKILL_PARAMS[skill].playPolicy === 'simple') {
    return legalMoves.reduce((lowest, c) => (c.rankValue < lowest.rankValue ? c : lowest))
  }

  const counted = SKILL_PARAMS[skill].safeCounterPolicy === 'counted'
  const memory = counted ? trumpMemory : undefined
  /** Seats still to follow this one, 0-3. Zero means nothing is outstanding. */
  const seatsStillToPlay = 3 - trickPlays.length

  const leadSuit = trickPlays.length > 0 ? trickPlays[0].card.suit : undefined
  const winner = trickPlays.length > 0 ? currentWinner(trickPlays, trump) : undefined
  const partnerWinning = winner !== undefined && myTeamPlayers.includes(winner.player)

  const allLeadSuit = leadSuit !== undefined && legalMoves.every((c) => c.suit === leadSuit)
  const allTrump = legalMoves.every((c) => c.suit === trump)

  if (allLeadSuit && leadSuit !== trump) {
    // Trick-winning power, not raw rank (#155). `currentWinner` returns a trump
    // whenever one has been played, and `rankValue` is suit-blind, so the
    // comparison this replaces — `c.rankValue > winner.card.rankValue` — read a
    // partner who had ruffed in with the 9 of trump as beatable by any Queen.
    // That is not a near miss: it skipped the feed-partner tier below and threw
    // the cheapest card into a trick this side had already won. `Card.beats`
    // answers the question actually being asked (trump over non-trump, rank
    // within the suit), and here every legal card is of the lead suit, so it
    // returns false against any trump — correctly, since no card of the lead
    // suit can take a trick a trump is winning.
    const forcedBeat = winner !== undefined && legalMoves.every((c) => c.beats(winner.card, trump))
    if (forcedBeat) {
      return chooseForcedBeat(legalMoves, hand, trump, tracker, memory, seatsStillToPlay, counted)
    }

    if (partnerWinning) return feedPartner(legalMoves)

    const nonPoints = legalMoves.filter((c) => !POINT_RANKS.has(c.rank))
    if (nonPoints.length > 0) return minByRank(nonPoints)
    return minByRank(legalMoves)
  }

  if (allTrump) {
    // Tier 0 (#158): forced to overtrump. A trump is already winning and every
    // legal move beats it, which `Trick.legalMoves` only produces by restricting
    // this seat to beaters — rule 3 when trump was led, rule 5 when a ruff has
    // to be over-ruffed. Both are the same decision as the lead-suit forced beat
    // above, so they take the same selection.
    //
    // The `winner.card.suit === trump` test is what keeps a plain ruff out of
    // here: with no trump yet on the table every trump in hand "beats" the
    // side-suit winner, but the rules restricted nothing and the seat is free to
    // choose. That position keeps its existing tiers, where "surrender the
    // lowest point trump" is a deliberate get-the-liability-out heuristic rather
    // than a way of taking a trick.
    const forcedOvertrump =
      counted &&
      winner !== undefined &&
      winner.card.suit === trump &&
      legalMoves.every((c) => c.beats(winner.card, trump))
    if (forcedOvertrump) {
      return chooseForcedBeat(legalMoves, hand, trump, tracker, memory, seatsStillToPlay, counted)
    }

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

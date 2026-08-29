// Round — trick-taking phase and round-level (contract) scoring. Ported
// from pinochle_engine.py's Round._trick_taking_loop / Round._score_round,
// which stays authoritative for the scoring rules below (MAX_TRICK_POINTS,
// LAST_TRICK_BONUS, made-vs-set): engineParity.test.ts replays a complete
// Python round against this module, and a mismatch is TS drift (#125).
//
// Bidding and the 3-card pass aren't reimplemented here — this module
// picks up *after* trump is set and hands are finalized (post pass),
// taking the bid winner and the agreed contract as given inputs. The
// orchestrator that runs the whole round is components/gameFlowReducer.ts
// (#47): deal -> auctionReducer.ts's bidding/passing (#34) -> scoreMelds
// (melds.ts, per player) -> playTrickTakingPhase -> scoreRound -> feed the
// result into game.ts's checkGameOutcome. It uses PlayerIndex/TeamId from
// this module and trick.ts, which is what keeps that glue consistent with
// how bidding/passing represent players/hands.

import { COPIES_PER_CARD, type Card, type Suit, SUITS } from './card'
import { COUNTER_VALUE, POINT_RANKS, type PlayerIndex, Trick } from './trick'

export type TeamId = 0 | 1

/** Fixed seating per pinochle_rules.md: Player 0 & 2 = Team A (0), Player 1 & 3 = Team B (1). */
export function teamOf(player: PlayerIndex): TeamId {
  return (player % 2) as TeamId
}

/** The other player on the same team, per the fixed seating (0<->2, 1<->3). */
export function partnerOf(player: PlayerIndex): PlayerIndex {
  return ((player + 2) % 4) as PlayerIndex
}

export type Hands = [Card[], Card[], Card[], Card[]]

/**
 * Picks which legal card `player` plays. `trick` gives access to
 * `trumpSuit`, `leadSuit`, and the plays made so far this trick.
 * Left fully generic on purpose — real strategy (Proficient-tier AI,
 * or human input) is out of scope for this port; this only enforces
 * legality and resolves the outcome.
 */
export type ChooseCardFn = (
  player: PlayerIndex,
  hand: readonly Card[],
  legalMoves: readonly Card[],
  trick: Trick,
) => Card

export interface TrickTakingResult {
  trickPointsByTeam: Record<TeamId, number>
  /** Winning player of each of the 12 tricks, in order (for UI/debugging/replay). */
  trickWinners: PlayerIndex[]
}

/**
 * Tricks in a round, and the bonus the 12th carries. Exported because
 * `trickPlayReducer.ts` runs the same per-trick resolution one play at a
 * time for the UI and must award the bonus on the same trick this module's
 * `scoreRound` and `findClaim` do — previously it kept its own copies with
 * a `// matches round.ts` comment as the only thing holding them in step
 * (#218). This module owns them: it is where every other trick-scoring
 * constant lives, and `MAX_TRICK_POINTS` below derives from one of them.
 */
export const TRICK_COUNT = 12
export const LAST_TRICK_BONUS = 10 // team that wins the 12th trick gets +10

/**
 * Every trick point that exists in one round: each counter rank, in each
 * suit, in each of the deck's two copies, plus the last-trick bonus. 250
 * today — 24 counters at 10, plus 10 — matching `pinochle_rollout.py`'s
 * `MAX_TRICK_POINTS`.
 *
 * Derived rather than written as a literal so it cannot drift: change the
 * counter set, what a counter is worth, or the last-trick bonus, and the
 * ceiling follows. A hardcoded 250 here would silently become wrong.
 *
 * **This is not `card.ts`'s `FORCED_BID`**, which is also 250. That one is
 * the bid the dealer is stuck with when everyone passes; the two numbers
 * are equal by coincidence and mean unrelated things (#178).
 */
export const MAX_TRICK_POINTS =
  POINT_RANKS.size * SUITS.length * COPIES_PER_CARD.length * COUNTER_VALUE + LAST_TRICK_BONUS

/**
 * The auto-SET rule (`pinochle_expert_ai_strategy.md` Section 5): true when
 * the bidding team cannot reach its bid even by taking every trick point on
 * the table. The contract is then mathematically lost before a card is led,
 * and playing it out cannot change the bidding team's score — it can only
 * hand the defenders trick points that conceding denies them.
 *
 * A hard arithmetic prune, not a heuristic, so callers check it *before*
 * consulting `shouldConcede` (`evaluator.ts`): a hand that cannot be made
 * should never reach a probabilistic evaluator.
 *
 * The Python twin is `pinochle_rollout.is_auto_set`, which has run inside
 * rollouts since #59; #178 is what applies it to a real game in both engines.
 */
export function isAutoSet(biddingTeamMeld: number, bid: number): boolean {
  return biddingTeamMeld + MAX_TRICK_POINTS < bid
}

export interface ClaimResult {
  /** The seat on lead that provably takes every remaining trick. */
  readonly claimer: PlayerIndex
  /** The claimer's whole remaining hand — every card of it a winner, and what
   *  the message shows. */
  readonly cards: readonly Card[]
  /** Trick points transferred: every counter still held by anyone, plus the
   *  last-trick bonus, since the claimer necessarily wins the 12th. */
  readonly trickPoints: number
  /** How many tricks the claim skips. */
  readonly tricks: number
}

/**
 * How many tricks must remain for a claim to be worth interrupting the game
 * for. At one trick there is nothing to skip — the last card is played, the
 * message and the play resolve identically — so a dialog there costs a tap and
 * saves nothing.
 */
export const MIN_CLAIMABLE_TRICKS = 2

/**
 * "The rest are mine" — the seat on lead that is guaranteed every remaining
 * trick, or null (#208).
 *
 * Paul's rule, and the reason it is not spelled the way he first said it. The
 * idea he gave is exactly right: trump can only be beaten by trump, so if no
 * one else holds any, playing it out is a formality. What that argument covers
 * is the claimer's *trump*. It does not cover the rest of their hand, and the
 * difference decides hands rather than merely tidying them.
 *
 * A seat holding every remaining trump plus two low hearts does not take every
 * trick. It leads trump while it has trump and wins those, and then it has to
 * lead a heart into three players who are free to beat it. Measured over 3000
 * played hands, the literal reading — "holds all the trump" — fires on 59.4% of
 * hands, and in **906 of the 1624** where it alone applies the claiming team
 * went on to lose a trick. It is not a shortcut; it is a scoring bug.
 *
 * So the test is not about trump. It is about whether anything the claimer
 * holds *can be beaten at all*:
 *
 *   - A trump card is a winner when no other seat holds trump.
 *   - A side card is a winner when no other seat holds a higher card of its
 *     suit. Equal rank is fine — the deck has two of everything, and
 *     `Trick.winner` gives ties to the card played first, which is the
 *     claimer's, because the claimer is on lead.
 *
 * That last clause is why this takes a `leader`. On lead the claimer chooses
 * the suit every trick, so each of its cards meets only what is below it and
 * the order it plays them in cannot matter. A seat that is *not* on lead can be
 * dragged into a suit it is void in with no trump to answer, and would lose the
 * trick it was about to claim.
 *
 * Given lead plus unbeatable-everywhere, the induction is one line: the claimer
 * leads a winner, takes the trick, and is on lead again with a strictly smaller
 * hand of the same kind. So every remaining counter and the last-trick bonus go
 * to its team.
 *
 * Measured on the same 3000 hands: fires on 22.8%, skipping 1705 tricks, and
 * the claiming seat won every one of those tricks in the played-out control —
 * zero misawards. `round.test.ts` keeps that control as a test.
 *
 * Evaluated only between tricks, with nothing on the table. Mid-trick the cards
 * already played change which lines are legal, and this reasoning assumes a
 * clean lead.
 */
export function findClaim(
  hands: Readonly<Hands>,
  trumpSuit: Suit,
  leader: PlayerIndex,
  minTricks: number = MIN_CLAIMABLE_TRICKS,
): ClaimResult | null {
  const remaining = hands[leader].length
  if (remaining < minTricks) return null
  // Between tricks every seat holds the same number of cards. If they do not,
  // this is being asked mid-trick and the guarantee above does not apply.
  if (!hands.every((h) => h.length === remaining)) return null

  const others = ([0, 1, 2, 3] as PlayerIndex[]).filter((p) => p !== leader)
  const anyoneElseHasTrump = others.some((p) => hands[p].some((c) => c.suit === trumpSuit))

  const unbeatable = (card: Card): boolean =>
    card.suit === trumpSuit
      ? !anyoneElseHasTrump
      : !anyoneElseHasTrump &&
        !others.some((p) => hands[p].some((o) => o.suit === card.suit && o.rankValue > card.rankValue))

  if (!hands[leader].every(unbeatable)) return null

  const counters = hands
    .flat()
    .reduce((sum, c) => sum + (POINT_RANKS.has(c.rank) ? COUNTER_VALUE : 0), 0)
  return {
    claimer: leader,
    cards: [...hands[leader]],
    trickPoints: counters + LAST_TRICK_BONUS,
    tricks: remaining,
  }
}

/**
 * `playTrickTakingPhase` deliberately does **not** consult `findClaim`, and that
 * is an architectural line rather than an omission (#208).
 *
 * This function is the parity-checked port of Python's `Round._trick_taking_loop`
 * — `engineParity.test.ts` replays recorded Python rounds through it and asserts
 * the winner and the points of every individual trick. `pinochle_engine.py` has
 * no claim rule, so a claim firing inside a replay would have the two engines
 * describing the same round differently even when they agree about the score.
 * CLAUDE.md's rule is that Python is the reference; a rule that exists on only
 * one side does not belong in the loop the two are compared through.
 *
 * The claim is not a rule anyway. It is a shortcut over a decided position, and
 * `findClaim`'s guarantee is exactly that it changes no outcome — so it belongs
 * in whatever drives an interactive game and wants to skip the formality, which
 * is `trickPlayReducer`. `round.test.ts` pins the equivalence directly: random
 * deals played out in full and played with the claim applied reach identical
 * trick points, which is the property that makes the shortcut safe to take
 * anywhere.
 */

/**
 * Plays all 12 tricks of a round. `hands` are cloned internally (not
 * mutated in place), so the caller's arrays are safe to reuse/inspect
 * afterward. The contract winner (`bidWinner`) leads the first trick;
 * each subsequent trick is led by the previous trick's winner, per
 * pinochle_rules.md Phase 4.
 */
export function playTrickTakingPhase(
  hands: Readonly<Hands>,
  trumpSuit: Suit,
  bidWinner: PlayerIndex,
  chooseCard: ChooseCardFn,
): TrickTakingResult {
  const workingHands = hands.map((h) => [...h]) as Hands
  const trickPointsByTeam: Record<TeamId, number> = { 0: 0, 1: 0 }
  const trickWinners: PlayerIndex[] = []

  let leader = bidWinner
  for (let trickNum = 0; trickNum < TRICK_COUNT; trickNum++) {
    const trick = new Trick(trumpSuit)
    let player = leader
    for (let seat = 0; seat < 4; seat++) {
      const hand = workingHands[player]
      const legal = trick.legalMoves(hand)
      const card = chooseCard(player, hand, legal, trick)
      const idx = hand.findIndex((c) => c.equals(card))
      if (idx === -1) {
        throw new Error(
          `chooseCard returned a card not in player ${player}'s hand: ${card.toString()}`,
        )
      }
      hand.splice(idx, 1)
      trick.play(player, card)
      player = ((player + 1) % 4) as PlayerIndex
    }

    const winner = trick.winner()
    let points = trick.points()
    if (trickNum === TRICK_COUNT - 1) points += LAST_TRICK_BONUS
    trickPointsByTeam[teamOf(winner)] += points
    trickWinners.push(winner)
    leader = winner
  }

  return { trickPointsByTeam, trickWinners }
}

export interface RoundScoreInput {
  meldPointsByTeam: Record<TeamId, number>
  trickPointsByTeam: Record<TeamId, number>
  bidWinnerTeam: TeamId
  bid: number
}

/**
 * Contract check, per pinochle_rules.md Phase 5: if the bidding team's
 * meld + trick total is less than their bid, they score -bid for the
 * round ("going set"). The defending team always scores their own
 * meld + trick points, regardless of what happens to the bidding team.
 */
export function scoreRound(input: RoundScoreInput): Record<TeamId, number> {
  const { meldPointsByTeam, trickPointsByTeam, bidWinnerTeam, bid } = input
  const scores: Record<TeamId, number> = { 0: 0, 1: 0 }
  for (const team of [0, 1] as const) {
    const total = meldPointsByTeam[team] + trickPointsByTeam[team]
    scores[team] = team === bidWinnerTeam && total < bid ? -bid : total
  }
  return scores
}

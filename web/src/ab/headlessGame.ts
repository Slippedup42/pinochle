// A headless driver for the real TS game (#115).
//
// #115 needs to A/B two TypeScript bidding policies, which `ab_harness.py`
// cannot do — it drives the Python engine, and both sides here are TS. This
// module is the smallest thing that plays a complete game without React: it
// calls the *same* reducers and the *same* AI entry points the app calls
// (`auctionReducer`, `chooseBid`, `chooseTrump`, `choosePassCards`,
// `playTrickTakingPhase`, `chooseLeadCard`/`chooseFollowCard`,
// `meldPointsByTeam`, `scoreRound`, `checkGameOutcome`), in the order
// `GameFlow.tsx` calls them, with the delays and the rendering removed.
//
// It is deliberately not a second engine. Every rule it appears to implement is
// a call into the module that already owns that rule; what lives here is only
// the loop GameFlow's `useEffect`s form, plus seeding.
//
// One thing it does NOT model, on purpose:
//
//   The human seat. Every seat is an AI, as in `biddingSim.test.ts`. That is
//   what makes the comparison a comparison.
//
// Conceding used to be a second such exclusion, on the grounds that
// `trickPlayReducer`'s CONCEDE action had exactly one caller — the human's fold
// button (#83) — so modelling it here would have measured a feature the product
// did not ship. #123 wired `shouldConcede` for every AI bid winner, so that
// reasoning inverted: leaving it out would now measure a *different* game from
// the one the app plays. The concede window below is the same one
// `TrickPlayFlow` gives the AI, and both read the same `foldPolicy`.

import { auctionReducer, initAuctionState, passedPlayersOf, type AuctionState } from '../components/auctionReducer'
import { meldPointsByTeam } from '../components/gameFlowReducer'
import { teammatesOf } from '../components/trickPlayReducer'
import { type AuctionContext, chooseBid, chooseTrump } from '../engine/bidding'
import { Card, type CopyId, RANKS, type Suit, SUITS } from '../engine/card'
import { shouldConcede } from '../engine/evaluator'
import { checkGameOutcome } from '../engine/game'
import { isMisdealEligible } from '../engine/misdeal'
import { PASS_COUNT, choosePassCards } from '../engine/passing'
import { type Hands, isAutoSet, playTrickTakingPhase, scoreRound, teamOf, type TeamId } from '../engine/round'
import { SKILL_PARAMS } from '../engine/skills'
import { PlayTracker, chooseFollowCard, chooseLeadCard } from '../engine/tracker'
import { newTrumpMemories } from '../engine/trumpMemory'
import type { PlayerIndex } from '../engine/trick'
import type { SkillLevel } from '../persistence/options'

/** Matches AuctionFlow's MIN_INCREMENT. */
const MIN_INCREMENT = 10
const SEATS: readonly PlayerIndex[] = [0, 1, 2, 3]
const SEAT_NAMES: Record<PlayerIndex, string> = { 0: 'S0', 1: 'S1', 2: 'S2', 3: 'S3' }
/** A real game reaches 1000 in well under this. The guard exists so a rules
 *  change that stalls scoring shows up as a loud failure rather than a hang. */
const MAX_ROUNDS = 300

export type Rng = () => number

/** mulberry32. Small, fast, and good enough for shuffling — the property that
 *  matters here is that a seed reproduces a run exactly, so a surprising A/B
 *  result can be replayed. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Mixes two 32-bit values into one seed. Used to derive round N's deal from
 *  (game seed, round index) alone — the same trick `Game.play(deal_seed=...)`
 *  uses in Python, and for the same reason: the deal must not drift when one
 *  configuration consumes more random values than the other while thinking. */
export function mixSeed(a: number, b: number): number {
  let h = (a ^ 0x9e3779b9) >>> 0
  h = Math.imul(h ^ (b + 0x85ebca6b), 0xcc9e2d51) >>> 0
  h = (h ^ (h >>> 13)) >>> 0
  return Math.imul(h, 0x1b873593) >>> 0
}

/** A shuffled 48-card deal from a seeded RNG. Rebuilt here rather than calling
 *  `Deck` because `Deck.shuffle` draws from `Math.random`, which cannot be
 *  pinned to a deal seed. Card construction and the Fisher-Yates loop are
 *  otherwise identical to `card.ts`. */
export function dealFromRng(rand: Rng): Hands {
  const cards: Card[] = []
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      for (const copyId of [1, 2] as CopyId[]) cards.push(new Card(suit, rank, copyId))
    }
  }
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[cards[i], cards[j]] = [cards[j], cards[i]]
  }
  return SEATS.map((i) => cards.slice(i * 12, (i + 1) * 12)) as Hands
}

/** Round-level behaviour for one side, aggregated across a run. Mirrors
 *  `ab_harness.SideStats`, `conceded` included since #123 and `autoSet` since
 *  #178. A conceded contract counts in `contracts` and in `set` — it is a
 *  contract that was taken and not made, and rolling it into the set rate keeps
 *  "made %" answering the same question it did before folding existed.
 *
 *  `autoSet` is a subset of `conceded`, not a third outcome: an auto-SET *is* a
 *  concession, taken by arithmetic instead of by the fold model. It is counted
 *  separately because #178 asks how often the rule fires, and that frequency is
 *  more useful than the effect size — a rule that never triggers cannot matter
 *  however favourable its margin looks. It is counted on the arm where the rule
 *  is enabled; the control arm plays those hands out and reads 0. */
export interface SideStats {
  contracts: number
  made: number
  set: number
  conceded: number
  autoSet: number
  bids: number[]
}

export function newSideStats(): SideStats {
  return { contracts: 0, made: 0, set: 0, conceded: 0, autoSet: 0, bids: [] }
}

export interface GameResult {
  readonly winner: TeamId
  readonly scoresByTeam: Record<TeamId, number>
  readonly rounds: number
}

/** Collected only when a caller asks for it — the latency benchmark replays
 *  real auction positions rather than invented ones, since the cost of a bid
 *  decision depends on the hand and on how far the auction has run. */
export interface BidSituationSample {
  readonly player: PlayerIndex
  readonly hand: readonly Card[]
  readonly currentBid: number
  readonly context: AuctionContext
}

export interface HeadlessGameOptions {
  /** Skill level per seat. Two seats of one level and two of another is what
   *  makes this an A/B; the levels differ only in `SKILL_PARAMS`. */
  readonly seatSkills: Record<PlayerIndex, SkillLevel>
  /** Derives every deal in the game. Identical across the mirrored orientations
   *  of a pair. */
  readonly dealSeed: number
  /** Per-side round bookkeeping, keyed by team id, if the caller wants it. */
  readonly stats?: Record<TeamId, SideStats>
  /** Appended to, if supplied. See `BidSituationSample`. */
  readonly collectBidSituations?: BidSituationSample[]
}

/** Plays one complete game to the +/-1000 thresholds and reports who won. */
export function playHeadlessGame(options: HeadlessGameOptions): GameResult {
  const { seatSkills, dealSeed, stats, collectBidSituations } = options
  const scoresByTeam: Record<TeamId, number> = { 0: 0, 1: 0 }
  let dealer: PlayerIndex = 3

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // -- Deal, with the misdeal/reshuffle house rule ------------------------
    // GameFlow checks each seat in fixed order and auto-reshuffles for an
    // eligible AI seat. Every seat is an AI here, so the first eligible one
    // triggers a redeal. Each reshuffle gets its own derived seed so a redeal
    // is a genuinely different deal rather than the same one again.
    let hands: Hands = [[], [], [], []]
    for (let attempt = 0; attempt < 64; attempt++) {
      hands = dealFromRng(makeRng(mixSeed(dealSeed, round * 64 + attempt)))
      if (!SEATS.some((seat) => isMisdealEligible(hands[seat]))) break
    }

    // -- Auction -----------------------------------------------------------
    let state: AuctionState = initAuctionState(hands, dealer, SEAT_NAMES, scoresByTeam)
    let guard = 0
    while (state.phase === 'bidding' && guard++ < 100) {
      const turn = state.bidding.turn
      const context: AuctionContext = {
        everBid: state.bidding.everBid,
        passesSoFar: state.bidding.passes,
        bidHistory: state.bidding.bidHistory,
        dealer: state.dealer,
        scores: state.scoresByTeam,
        passedPlayers: passedPlayersOf(state.bidding.active),
      }
      if (collectBidSituations !== undefined) {
        collectBidSituations.push({
          player: turn,
          hand: state.hands[turn],
          currentBid: state.bidding.currentBid,
          context,
        })
      }
      const decision = chooseBid(
        turn,
        state.hands[turn],
        state.bidding.currentBid,
        MIN_INCREMENT,
        context,
        seatSkills[turn],
      )
      state =
        decision === null
          ? auctionReducer(state, { type: 'PASS_BID', player: turn })
          : auctionReducer(state, { type: 'BID', player: turn, amount: decision })
    }
    if (state.phase === 'bidding') throw new Error('auction did not settle')

    const bidWinner = state.bidWinner as PlayerIndex
    const bid = state.bid
    state = auctionReducer(state, {
      type: 'CHOOSE_TRUMP',
      player: bidWinner,
      suit: chooseTrump(state.hands[bidWinner], seatSkills[bidWinner]),
    })
    const trumpSuit = state.trumpSuit as Suit

    // -- The 3-card pass, both directions, then the reveal ------------------
    const partner = ((bidWinner + 2) % 4) as PlayerIndex
    state = auctionReducer(state, {
      type: 'PASS_CARDS',
      from: bidWinner,
      cards: choosePassCards(state.hands[bidWinner], PASS_COUNT, trumpSuit, true, seatSkills[bidWinner]),
    })
    state = auctionReducer(state, {
      type: 'PASS_CARDS',
      from: partner,
      cards: choosePassCards(state.hands[partner], PASS_COUNT, trumpSuit, false, seatSkills[partner]),
    })
    state = auctionReducer(state, { type: 'CONFIRM_PASS_REVEAL' })

    // -- Meld, then the concede window --------------------------------------
    const meldPoints = meldPointsByTeam(state.hands, trumpSuit)
    const bidWinnerTeam = teamOf(bidWinner)
    const defendingTeam = (1 - bidWinnerTeam) as TeamId

    // Asked of the bid winner only, once, after meld and before the first lead
    // — `Round._concede_phase`'s window in Python and `canConcede`'s in
    // `TrickPlayFlow`. The partner cannot concede a contract they did not take
    // and the defenders have nothing to concede.
    //
    // Auto-SET (#178) is tested first and short-circuits the model, exactly as
    // in `TrickPlayFlow` and `Round._concede_phase`: the contract is
    // unreachable by arithmetic, so there is nothing for a fitted probability
    // to add. Unlike the two of those this one is gated on `autoSetPolicy`,
    // which reads `'forced'` on every shipped level — the gate exists only so
    // `AUTO_SET_AB_POLICIES` can seat an arm without the rule and measure it.
    const params = SKILL_PARAMS[seatSkills[bidWinner]]
    // The condition is evaluated and counted whatever the policy says, so both
    // arms report the same statistic — "how often did this side take a contract
    // it could not reach", which is a property of the auction, not of the rule.
    // Only whether it *ends the round* is gated. A control arm that reported 0
    // would make the enabled arm's rate impossible to sanity-check.
    const autoSetCondition = isAutoSet(meldPoints[bidWinnerTeam], bid)
    const autoSet = params.autoSetPolicy === 'forced' && autoSetCondition
    const conceded =
      autoSet ||
      (params.foldPolicy === 'model' &&
        shouldConcede({
          hand: state.hands[bidWinner],
          trump: trumpSuit,
          bid,
          biddingMeld: meldPoints[bidWinnerTeam],
          defendingMeld: meldPoints[defendingTeam],
        }))

    if (conceded) {
      // Same scoring as `gameFlowReducer`'s TRICK_COMPLETE concede branch: the
      // bidding team forfeits its meld and takes -bid, the defenders keep their
      // meld and score no trick points because no trick was played.
      const roundScore = scoreRound({
        meldPointsByTeam: { ...meldPoints, [bidWinnerTeam]: 0 } as Record<TeamId, number>,
        trickPointsByTeam: { 0: 0, 1: 0 },
        bidWinnerTeam,
        bid,
      })
      if (stats !== undefined) {
        const side = stats[bidWinnerTeam]
        side.contracts++
        side.bids.push(bid)
        side.set++
        side.conceded++
        if (autoSetCondition) side.autoSet++
      }

      scoresByTeam[0] += roundScore[0]
      scoresByTeam[1] += roundScore[1]

      const winnerAfterConcede = checkGameOutcome(scoresByTeam, bidWinnerTeam)
      if (winnerAfterConcede !== null) {
        return { winner: winnerAfterConcede, scoresByTeam, rounds: round + 1 }
      }
      dealer = ((dealer + 1) % 4) as PlayerIndex
      continue
    }

    // -- Trick play, round score --------------------------------------------
    const tracker = new PlayTracker()
    // One capacity-limited trump view per seat (#157/#158), seeded from the
    // meld the other three seats have just laid face up. Built here rather than
    // inside `playTrickTakingPhase` because it is strategy input, like
    // `tracker`, not a rule — and built from `state.hands` because that is the
    // post-pass, post-meld hand the melds were scored from.
    const trumpMemories = newTrumpMemories(state.hands, trumpSuit, (seat) => seatSkills[seat])
    let cardsPlayed = 0
    const { trickPointsByTeam } = playTrickTakingPhase(
      state.hands,
      trumpSuit,
      bidWinner,
      (player, hand, legal, trick) => {
        const skill = seatSkills[player]
        // TrickPlayFlow's own conditions, with `trickNumber === 0` expressed as
        // "nothing has been played yet" since playTrickTakingPhase does not
        // hand the trick index to `chooseCard`.
        const isBidderFirstLead = cardsPlayed === 0 && player === bidWinner
        const card =
          trick.plays.length === 0
            ? chooseLeadCard(
                hand,
                trumpSuit,
                tracker,
                isBidderFirstLead,
                skill,
                teamOf(player) === teamOf(bidWinner),
                trumpMemories[player],
              )
            : chooseFollowCard(
                hand,
                legal,
                trick.plays,
                trumpSuit,
                teammatesOf(player),
                tracker,
                skill,
                trumpMemories[player],
              )
        tracker.record(card)
        // Everyone at the table sees the card, including whoever played it —
        // it has left their hand by then, so this cannot double-count against
        // the hand tally `isBoss` keeps separately.
        for (const seat of SEATS) trumpMemories[seat].see(card)
        cardsPlayed++
        return card
      },
    )

    const roundScore = scoreRound({ meldPointsByTeam: meldPoints, trickPointsByTeam, bidWinnerTeam, bid })
    if (stats !== undefined) {
      const side = stats[bidWinnerTeam]
      side.contracts++
      side.bids.push(bid)
      if (roundScore[bidWinnerTeam] < 0) side.set++
      else side.made++
      // Reached only when the rule is off for this side (it forces a concede
      // otherwise), so this counts the dead contracts the control arm played
      // out — the same statistic the enabled arm records above.
      if (autoSetCondition) side.autoSet++
    }

    scoresByTeam[0] += roundScore[0]
    scoresByTeam[1] += roundScore[1]

    const winner = checkGameOutcome(scoresByTeam, bidWinnerTeam)
    if (winner !== null) return { winner, scoresByTeam, rounds: round + 1 }

    dealer = ((dealer + 1) % 4) as PlayerIndex
  }

  throw new Error(`game did not finish in ${MAX_ROUNDS} rounds`)
}

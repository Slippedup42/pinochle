import { describe, expect, it } from 'vitest'
import { dealFromRng, makeRng } from '../ab/headlessGame'
import { Card, Deck, FORCED_BID, type Rank, Suit } from './card'
import {
  type ChooseCardFn,
  type Hands,
  MAX_TRICK_POINTS,
  findClaim,
  isAutoSet,
  partnerOf,
  playTrickTakingPhase,
  scoreRound,
  teamOf,
} from './round'
import { chooseFollowCard, chooseLeadCard, PlayTracker } from './tracker'
import { type PlayerIndex, Trick } from './trick'

/** The +10 the 12th trick carries, restated here rather than imported from
 *  round.ts (which does now export it, #218) — a test that reads the constant
 *  it is checking proves nothing. */
const LAST_TRICK_BONUS = 10

describe('teamOf', () => {
  it('pairs player 0 & 2 as team A (0), player 1 & 3 as team B (1)', () => {
    expect(teamOf(0)).toBe(0)
    expect(teamOf(2)).toBe(0)
    expect(teamOf(1)).toBe(1)
    expect(teamOf(3)).toBe(1)
  })
})

describe('partnerOf', () => {
  it('pairs seats two apart, onto the team teamOf reports', () => {
    expect(partnerOf(0)).toBe(2)
    expect(partnerOf(1)).toBe(3)
    expect(partnerOf(2)).toBe(0)
    expect(partnerOf(3)).toBe(1)
  })
})

describe('MAX_TRICK_POINTS (#178)', () => {
  it('derives to 250 — 24 counters at 10, plus the last-trick bonus', () => {
    expect(MAX_TRICK_POINTS).toBe(250)
  })

  it('equals what a full round actually distributes', () => {
    // The point of deriving it: the constant and the trick-scoring code must
    // not be able to disagree. `playTrickTakingPhase` below asserts the same
    // total from the other direction, by playing all 12 tricks out.
    const deck = new Deck()
    deck.shuffle()
    const { trickPointsByTeam } = playTrickTakingPhase(
      deck.deal() as Hands,
      Suit.Hearts,
      0,
      chooseFirstLegal,
    )
    expect(trickPointsByTeam[0] + trickPointsByTeam[1]).toBe(MAX_TRICK_POINTS)
  })

  it('is a different number from FORCED_BID even though both read 250', () => {
    // The collision #178 called out: these are equal today and mean unrelated
    // things. This test does not assert they differ, only that the two names
    // exist separately — if a future change moves one, the other must not
    // follow it by accident.
    expect(FORCED_BID).toBe(250)
    expect(MAX_TRICK_POINTS).toBe(250)
  })
})

describe('isAutoSet (#178)', () => {
  it('is true only when meld plus every trick point still falls short', () => {
    // 49 + 250 = 299 < 300: dead. 50 + 250 = 300: exactly reachable, so live.
    expect(isAutoSet(49, 300)).toBe(true)
    expect(isAutoSet(50, 300)).toBe(false)
    expect(isAutoSet(51, 300)).toBe(false)
  })

  it('treats an exactly-reachable contract as live, not dead', () => {
    // The boundary is `<`, not `<=`: needing every last trick point is a
    // contract that can be made, and the round has to be played to find out.
    expect(isAutoSet(150, 150 + MAX_TRICK_POINTS)).toBe(false)
    expect(isAutoSet(150, 150 + MAX_TRICK_POINTS + 1)).toBe(true)
  })

  it('is never true once meld alone covers the bid', () => {
    expect(isAutoSet(320, 300)).toBe(false)
  })
})

// Always plays the first legal card — mirrors the Python engine's
// placeholder `choose_card` fallback (legal_moves[0]), enough to drive a
// full round through without needing real trick-play strategy (out of
// scope for this port).
const chooseFirstLegal: ChooseCardFn = (_player, _hand, legalMoves) => legalMoves[0]

describe('playTrickTakingPhase', () => {
  it('plays all 12 tricks and distributes exactly 250 trick points total (incl. last-trick bonus)', () => {
    const deck = new Deck()
    deck.shuffle()
    const hands = deck.deal() as Hands

    const result = playTrickTakingPhase(hands, Suit.Spades, 0, chooseFirstLegal)

    expect(result.trickWinners).toHaveLength(12)
    const total = result.trickPointsByTeam[0] + result.trickPointsByTeam[1]
    expect(total).toBe(250)
  })

  it('does not mutate the hands passed in', () => {
    const deck = new Deck()
    deck.shuffle()
    const hands = deck.deal() as Hands
    const originalCounts = hands.map((h) => h.length)

    playTrickTakingPhase(hands, Suit.Spades, 0, chooseFirstLegal)

    expect(hands.map((h) => h.length)).toEqual(originalCounts)
  })

  it('the contract winner leads the first trick', () => {
    const deck = new Deck()
    deck.shuffle()
    const hands = deck.deal() as Hands

    let firstTrickLeader: number | undefined
    const recordingChoose: ChooseCardFn = (player, _hand, legalMoves, trick) => {
      if (trick.plays.length === 0 && firstTrickLeader === undefined) {
        firstTrickLeader = player
      }
      return legalMoves[0]
    }

    playTrickTakingPhase(hands, Suit.Diamonds, 2, recordingChoose)
    expect(firstTrickLeader).toBe(2)
  })

  it('the winner of each trick leads the next', () => {
    const deck = new Deck()
    deck.shuffle()
    const hands = deck.deal() as Hands

    const leaders: number[] = []
    const recordingChoose: ChooseCardFn = (player, _hand, legalMoves, trick) => {
      if (trick.plays.length === 0) leaders.push(player)
      return legalMoves[0]
    }

    const result = playTrickTakingPhase(hands, Suit.Clubs, 1, recordingChoose)
    // Every leader after the first should be the previous trick's winner.
    for (let i = 1; i < 12; i++) {
      expect(leaders[i]).toBe(result.trickWinners[i - 1])
    }
  })
})

describe('scoreRound', () => {
  it("scores the bidding team -bid when their total falls short (going set)", () => {
    const scores = scoreRound({
      meldPointsByTeam: { 0: 20, 1: 40 },
      trickPointsByTeam: { 0: 100, 1: 150 },
      bidWinnerTeam: 0,
      bid: 300,
    })
    // Team 0 (bidding): 20 + 100 = 120 < 300 -> goes set, scores -300.
    expect(scores[0]).toBe(-300)
    // Team 1 (defending) always keeps its own meld + trick points.
    expect(scores[1]).toBe(190)
  })

  it('scores the bidding team their actual total when they make the contract', () => {
    const scores = scoreRound({
      meldPointsByTeam: { 0: 150, 1: 10 },
      trickPointsByTeam: { 0: 160, 1: 90 },
      bidWinnerTeam: 0,
      bid: 300,
    })
    // Team 0: 150 + 160 = 310 >= 300 -> makes it, scores the real total.
    expect(scores[0]).toBe(310)
    expect(scores[1]).toBe(100)
  })

  it('the defending team scores their own total even if the bidder goes set', () => {
    const scores = scoreRound({
      meldPointsByTeam: { 0: 0, 1: 60 },
      trickPointsByTeam: { 0: 90, 1: 100 },
      bidWinnerTeam: 1,
      bid: 400,
    })
    // Team 1 (bidding): 60 + 100 = 160 < 400 -> goes set, scores -400.
    expect(scores[1]).toBe(-400)
    expect(scores[0]).toBe(90)
  })
})

describe('findClaim — "the rest are mine" (#208)', () => {
  const trump = Suit.Hearts
  const c = (suit: Suit, rank: Rank, copy: 1 | 2 = 1) => new Card(suit, rank, copy)
  const hands = (a: Card[], b: Card[], d: Card[], e: Card[]): Hands => [a, b, d, e]

  it('claims when the leader holds only trump and no one else holds any', () => {
    const claim = findClaim(
      hands(
        [c(Suit.Hearts, 'A'), c(Suit.Hearts, 'K')],
        [c(Suit.Spades, 'A'), c(Suit.Spades, 'K')],
        [c(Suit.Clubs, 'A'), c(Suit.Clubs, 'K')],
        [c(Suit.Diamonds, 'A'), c(Suit.Diamonds, 'K')],
      ),
      trump,
      0,
    )
    expect(claim).not.toBeNull()
    expect(claim?.claimer).toBe(0)
    expect(claim?.tricks).toBe(2)
    // Every card left is a counter (8 x 10) plus the last-trick bonus.
    expect(claim?.trickPoints).toBe(90)
  })

  it('claims on unbeatable side cards too, which is why this is not a trump rule', () => {
    // Nobody holds trump at all, and the leader's two Aces cannot be beaten.
    const claim = findClaim(
      hands(
        [c(Suit.Spades, 'A'), c(Suit.Clubs, 'A')],
        [c(Suit.Spades, 'K'), c(Suit.Clubs, 'K')],
        [c(Suit.Spades, 'Q'), c(Suit.Clubs, 'Q')],
        [c(Suit.Spades, 'J'), c(Suit.Clubs, 'J')],
      ),
      trump,
      0,
    )
    expect(claim).not.toBeNull()
    expect(claim?.tricks).toBe(2)
  })

  it('claims on the second copy of a rank, because ties go to the card led', () => {
    // The other Ace of Spades is still out, but the claimer leads and
    // `Trick.winner` gives an equal rank to whoever played first.
    const claim = findClaim(
      hands(
        [c(Suit.Spades, 'A', 1), c(Suit.Clubs, 'A')],
        [c(Suit.Spades, 'A', 2), c(Suit.Clubs, 'K')],
        [c(Suit.Spades, 'Q'), c(Suit.Clubs, 'Q')],
        [c(Suit.Spades, 'J'), c(Suit.Clubs, 'J')],
      ),
      trump,
      0,
    )
    expect(claim).not.toBeNull()
  })

  it('refuses all-the-trump-plus-a-beatable-side-card, the case the literal rule got wrong', () => {
    // Seat 0 holds every trump left *and* a low club. It wins the trump trick
    // and then has to lead the club into a higher one. Measured over 3000
    // hands, this shape is why the literal reading misawarded 906 times.
    const claim = findClaim(
      hands(
        [c(Suit.Hearts, 'A'), c(Suit.Clubs, '9')],
        [c(Suit.Clubs, 'A'), c(Suit.Spades, 'K')],
        [c(Suit.Clubs, 'K'), c(Suit.Spades, 'Q')],
        [c(Suit.Clubs, 'Q'), c(Suit.Spades, 'J')],
      ),
      trump,
      0,
    )
    expect(claim).toBeNull()
  })

  it('refuses when the partner holds trump, since the partner can win and then lead', () => {
    // Same team, but not every trick: seat 2 must overtrump seat 0's King with
    // the Ace (rule 3), which puts seat 2 on lead holding a beatable club.
    const claim = findClaim(
      hands(
        [c(Suit.Hearts, 'K'), c(Suit.Hearts, 'Q')],
        [c(Suit.Spades, 'A'), c(Suit.Spades, 'K')],
        [c(Suit.Hearts, 'A'), c(Suit.Clubs, '9')],
        [c(Suit.Diamonds, 'A'), c(Suit.Diamonds, 'K')],
      ),
      trump,
      0,
    )
    expect(claim).toBeNull()
  })

  it('refuses a seat that is not on lead', () => {
    const h = hands(
      [c(Suit.Hearts, 'A'), c(Suit.Hearts, 'K')],
      [c(Suit.Spades, 'A'), c(Suit.Spades, 'K')],
      [c(Suit.Clubs, 'A'), c(Suit.Clubs, 'K')],
      [c(Suit.Diamonds, 'A'), c(Suit.Diamonds, 'K')],
    )
    expect(findClaim(h, trump, 0)).not.toBeNull()
    expect(findClaim(h, trump, 1)).toBeNull()
  })

  it('refuses with one trick left — there is nothing to skip', () => {
    const claim = findClaim(
      hands([c(Suit.Hearts, 'A')], [c(Suit.Spades, 'A')], [c(Suit.Clubs, 'A')], [c(Suit.Diamonds, 'A')]),
      trump,
      0,
    )
    expect(claim).toBeNull()
  })

  it('refuses mid-trick, when the hands are uneven', () => {
    const claim = findClaim(
      hands(
        [c(Suit.Hearts, 'A'), c(Suit.Hearts, 'K')],
        [c(Suit.Spades, 'A')],
        [c(Suit.Clubs, 'A'), c(Suit.Clubs, 'K')],
        [c(Suit.Diamonds, 'A'), c(Suit.Diamonds, 'K')],
      ),
      trump,
      0,
    )
    expect(claim).toBeNull()
  })
})

describe('a claim awards exactly what playing it out would have (#208)', () => {
  // The property the whole feature rests on, and the reason the rule is allowed
  // to live outside the parity-checked engine loop: `findClaim` is safe only
  // because it never changes a result. So this plays real deals with the real
  // AI and checks, every time the rule fires, that the claiming seat did in
  // fact win every remaining trick and that the points match exactly.
  //
  // A played-out control rather than two runs compared, because a game with the
  // claim applied and one without are not the same state to re-run — this way
  // the assertion is against what actually happened at the table.
  it('the claimer wins every skipped trick, on 1500 dealt hands', () => {
    const rand = makeRng(0x2082026)
    let fired = 0
    let tricksSkipped = 0

    for (let g = 0; g < 1500; g++) {
      const dealt = dealFromRng(rand)
      const trumpSuit = [Suit.Spades, Suit.Hearts, Suit.Clubs, Suit.Diamonds][Math.floor(rand() * 4)]
      const working = dealt.map((h) => [...h]) as Hands
      const tracker = new PlayTracker()
      let leader: PlayerIndex = 0
      let claimed: { claimer: PlayerIndex; points: number; fromTrick: number } | null = null
      let pointsAfterClaim = 0

      for (let t = 0; t < 12; t++) {
        if (claimed === null) {
          const claim = findClaim(working, trumpSuit, leader)
          if (claim !== null) {
            claimed = { claimer: claim.claimer, points: claim.trickPoints, fromTrick: t }
            fired++
            tricksSkipped += claim.tricks
          }
        }

        const trick = new Trick(trumpSuit)
        let p = leader
        for (let seat = 0; seat < 4; seat++) {
          const legal = trick.legalMoves(working[p])
          const card =
            seat === 0
              ? chooseLeadCard(working[p], trumpSuit, tracker, false, 'expert', undefined, undefined)
              : chooseFollowCard(
                  working[p],
                  legal,
                  trick.plays,
                  trumpSuit,
                  [p, ((p + 2) % 4) as PlayerIndex],
                  tracker,
                  'expert',
                  undefined,
                )
          working[p].splice(
            working[p].findIndex((x) => x.equals(card)),
            1,
          )
          trick.play(p, card)
          tracker.record(card)
          p = ((p + 1) % 4) as PlayerIndex
        }
        const winner = trick.winner()

        if (claimed !== null && t >= claimed.fromTrick) {
          // The claim said this seat takes it. It must.
          expect(winner).toBe(claimed.claimer)
          pointsAfterClaim += trick.points() + (t === 11 ? LAST_TRICK_BONUS : 0)
        }
        leader = winner
      }

      if (claimed !== null) {
        // ...and the points awarded must equal the points actually collected.
        expect(pointsAfterClaim).toBe(claimed.points)
      }
    }

    // Guard against the assertions above passing vacuously.
    expect(fired).toBeGreaterThan(200)
    expect(tricksSkipped).toBeGreaterThan(500)
  })
})

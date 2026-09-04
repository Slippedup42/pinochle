import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SHIPPED_SKILL, SKILL_LEVELS, SKILL_PARAMS, type SkillLevel, type SkillParams } from './skills'
import { Card, Deck, GAME_WIN_SCORE, OPENING_BID, Suit, SUITS } from './card'
import {
  ACE_VALUE,
  type AuctionContext,
  bestBaseBid,
  chooseBid,
  chooseTrump,
  computeBaseBid,
  computeCompetitiveAdjustment,
  computeMaxBid,
  computeTrickPotential,
  ENDGAME_OPP_SCORE_CAP,
  ENDGAME_RESCUE_CEILING,
  ENDGAME_SCORE_FLOOR,
  EXTRA_TRUMP_VALUE,
  LOOSE_KING_VALUE,
  LOOSE_QUEEN_VALUE,
  NEAR_DOUBLE_PINOCHLE_VALUE,
  NEAR_RUN_VALUE,
  OPENER_THRESHOLD,
  PARTNER_PASSED_FLOOR,
  PARTNER_RAISE_FLOOR,
  PINOCHLE_NO_KING_OF_SPADES_BONUS,
  PROTECTED_TEN_VALUE,
  THIRD_BIDDER_FLOOR,
  TRUMP_ACE_VALUE,
} from './bidding'
import { PINOCHLE_DOUBLE_VALUE, ROYAL_MARRIAGE_VALUE, scoreMelds } from './melds'
import { partnerOf } from './round'
import type { PlayerIndex } from './trick'

const trump = Suit.Spades
const RUN_RANKS = ['A', '10', 'K', 'Q', 'J'] as const

/**
 * Two level slots carrying the arms this file needs, installed for its lifetime.
 *
 * Most of what is tested below is the *static* rules — `OPENER_THRESHOLD`,
 * `PARTNER_PASSED_FLOOR`, `THIRD_BIDDER_FLOOR`, the endgame bands. They only
 * decide an opening when the seat is on `bidPolicy: 'static'`; on the distilled
 * one the evaluator answers first and the threshold is never asked. `'medium'`
 * was that seat, and `'easy'` was the `handValuation: 'meld_only'` seat.
 *
 * #222 collapsed the dial, so both names became the shipped configuration and
 * every one of these tests would have gone on passing while quietly asserting
 * something else — the failure mode #261 and #263 are about. Installing the two
 * arms explicitly says which rule each test is aimed at, and the save/restore is
 * the same shape `abRun.installPolicies` uses.
 *
 * Everything not named here runs `SHIPPED_SKILL`, which is what a player meets.
 */
const STATIC_LEVEL: SkillLevel = 'medium'
const MELD_ONLY_LEVEL: SkillLevel = 'easy'
const pristine: Partial<Record<SkillLevel, SkillParams>> = {}
beforeAll(() => {
  pristine[STATIC_LEVEL] = SKILL_PARAMS[STATIC_LEVEL]
  pristine[MELD_ONLY_LEVEL] = SKILL_PARAMS[MELD_ONLY_LEVEL]
  SKILL_PARAMS[STATIC_LEVEL] = { ...SKILL_PARAMS[STATIC_LEVEL], bidPolicy: 'static' }
  SKILL_PARAMS[MELD_ONLY_LEVEL] = {
    ...SKILL_PARAMS[MELD_ONLY_LEVEL],
    handValuation: 'meld_only',
    bidPolicy: 'static',
  }
})
afterAll(() => {
  SKILL_PARAMS[STATIC_LEVEL] = pristine[STATIC_LEVEL] as SkillParams
  SKILL_PARAMS[MELD_ONLY_LEVEL] = pristine[MELD_ONLY_LEVEL] as SkillParams
})

describe('computeBaseBid', () => {
  it('scores a full trump Run at 150, absorbing its Royal Marriage, and nothing else', () => {
    // The rule (#273): a meld pays on top of a Run only if it needs a card the
    // Run does not use, and the trump K+Q needs nothing the Run has not already
    // consumed. So a bare Run is 150, not 190. This line read 210 between #242
    // and #273, when the marriage inside the run was paid twice over, and 170
    // until #277 moved the trump Ace's flat 20 out of the Base Bid.
    const hand = RUN_RANKS.map((r) => new Card(trump, r, 1))
    const { total, breakdown } = computeBaseBid(hand, trump)
    expect(breakdown['Run/near-run']).toBe(150)
    expect(breakdown['Royal Marriage']).toBeUndefined()
    expect(breakdown['Aces (flat, 20/ea)']).toBeUndefined()
    expect(total).toBe(150)

    // The 20 did not vanish; it moved, and doubled on the way, because the
    // trump Ace now collects the flat Ace line and the Ace-of-trump line both.
    const { breakdown: trick } = computeTrickPotential(hand, trump)
    expect(trick['Aces (flat, 20/ea)']).toBe(ACE_VALUE)
    expect(trick['Ace of trump']).toBe(TRUMP_ACE_VALUE)
  })

  it('credits a near-run (missing exactly one rank) at 120', () => {
    const hand = RUN_RANKS.filter((r) => r !== 'J').map((r) => new Card(trump, r, 1))
    const { breakdown } = computeBaseBid(hand, trump)
    expect(breakdown['Run/near-run']).toBe(NEAR_RUN_VALUE)
  })

  it('does not credit near-run when missing two or more ranks', () => {
    const hand = [new Card(trump, 'A', 1), new Card(trump, '10', 1), new Card(trump, 'K', 1)]
    const { breakdown } = computeBaseBid(hand, trump)
    expect(breakdown['Run/near-run']).toBeUndefined()
  })

  it('scores a Double Run at 1500 and claims all cards from the pool', () => {
    const hand = RUN_RANKS.flatMap((r) => [new Card(trump, r, 1), new Card(trump, r, 2)])
    const { breakdown, pool } = computeBaseBid(hand, trump)
    expect(breakdown['Run/near-run']).toBe(1500)
    expect(pool).toHaveLength(0)
  })

  it('credits the second Royal Marriage when a Run and a spare K/Q are both held', () => {
    // The other half of the rule (#273): a *second* K+Q needs a second King and
    // a second Queen, which the Run has not used, so it pays. One marriage, not
    // two - this asserted 80 between #242 and #273.
    const hand = [
      ...RUN_RANKS.map((r) => new Card(trump, r, 1)),
      new Card(trump, 'K', 2),
      new Card(trump, 'Q', 2),
    ]
    const { breakdown } = computeBaseBid(hand, trump)
    expect(breakdown['Run/near-run']).toBe(150)
    expect(breakdown['Royal Marriage']).toBe(ROYAL_MARRIAGE_VALUE)
  })

  it('credits the Royal Marriage at full value when there is no run at all', () => {
    const hand = [new Card(trump, 'K', 1), new Card(trump, 'Q', 1)]
    const { breakdown } = computeBaseBid(hand, trump)
    expect(breakdown['Royal Marriage']).toBe(40)
    expect(breakdown['Run/near-run']).toBeUndefined()
  })

  // -- the valuation must price certain meld at exactly what the scorer pays --
  //
  // #242 found this disagreement and resolved it the wrong way, by moving the
  // valuation up to a scorer that was itself wrong; #273 moves the scorer down
  // and the valuation back. What survives both is the shape: what these check
  // is *agreement with `scoreMelds`*, not either number alone. The two are
  // supposed to describe the same cards, and the moment they stop doing so is
  // the moment the AI is bidding against a hand it does not have.
  describe('agrees with scoreMelds about certain meld (#273)', () => {
    // Sum of the Base Bid lines that describe *held* meld. `Aces (flat)` and
    // the 3-different-aces bonus are trick-taking estimates, not meld, and the
    // near-run / near-double-pinochle lines are speculative — so these cases
    // are all built to hold neither.
    const MELD_LINES = [
      'Run/near-run',
      'Royal Marriage',
      'Common Marriage',
      'Dix',
      'Pinochle/near-double',
      'Arounds',
    ]
    const meldPortion = (breakdown: Record<string, number>): number =>
      MELD_LINES.reduce((sum, key) => sum + (breakdown[key] ?? 0), 0)

    const cases: ReadonlyArray<[string, Card[], number]> = [
      ['a bare trump Run', RUN_RANKS.map((r) => new Card(trump, r, 1)), 150],
      [
        'a Run plus a second Royal Marriage',
        [
          ...RUN_RANKS.map((r) => new Card(trump, r, 1)),
          new Card(trump, 'K', 2),
          new Card(trump, 'Q', 2),
        ],
        150 + 40,
      ],
      // A Double Run uses both copies of the trump King and both of the Queen,
      // so there is no K+Q pair left outside it: 1500 flat, not 1540 and not
      // #242's 1580.
      [
        'a Double Run',
        RUN_RANKS.flatMap((r) => [new Card(trump, r, 1), new Card(trump, r, 2)]),
        1500,
      ],
    ]

    for (const [name, hand, expected] of cases) {
      it(`values ${name} at what the scorer pays for it`, () => {
        const { breakdown } = computeBaseBid(hand, trump)
        const { total: melded } = scoreMelds(hand, trump)
        expect(meldPortion(breakdown)).toBe(melded)
        expect(melded).toBe(expected)
      })
    }

    it('leaves the near-run branch alone, which is a separate call site', () => {
      // The rule applied to a run that is not there yet. NEAR_RUN_VALUE is a
      // guess at a run that is *not* in hand, and the run it imagines would
      // take a K and a Q with it, so only the second marriage is credited -
      // while the scorer, seeing no run, pays both. They disagree on purpose,
      // and #268 ruled this branch correct as it stands. Four run ranks and two
      // K/Q pairs: the valuation credits 120 + one marriage, the scorer pays
      // two marriages and no run.
      const hand = [
        ...RUN_RANKS.filter((r) => r !== 'A').map((r) => new Card(trump, r, 1)),
        new Card(trump, 'K', 2),
        new Card(trump, 'Q', 2),
      ]
      const { breakdown } = computeBaseBid(hand, trump)
      expect(breakdown['Run/near-run']).toBe(NEAR_RUN_VALUE)
      expect(breakdown['Royal Marriage']).toBe(ROYAL_MARRIAGE_VALUE)
      expect(scoreMelds(hand, trump).total).toBe(2 * ROYAL_MARRIAGE_VALUE)
    })
  })

  it('credits near-double-pinochle at 225 for 3 of the 4 pieces', () => {
    const hand = [
      new Card(Suit.Spades, 'Q', 1),
      new Card(Suit.Spades, 'Q', 2),
      new Card(Suit.Diamonds, 'J', 1),
    ]
    const { breakdown } = computeBaseBid(hand, Suit.Hearts)
    expect(breakdown['Pinochle/near-double']).toBe(NEAR_DOUBLE_PINOCHLE_VALUE)
  })

  it('holds no Ace line at all — the Base Bid is meld only (#277)', () => {
    // This used to assert that the flat Aces line was present and zero. #277
    // moved every Ace to `computeTrickPotential`, so the Base Bid of a hand
    // with no meld is an empty breakdown rather than one zero entry.
    const hand = [new Card(Suit.Hearts, '9', 1)] // non-trump 9: no Dix, no melds at all
    const { breakdown, total } = computeBaseBid(hand, trump)
    expect(breakdown['Aces (flat, 20/ea)']).toBeUndefined()
    expect(total).toBe(0)
  })

  it('no longer pays a 3-different-aces bonus, and values Aces the same in every trump (#277)', () => {
    // Deleted outright. It paid `trump === Hearts || Clubs ? 60 : 50`, and no
    // rule of pinochle makes three Aces worth more when hearts are trump than
    // when spades are; nothing in the repo ever explained the asymmetry.
    // The second half of this is the part worth keeping: three off-trump Aces
    // are now worth exactly the same in all four trumps, which is what the
    // asymmetry denied.
    const threeAces = [
      new Card(Suit.Diamonds, 'A', 1),
      new Card(Suit.Clubs, 'A', 1),
      new Card(Suit.Hearts, 'A', 1),
    ]
    for (const suit of SUITS) {
      const { breakdown, total } = computeBaseBid(threeAces, suit)
      expect(breakdown['3 different Aces bonus']).toBeUndefined()
      expect(total).toBe(0)
    }

    // Aces in suits that are trump in neither reading are now worth the same in
    // both, which is what the asymmetry denied. (An Ace *of* trump is still
    // worth more, deliberately, and that is the next test.)
    const twoOffAces = [new Card(Suit.Diamonds, 'A', 1), new Card(Suit.Clubs, 'A', 1)]
    expect(computeTrickPotential(twoOffAces, Suit.Spades).total).toBe(
      computeTrickPotential(twoOffAces, Suit.Hearts).total,
    )
  })

  it('adds 20 to a pinochle hand holding no King of Spades, once and not per copy (#277)', () => {
    // The reasoning: a Queen of Spades that no spade marriage is asking for is
    // a freer pinochle card. Paid once for the hand, because the reason is
    // about the absent King and there is only one absence.
    const single = [new Card(Suit.Spades, 'Q', 1), new Card(Suit.Diamonds, 'J', 1)]
    expect(computeBaseBid(single, trump).breakdown['Pinochle (no King of Spades)']).toBe(
      PINOCHLE_NO_KING_OF_SPADES_BONUS,
    )

    const double = [
      new Card(Suit.Spades, 'Q', 1),
      new Card(Suit.Spades, 'Q', 2),
      new Card(Suit.Diamonds, 'J', 1),
      new Card(Suit.Diamonds, 'J', 2),
    ]
    expect(computeBaseBid(double, trump).breakdown['Pinochle/near-double']).toBe(PINOCHLE_DOUBLE_VALUE)
    expect(computeBaseBid(double, trump).breakdown['Pinochle (no King of Spades)']).toBe(
      PINOCHLE_NO_KING_OF_SPADES_BONUS,
    )

    // One King of Spades anywhere in the hand and the bonus is gone.
    const withKing = [...single, new Card(Suit.Spades, 'K', 1)]
    expect(computeBaseBid(withKing, trump).breakdown['Pinochle (no King of Spades)']).toBeUndefined()

    // And it is a *pinochle* bonus: no pinochle, no bonus, however many
    // Queens of Spades are sitting there on their own.
    const noPinochle = [new Card(Suit.Spades, 'Q', 1), new Card(Suit.Spades, 'Q', 2)]
    expect(computeBaseBid(noPinochle, trump).breakdown['Pinochle (no King of Spades)']).toBeUndefined()
  })
})

// -- computeTrickPotential (#277) -------------------------------------------
//
// Each rule on its own, so the intent is pinned rather than inferred from a
// total. `trump` is Hearts throughout; every fixture is built small enough that
// only the rule under test can fire.
describe('computeTrickPotential', () => {
  it('pays 20 for every Ace, in any suit', () => {
    // No trump Ace here, so the flat line is the whole of it.
    const hand = [
      new Card(Suit.Hearts, 'A', 1),
      new Card(Suit.Clubs, 'A', 1),
      new Card(Suit.Clubs, 'A', 2),
    ]
    const { breakdown, total } = computeTrickPotential(hand, trump)
    expect(breakdown['Aces (flat, 20/ea)']).toBe(3 * ACE_VALUE)
    expect(total).toBe(3 * ACE_VALUE)
  })

  it('pays a trump Ace twice — the flat Ace and the Ace of trump — so it is worth 40', () => {
    // Paul kept the two as separate rules, and the card really is doing two
    // jobs: a certain trick like any Ace, and control of the trump suit. Both
    // copies count.
    const one = [new Card(trump, 'A', 1)]
    const { breakdown, total } = computeTrickPotential(one, trump)
    expect(breakdown['Aces (flat, 20/ea)']).toBe(ACE_VALUE)
    expect(breakdown['Ace of trump']).toBe(TRUMP_ACE_VALUE)
    expect(total).toBe(ACE_VALUE + TRUMP_ACE_VALUE)

    const both = [new Card(trump, 'A', 1), new Card(trump, 'A', 2)]
    expect(computeTrickPotential(both, trump).total).toBe(2 * (ACE_VALUE + TRUMP_ACE_VALUE))

    // The same Ace in a suit that is not trump is worth half of that.
    expect(computeTrickPotential([new Card(Suit.Hearts, 'A', 1)], trump).total).toBe(ACE_VALUE)
  })

  it('pays 20 for each trump card beyond the fourth, and nothing at four or fewer', () => {
    const nines = (n: number) =>
      Array.from({ length: n }, (_, i) => new Card(trump, i < 2 ? '9' : 'J', i % 2 === 0 ? 1 : 2))
    expect(computeTrickPotential(nines(4), trump).breakdown['Trump length (beyond 4)']).toBeUndefined()
    expect(computeTrickPotential(nines(6), trump).breakdown['Trump length (beyond 4)']).toBe(
      2 * EXTRA_TRUMP_VALUE,
    )
  })

  it('pays 20 for a 10 standing behind both Aces of its suit, and nothing for one Ace', () => {
    // The valuation counterpart of #276's pass rule, reading the same
    // predicate out of handShape.ts so the two cannot drift apart.
    const bothAces = [
      new Card(Suit.Hearts, 'A', 1),
      new Card(Suit.Hearts, 'A', 2),
      new Card(Suit.Hearts, '10', 1),
    ]
    expect(computeTrickPotential(bothAces, trump).breakdown['10 behind both Aces']).toBe(PROTECTED_TEN_VALUE)

    const oneAce = [new Card(Suit.Hearts, 'A', 1), new Card(Suit.Hearts, '10', 1)]
    expect(computeTrickPotential(oneAce, trump).breakdown['10 behind both Aces']).toBeUndefined()

    // A trump 10 is a Run card and is priced by the Base Bid, not here.
    const trumpTen = [new Card(trump, 'A', 1), new Card(trump, 'A', 2), new Card(trump, '10', 1)]
    expect(computeTrickPotential(trumpTen, trump).breakdown['10 behind both Aces']).toBeUndefined()
  })

  it('pays 30 for an unmarried King and 20 for an unmarried Queen, off trump only', () => {
    const loose = [new Card(Suit.Hearts, 'K', 1), new Card(Suit.Clubs, 'Q', 1)]
    const { breakdown } = computeTrickPotential(loose, trump)
    expect(breakdown['Unmarried Kings']).toBe(LOOSE_KING_VALUE)
    expect(breakdown['Unmarried Queens']).toBe(LOOSE_QUEEN_VALUE)

    // Married: the Common Marriage line in the Base Bid has already paid.
    const married = [new Card(Suit.Hearts, 'K', 1), new Card(Suit.Hearts, 'Q', 1)]
    expect(computeTrickPotential(married, trump).total).toBe(0)

    // Trump honours: priced by the Run and Royal Marriage lines instead.
    const trumpHonours = [new Card(trump, 'K', 1), new Card(trump, 'Q', 2)]
    expect(computeTrickPotential(trumpHonours, trump).total).toBe(0)
  })

  it('reads "unmarried" as a property of the suit, so a spare King behind a Queen is not loose', () => {
    // Paul's wording is "no matching Q/K in the same suit", which is a test on
    // the suit and not on the individual card. K-K-Q of one suit therefore
    // pays the Common Marriage and nothing here. Recorded because the other
    // reading — count the surplus honours — is defensible too and would pay 30,
    // and this is the one place the two differ.
    const spare = [
      new Card(Suit.Hearts, 'K', 1),
      new Card(Suit.Hearts, 'K', 2),
      new Card(Suit.Hearts, 'Q', 1),
    ]
    expect(computeTrickPotential(spare, trump).total).toBe(0)
  })

  it('is silent rather than zero on every line that does not fire', () => {
    expect(computeTrickPotential([new Card(Suit.Hearts, '9', 1)], trump)).toEqual({
      total: 0,
      breakdown: {},
    })
  })
})

describe('computeCompetitiveAdjustment', () => {
  it('defaults to the +130 baseline', () => {
    const { value, breakdown } = computeCompetitiveAdjustment([], trump)
    expect(value).toBe(130)
    expect(breakdown['Competitive adj (baseline)']).toBe(130)
  })

  it('gives +160 when behind by 600 or more', () => {
    const { value, breakdown } = computeCompetitiveAdjustment([], trump, 0, 600)
    expect(value).toBe(160)
    expect(breakdown['Competitive adj (behind 600+ / Run+AcesAround double-payoff)']).toBe(160)
  })

  it('gives +160 for the Run+AcesAround double-payoff shape even when not behind', () => {
    const hand = [
      new Card(trump, '10', 1),
      new Card(trump, 'K', 1),
      new Card(trump, 'Q', 1),
      new Card(trump, 'J', 1),
      new Card(Suit.Diamonds, 'A', 1),
      new Card(Suit.Clubs, 'A', 1),
      new Card(Suit.Hearts, 'A', 1),
    ]
    const { value } = computeCompetitiveAdjustment(hand, trump, 0, 0)
    expect(value).toBe(160)
  })

  it('gives +100 when close to winning and the opponent is far behind', () => {
    const { value, breakdown } = computeCompetitiveAdjustment([], trump, 750, 400)
    expect(value).toBe(100)
    expect(breakdown['Competitive adj (closing out the game)']).toBe(100)
  })
})

// -- No ceiling on the ceiling (#283) ---------------------------------------
//
// This block replaces the three `maxBid` / `cappedBid` cases that pinned the
// 400 cap and the >300-meld exemption that let a few hands past it. They are
// deleted because the behaviour they described is gone, not because they went
// red: there is no longer a number for them to assert.
describe('the ceiling is not capped (#283)', () => {
  it('lets an ordinary hand value above 400 instead of stopping there', () => {
    // A trump Run, a second Royal Marriage and an off-suit Ace. Its guaranteed
    // meld is nowhere near the 300 the old exemption wanted, so this is exactly
    // the hand the cap used to bind: worth 440 and allowed to say 400.
    const hand = [
      ...RUN_RANKS.map((r) => new Card(Suit.Hearts, r, 1)),
      new Card(Suit.Hearts, 'K', 2),
      new Card(Suit.Hearts, 'Q', 2),
      new Card(Suit.Spades, 'A', 1),
    ]
    expect(scoreMelds(hand, Suit.Hearts).total).toBeLessThan(300)
    const { trump: t, total } = bestBaseBid(hand)
    expect(total).toBeGreaterThan(400)
    expect(total).toBe(computeMaxBid(hand, t, 0, 0).total)
  })

  it('gives a hand holding a Double Run no ceiling at all', () => {
    // The shape the cap was wrong about. A Double Run melds 1500 — more than
    // the whole game — but only if this hand names trump, so it has to be able
    // to keep bidding until it wins the auction. Asserted against the meld
    // rather than against a literal ceiling, because the ceiling is a sum of
    // three stages that have each moved under this file before.
    const hand = [
      ...RUN_RANKS.flatMap((r) => [new Card(Suit.Hearts, r, 1), new Card(Suit.Hearts, r, 2)]),
      new Card(Suit.Spades, '9', 1),
      new Card(Suit.Clubs, '9', 1),
    ]
    const doubleRunMeld = scoreMelds(hand, Suit.Hearts).total
    expect(doubleRunMeld).toBe(1500)
    const { trump: t, total } = bestBaseBid(hand)
    expect(t).toBe(Suit.Hearts)
    expect(total).toBeGreaterThanOrEqual(doubleRunMeld)
    expect(total).toBe(computeMaxBid(hand, Suit.Hearts, 0, 0).total)
  })
})

describe('bestBaseBid', () => {
  it('picks the trump suit with the highest ceiling', () => {
    const hand = [
      ...RUN_RANKS.map((r) => new Card(Suit.Hearts, r, 1)),
      new Card(Suit.Spades, '9', 1),
      new Card(Suit.Diamonds, '9', 1),
    ]
    const { trump: bestTrump } = bestBaseBid(hand)
    expect(bestTrump).toBe(Suit.Hearts)
  })

  it('matches computeMaxBid exactly for the winning trump', () => {
    const hand = [new Card(Suit.Clubs, 'K', 1), new Card(Suit.Clubs, 'Q', 1), new Card(Suit.Diamonds, 'A', 1)]
    const { trump: bestTrump, total } = bestBaseBid(hand, 100, 50)
    expect(total).toBe(computeMaxBid(hand, bestTrump, 100, 50).total)
  })
})

describe('chooseTrump', () => {
  it('picks the same trump bestBaseBid would', () => {
    const hand = [
      ...RUN_RANKS.map((r) => new Card(Suit.Hearts, r, 1)),
      new Card(Suit.Spades, '9', 1),
      new Card(Suit.Diamonds, '9', 1),
    ]
    expect(chooseTrump(hand)).toBe(Suit.Hearts)
  })
})

describe('chooseBid', () => {
  // Weak hand: a lone off-trump 9. Ceiling stays well under
  // OPENER_THRESHOLD no matter which suit bestBaseBid picks as trump.
  const weakHand = [new Card(Suit.Hearts, '9', 1)]

  // The "good but not good enough" fixture: ceiling 310 at the default 0/0
  // score adjustment. Below OPENER_THRESHOLD (320), below the 330 the
  // competitive branch relaxes to once a partner has bid, and comfortably over
  // THIRD_BIDDER_FLOOR and DEFENSIVE_PUSH_FLOOR (200 each). Two Royal Marriages
  // and the Dix (90 of Base Bid), an off Ace, six trump and one unmarried King
  // (90 of trick potential), + the 130 baseline.
  //
  // Its history is a warning about pinning a hand to a threshold, and about
  // making the hand small to make the arithmetic easy. It was a bare trump Run
  // until #242 paid the marriage inside the run and carried it over the
  // threshold; it became a near-run with a second trump K/Q, which #273 left
  // alone; and #277 took that over the threshold in turn, because six trump now
  // pay 40 for the two cards past the fourth. What forced a full twelve cards
  // is the "distilled takes it, static passes" test below: the evaluator reads
  // `trump_length` and `longest_side_suit` heavily, so a six-card fixture reads
  // to it as a hopeless hand whatever its ceiling says, and after #277 a search
  // of 4000 short hands found no sub-threshold hand it would open at all. A
  // real dealt hand is the honest fixture for a question about a real auction.
  // `ceilingOf` derives the band below before anything asserts behaviour, which
  // is what caught this the last two times.
  const belowOpenerHand = [
    new Card(Suit.Hearts, 'K', 1),
    new Card(Suit.Hearts, 'K', 2),
    new Card(Suit.Hearts, 'Q', 1),
    new Card(Suit.Hearts, 'Q', 2),
    new Card(Suit.Hearts, '10', 1),
    new Card(Suit.Hearts, '9', 1),
    new Card(Suit.Clubs, 'K', 1),
    new Card(Suit.Clubs, 'J', 1),
    new Card(Suit.Clubs, '9', 1),
    new Card(Suit.Spades, 'A', 1),
    new Card(Suit.Spades, '9', 1),
    new Card(Suit.Diamonds, '9', 1),
  ]

  // Base Bid 190 (Run 150 + the second Royal Marriage 40) + 100 of trick
  // potential (the trump Ace at 40, three trump past the fourth at 60) ->
  // 420, capped to 400. Clears both OPENER_THRESHOLD (320) and the 340
  // raise-support gate with room to spare, which is all this fixture is for;
  // nothing asserts its exact value. It read 340 before #277.
  const strongHand = [
    ...RUN_RANKS.map((r) => new Card(Suit.Hearts, r, 1)),
    new Card(Suit.Hearts, 'K', 2),
    new Card(Suit.Hearts, 'Q', 2),
  ]

  const baseContext = (overrides: Partial<AuctionContext> = {}): AuctionContext => ({
    everBid: false,
    passesSoFar: 0,
    bidHistory: [],
    dealer: 2,
    scores: { 0: 0, 1: 0 },
    passedPlayers: [],
    ...overrides,
  })

  /** The Max Bid ceiling `chooseBid` works from, at level scores. #255's
   *  tests assert where a fixture sits relative to a floor rather than
   *  trusting the number in its comment: #242 moved every hand holding a
   *  trump Run up by 40 and took one of these fixtures out of the band it was
   *  chosen for, and #273 moved it back down again. That is the failure mode
   *  this closes, twice over now. */
  const ceilingOf = (hand: readonly Card[]): number => bestBaseBid(hand, 0, 0).total

  describe('without a context (fallback)', () => {
    it('passes when the coin flip lands under 0.6', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.1)
      expect(chooseBid(0, weakHand, 300, 10)).toBeNull()
      vi.restoreAllMocks()
    })

    it('raises by minIncrement when the coin flip lands at/over 0.6', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.9)
      expect(chooseBid(0, weakHand, 300, 10)).toBe(310)
      vi.restoreAllMocks()
    })
  })

  describe('no one has bid yet', () => {
    it('opens when the ceiling clears OPENER_THRESHOLD', () => {
      // Player 0's partner is player 2 (0<->2 seating); use dealer 1 so
      // dealer-protection (which keys off the partner being dealer)
      // doesn't fire here.
      const context = baseContext({ dealer: 1 })
      expect(chooseBid(0, strongHand, OPENING_BID - 10, 10, context)).toBe(OPENING_BID)
    })

    it('passes when the ceiling does not clear OPENER_THRESHOLD and partner has already had a turn', () => {
      // 4th bidder (passesSoFar=3, dealer): partner (player 2) has already had
      // their turn, so the "partner hasn't bid" rule doesn't apply.
      // Pinned to STATIC_LEVEL (#114): this is the OPENER_THRESHOLD rule
      // specifically, and the distilled evaluator answers ahead of it.
      const context = baseContext({ dealer: 0, passesSoFar: 3 })
      expect(chooseBid(0, belowOpenerHand, OPENING_BID - 10, 10, context, STATIC_LEVEL)).toBeNull()
    })

    it('takes this hand on a distilled level and passes it on a static one (#114/#115)', () => {
      // belowOpenerHand's ceiling is 310, under OPENER_THRESHOLD, so the static
      // rule passes. The distilled evaluator takes it — it sees 90 guaranteed
      // meld and six trump, offered the contract at the 300 minimum.
      // That divergence is the clearest single illustration of what #114
      // changes, and #115's A/B is why every shipped seat follows the evaluator
      // rather than the threshold.
      const context = baseContext({ dealer: 0, passesSoFar: 3 })
      expect(chooseBid(0, belowOpenerHand, OPENING_BID - 10, 10, context, STATIC_LEVEL)).toBeNull()
      expect(chooseBid(0, belowOpenerHand, OPENING_BID - 10, 10, context, SHIPPED_SKILL)).toBe(OPENING_BID)
    })

    it('does not open a hopeless first-bidder hand (#126)', () => {
      // The first seat to speak (passesSoFar 0) used to open at OPENING_BID
      // unconditionally, which made this the first thing that happened on every
      // deal and left OPENER_THRESHOLD unreachable. `Player.choose_bid` has no
      // such tier: the hand decides. Pinned to STATIC_LEVEL so the
      // assertion is about the threshold rule rather than about the evaluator
      // (#114/#115), and to level scores so #256's endgame rule is not what is
      // answering.
      const context = baseContext({ dealer: 1 })
      expect(chooseBid(0, weakHand, OPENING_BID - 10, 10, context, STATIC_LEVEL)).toBeNull()
      // Same seat, a hand whose ceiling clears the threshold: it opens.
      expect(chooseBid(0, strongHand, OPENING_BID - 10, 10, context, STATIC_LEVEL)).toBe(OPENING_BID)
    })

    it('passes for a weak-handed 4th bidder when partner has already had a turn', () => {
      // 4th bidder (passesSoFar=3, dealer=player): partner has had a turn,
      // and the weak hand's ceiling (130) doesn't clear OPENER_THRESHOLD.
      const context = baseContext({ dealer: 0, passesSoFar: 3, scores: { 0: 850, 1: 500 } })
      expect(chooseBid(0, weakHand, OPENING_BID - 10, 10, context)).toBeNull()
    })

    it('3rd bidder does not open a hand under THIRD_BIDDER_FLOOR (#255)', () => {
      // This used to assert `toBe(OPENING_BID)` on `weakHand` — a lone off-trump
      // 9, ceiling 130 — because the positional rule opened on anything at all
      // to deny the last seat a cheap contract. There is a floor under it now.
      //
      // Note the context: `passesSoFar: 2` with an empty `passedPlayers`, i.e.
      // partner still to speak. That is the arm the floor guards and it is a
      // state no real auction reaches — `biddingSim.test.ts` pins why, and why
      // the arm is kept anyway — so this is a unit assertion about the rule,
      // not about a position players meet.
      const context = baseContext({ dealer: 1, passesSoFar: 2, scores: { 0: 0, 1: 0 } })
      expect(ceilingOf(weakHand)).toBeLessThan(THIRD_BIDDER_FLOOR)
      expect(chooseBid(0, weakHand, OPENING_BID - 10, 10, context)).toBeNull()
    })

    it('3rd bidder still opens positionally over THIRD_BIDDER_FLOOR (#255)', () => {
      // The other half of the same rule: the floor is a floor, not a repeal.
      const context = baseContext({ dealer: 1, passesSoFar: 2, scores: { 0: 0, 1: 0 } })
      expect(ceilingOf(strongHand)).toBeGreaterThanOrEqual(THIRD_BIDDER_FLOOR)
      expect(chooseBid(0, strongHand, OPENING_BID - 10, 10, context, STATIC_LEVEL)).toBe(OPENING_BID)
    })

    it('the floor is 200, not OPENER_THRESHOLD, and that is what the rule is (#255)', () => {
      // The hand has to sit strictly inside the 200-320 band for this test to
      // be testing anything, and a fixture's value is not a stable thing to
      // assume — #242 moved every hand holding a trump Run up by 40 and this
      // test's original fixture out of the band with it, and #273 moved every
      // such hand back down by 40. So the band is
      // derived from the current valuation here rather than taken on trust,
      // and this assertion is what will fail first if it moves again.
      expect(ceilingOf(belowOpenerHand)).toBeGreaterThanOrEqual(THIRD_BIDDER_FLOOR)
      expect(ceilingOf(belowOpenerHand)).toBeLessThan(OPENER_THRESHOLD)

      // Inside that band the third bidder opens and a first bidder — same
      // hand, same static policy — passes. That gap *is* the positional rule,
      // and a floor at OPENER_THRESHOLD would have closed it: measured at -57
      // score margin per deal, which is why the constant reads 200. See
      // THIRD_BIDDER_FLOOR for both A/B runs.
      const third = baseContext({ dealer: 1, passesSoFar: 2, scores: { 0: 0, 1: 0 } })
      const first = baseContext({ dealer: 1, passesSoFar: 0, scores: { 0: 0, 1: 0 } })
      expect(chooseBid(0, belowOpenerHand, OPENING_BID - 10, 10, third, STATIC_LEVEL)).toBe(OPENING_BID)
      expect(chooseBid(0, belowOpenerHand, OPENING_BID - 10, 10, first, STATIC_LEVEL)).toBeNull()
    })

    it('3rd bidder falls back to the normal threshold once my score is above 800', () => {
      // oppScore kept above 500 so the "closing out the game" competitive
      // adjustment bucket (+100) doesn't kick in and change the ceiling -
      // this test is purely about the passes_so_far===2 threshold gate.
      const context = baseContext({ dealer: 1, passesSoFar: 2, scores: { 0: 850, 1: 600 } })
      expect(chooseBid(0, weakHand, OPENING_BID - 10, 10, context)).toBeNull()
      expect(chooseBid(0, strongHand, OPENING_BID - 10, 10, context)).toBe(OPENING_BID)
    })
  })

  describe('my team currently holds the bid', () => {
    it('backs off once my partner has bid twice this auction', () => {
      const context = baseContext({
        everBid: true,
        bidHistory: [
          { player: 2, amount: 300 },
          { player: 1, amount: 310 },
          { player: 2, amount: 320 },
        ],
      })
      expect(chooseBid(0, strongHand, 320, 10, context)).toBeNull()
    })

    it('commits to PARTNER_RAISE_FLOOR on a partner raise over my own earlier bid (#206)', () => {
      const context = baseContext({
        everBid: true,
        bidHistory: [
          { player: 0, amount: 300 },
          { player: 1, amount: 310 },
          { player: 2, amount: 320 },
        ],
      })
      // Was 330 — `currentBid + minIncrement` — while the branch above it
      // required a 340-worthy ceiling to get here at all. #206 makes the number
      // the rule already demanded the number that reaches the table.
      expect(chooseBid(0, strongHand, 320, 10, context)).toBe(PARTNER_RAISE_FLOOR)
    })

    it('backs off a partner raise over my own earlier bid when the ceiling does not support it', () => {
      const context = baseContext({
        everBid: true,
        bidHistory: [
          { player: 0, amount: 300 },
          { player: 1, amount: 310 },
          { player: 2, amount: 320 },
        ],
      })
      expect(chooseBid(0, weakHand, 320, 10, context)).toBeNull()
    })

    it('leaves its own standing bid alone (last bidder was me, not partner)', () => {
      const context = baseContext({
        everBid: true,
        bidHistory: [
          { player: 1, amount: 300 },
          { player: 0, amount: 310 },
        ],
      })
      expect(chooseBid(0, strongHand, 310, 10, context)).toBeNull()
    })
  })

  describe('the opponents currently hold the bid', () => {
    it('raises when the next bid is within my ceiling', () => {
      const context = baseContext({ everBid: true, bidHistory: [{ player: 1, amount: 300 }] })
      expect(chooseBid(0, strongHand, 300, 10, context)).toBe(310)
    })

    it('defensively pushes against an opening bid unless the hand is truly hopeless', () => {
      // Written against OPENING_BID rather than the literal it used to pin:
      // the rule is "the opponent opened at the minimum", and #200 moved that
      // minimum from 300 to 250. Held at 300 this test kept feeding a level
      // that is no longer an opener, so `currentBid <= OPENING_BID` went false
      // and the push it exists to check stopped firing at all.
      const opener = { player: 1 as PlayerIndex, amount: OPENING_BID }
      // belowOpenerHand has ceiling 310 >= DEFENSIVE_PUSH_FLOOR (200)
      const context = baseContext({ everBid: true, bidHistory: [opener] })
      expect(chooseBid(0, belowOpenerHand, OPENING_BID, 10, context)).toBe(OPENING_BID + 10)

      // weakHand has ceiling 140 (a Dix at its best trump, no aces) < DEFENSIVE_PUSH_FLOOR (200) — truly hopeless
      const hopelessContext = baseContext({ everBid: true, bidHistory: [opener] })
      expect(chooseBid(0, weakHand, OPENING_BID, 10, hopelessContext)).toBeNull()
    })

    it('relaxes the ceiling to at least 330 once my partner has bid', () => {
      const withoutPartnerBid = baseContext({ everBid: true, bidHistory: [{ player: 1, amount: 320 }] })
      expect(chooseBid(0, belowOpenerHand, 320, 10, withoutPartnerBid)).toBeNull()

      const withPartnerBid = baseContext({
        everBid: true,
        bidHistory: [
          { player: 2, amount: 300 },
          { player: 1, amount: 320 },
        ],
      })
      expect(chooseBid(0, belowOpenerHand, 320, 10, withPartnerBid)).toBe(330)
    })
  })
})

// -- Parity with the Python reference engine (#118) -------------------------
//
// `pinochle_engine.py` is the reference implementation this module was ported
// from (CLAUDE.md), and it stays authoritative for the valuation constants
// this block pins — the auction floors are the other way round since #213, so
// this suite deliberately checks the Base Bid constants and not those.
//
// NEAR_RUN_VALUE and NEAR_DOUBLE_PINOCHLE_VALUE silently shipped at 60/60
// against Python's 120/225 - a hand-port slip that
// survived because both of this file's cases asserted loosely: one against the
// constant itself, the other against a hardcoded 60 under a title saying 225.
//
// These values are not free parameters. They feed computeBaseBid ->
// bestBaseBid, which picks the *trump suit*, so a divergence makes the browser
// disagree with the reference engine about what a hand even is - and silently
// invalidates the distilled evaluator (#104), whose labels are computed under
// Python's valuation.
// Endgame protection (#256). Reported from live play at 910-110: a seat held a
// good hand, bid 390, and needed 90 points it was already holding. The rule is
// a hard one in front of both bid policies, so every assertion here is pinned
// to a skill level only where the *contrast* case needs it — what the rule
// itself does is policy-independent by construction.
describe('endgame protection (#256)', () => {
  // Seats 0 and 2 are partners; the auction opens left of the dealer and
  // rotates clockwise, so with dealer 2 the order is 3, 0, 1, 2 — seat 0 is
  // the partner-of-the-dealer seat, speaking second, after exactly one
  // opponent (seat 3) and before both seat 1 and the dealer. That seat order
  // is the whole reason the exception below reads one opponent and not two.
  const OPP_BEFORE_ME: PlayerIndex = 3
  const OTHER_OPP: PlayerIndex = 1

  // Trump Run + a second Royal Marriage + the other three Aces. Base Bid 270,
  // so its ceiling clears ENDGAME_RESCUE_CEILING, OPENER_THRESHOLD and
  // PARTNER_RAISE_FLOOR alike at the +100 adjustment this score band carries.
  // Nothing here should ever be mistaken for "the hand was not worth a bid".
  const richHand = [
    ...RUN_RANKS.map((r) => new Card(Suit.Hearts, r, 1)),
    new Card(Suit.Hearts, 'K', 2),
    new Card(Suit.Hearts, 'Q', 2),
    new Card(Suit.Spades, 'A', 1),
    new Card(Suit.Diamonds, 'A', 1),
    new Card(Suit.Clubs, 'A', 1),
  ]
  // One off-trump 9: no meld, no Aces, nothing near a Run. Its ceiling is the
  // competitive adjustment and nothing else.
  const poorHand = [new Card(Suit.Hearts, '9', 1)]

  const ceilingOf = (hand: readonly Card[], ourScore: number, theirScore: number): number =>
    bestBaseBid(hand, ourScore, theirScore).total

  const ctx = (overrides: Partial<AuctionContext> = {}): AuctionContext => ({
    everBid: false,
    passesSoFar: 1,
    bidHistory: [],
    dealer: 2,
    scores: { 0: 910, 1: 110 },
    passedPlayers: [OPP_BEFORE_ME],
    ...overrides,
  })

  it('derives both thresholds from the game target rather than restating them', () => {
    expect(ENDGAME_SCORE_FLOOR).toBe(GAME_WIN_SCORE - 250)
    expect(ENDGAME_OPP_SCORE_CAP).toBe(GAME_WIN_SCORE - 550)
  })

  it('has fixture hands either side of the rescue ceiling', () => {
    expect(ceilingOf(richHand, 910, 110)).toBeGreaterThan(ENDGAME_RESCUE_CEILING)
    expect(ceilingOf(poorHand, 910, 110)).toBeLessThanOrEqual(ENDGAME_RESCUE_CEILING)
  })

  describe('the trigger', () => {
    // Dealer 3 puts an opponent in the chair and seat 0 first to speak, so the
    // exception cannot apply and the only thing separating these calls is the
    // trigger. STATIC_LEVEL pins the contrast case to OPENER_THRESHOLD rather than
    // to the evaluator.
    const opening = (ours: number, theirs: number) =>
      chooseBid(0, richHand, OPENING_BID - 10, 10,
        ctx({ dealer: 3, passesSoFar: 0, passedPlayers: [], scores: { 0: ours, 1: theirs } }), STATIC_LEVEL)

    it('fires at the score floor and not one point below', () => {
      expect(opening(ENDGAME_SCORE_FLOOR, 100)).toBeNull()
      expect(opening(ENDGAME_SCORE_FLOOR - 1, 100)).toBe(OPENING_BID)
    })

    it('fires under the opponent cap and not at it', () => {
      expect(opening(ENDGAME_SCORE_FLOOR, ENDGAME_OPP_SCORE_CAP - 1)).toBeNull()
      expect(opening(ENDGAME_SCORE_FLOOR, ENDGAME_OPP_SCORE_CAP)).toBe(OPENING_BID)
    })
  })

  describe('the default is to pass the whole auction', () => {
    it('declines to open however good the hand', () => {
      const context = ctx({ dealer: 3, passesSoFar: 0, passedPlayers: [] })
      expect(chooseBid(0, richHand, OPENING_BID - 10, 10, context)).toBeNull()
    })

    it('declines the defensive push against an opponent sitting on the opening rung', () => {
      // The push is what makes this assertion worth making: at OPENING_BID with
      // a ceiling over DEFENSIVE_PUSH_FLOOR, every other path in chooseBid
      // answers 310. The contrast call, at level scores, is that answer.
      const bid = { player: OTHER_OPP, amount: OPENING_BID }
      const endgame = ctx({ dealer: 3, everBid: true, passesSoFar: 0, passedPlayers: [], bidHistory: [bid] })
      expect(chooseBid(0, richHand, OPENING_BID, 10, endgame)).toBeNull()
      expect(chooseBid(0, richHand, OPENING_BID, 10, { ...endgame, scores: { 0: 0, 1: 0 } })).toBe(OPENING_BID + 10)
    })

    it('declines to raise over its own partner', () => {
      // A constructed state — this seat would not have bid 300 under the rule
      // in the first place — but it is the one remaining branch that returns a
      // bid rather than null, so it is the one worth pinning. Without the rule
      // a partner raise over our own bid answers PARTNER_RAISE_FLOOR.
      const history = [{ player: 0 as PlayerIndex, amount: OPENING_BID }, { player: 2 as PlayerIndex, amount: 320 }]
      const endgame = ctx({ dealer: 3, everBid: true, passesSoFar: 0, passedPlayers: [], bidHistory: history })
      expect(chooseBid(0, richHand, 320, 10, endgame)).toBeNull()
      expect(chooseBid(0, richHand, 320, 10, { ...endgame, scores: { 0: 0, 1: 0 } })).toBe(PARTNER_RAISE_FLOOR)
    })

    it('applies to both seats of the team, not only the one holding the good hand', () => {
      const context = ctx({ dealer: 3, passesSoFar: 0, passedPlayers: [] })
      expect(chooseBid(0, richHand, OPENING_BID - 10, 10, context)).toBeNull()
      expect(chooseBid(2, richHand, OPENING_BID - 10, 10, context)).toBeNull()
    })
  })

  describe('the one exception: saving a partner who is dealing', () => {
    it('opens at OPENING_BID when all three conditions hold', () => {
      expect(chooseBid(0, richHand, OPENING_BID - 10, 10, ctx())).toBe(OPENING_BID)
    })

    it('is off when the dealer is an opponent', () => {
      expect(chooseBid(0, richHand, OPENING_BID - 10, 10, ctx({ dealer: 3 }))).toBeNull()
    })

    it('is off when the opponent ahead of us has not passed', () => {
      expect(chooseBid(0, richHand, OPENING_BID - 10, 10, ctx({ passesSoFar: 0, passedPlayers: [] }))).toBeNull()
      // The *other* opponent passing is not the same fact and does not count:
      // seat 1 speaks after this seat, so it cannot have passed yet anyway.
      expect(chooseBid(0, richHand, OPENING_BID - 10, 10, ctx({ passedPlayers: [OTHER_OPP] }))).toBeNull()
    })

    it('is off on a hand under the rescue ceiling', () => {
      expect(chooseBid(0, poorHand, OPENING_BID - 10, 10, ctx())).toBeNull()
    })

    it('is off once an opponent has bid', () => {
      // "If the opponent bids 310, pass for both teammates with the high score."
      const context = ctx({
        everBid: true,
        passesSoFar: 0,
        passedPlayers: [],
        bidHistory: [{ player: OPP_BEFORE_ME, amount: OPENING_BID + 10 }],
      })
      expect(chooseBid(0, richHand, OPENING_BID + 10, 10, context)).toBeNull()
    })
  })

  it('retires the old dealer-protection rule rather than keeping both', () => {
    // 850/400 with a partner dealing was an unconditional OPENING_BID before
    // #256, on any hand at all — the missing hand check that is half of #255.
    // Those scores are inside the new trigger, so the rescue's own floor now
    // applies and this hand does not clear it.
    const context = ctx({ scores: { 0: 850, 1: 400 } })
    expect(chooseBid(0, poorHand, OPENING_BID - 10, 10, context, STATIC_LEVEL)).toBeNull()
    // And outside the trigger the ordinary rules decide, where the old tier
    // would have opened on this hand too.
    const outside = ctx({ scores: { 0: 850, 1: 500 } })
    expect(chooseBid(0, poorHand, OPENING_BID - 10, 10, outside, STATIC_LEVEL)).toBeNull()
    expect(chooseBid(0, richHand, OPENING_BID - 10, 10, outside, STATIC_LEVEL)).toBe(OPENING_BID)
  })
})

describe('parity with the Python reference engine (#118)', () => {
  it('matches pinochle_engine.py Base Bid constants exactly', () => {
    expect(NEAR_RUN_VALUE).toBe(120)
    expect(NEAR_DOUBLE_PINOCHLE_VALUE).toBe(225)
    expect(ACE_VALUE).toBe(20)
  })
})

// -- The multiple-of-10 invariant (#177) ------------------------------------
//
// Bids move in tens. Nothing in the engine said so: the only multiple-of-10
// check anywhere was the disabled state of one button in `BiddingControls`,
// which is a *display* rule enforced after the fact and on the human's side
// only. So `Math.max(321, ...)` — "strictly above OPENER_THRESHOLD", written as
// `320 + 1` by someone thinking in points rather than in bids — reached players
// as a real AI bid, and from 321 the whole ladder ran 331, 341, 351, every rung
// of it a minimum the +/- buttons could not produce.
//
// The specific constant is a one-line fix. What made it possible to ship is
// that no test could have caught it: the case-by-case tests above each assert
// one hand against one expected number, so they only cover paths someone
// already thought about, and `engineParity.test.ts` compares rules against
// Python rather than AI decisions (Python never had this constant — it is
// TypeScript-only, not a port slip).
//
// Hence a property rather than another case: sweep the decision surface and
// assert the shape of every answer. The next off-grid constant fails here
// instead of reaching a player, wherever in `chooseBid` someone puts it.
const SEATS: readonly PlayerIndex[] = [0, 1, 2, 3]

/** mulberry32, the generator `src/ab/headlessGame.ts` uses. Inlined rather than
 *  imported so an engine test does not depend on the measurement harness.
 *  `meldOnlyBid`'s noise term reads `Math.random`, so an unseeded sweep would be
 *  a different test on every run — and a property test that cannot be replayed
 *  from its failure is not much of a property test. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('every bid chooseBid can return is legal (#177)', () => {
  it('is a multiple of 10 and at least OPENING_BID, across skills, auction states and seats', () => {
    const realRandom = Math.random
    Math.random = seededRandom(0x1770_2026)
    const offGrid: string[] = []

    // Dealer seat and running score are cycled through the case list rather
    // than nested as two more loops. They are independent of the auction state
    // for this property's purposes — the branches that read them (dealer
    // protection, `computeCompetitiveAdjustment`) do not interact with the
    // branches that set a bid level — and 8 deals x 4 seats re-rolls the offset,
    // so every state still meets every dealer and every score pairing across
    // the sweep. Nesting them instead multiplied the run by 12x for ~85s, which
    // is the difference between a property test that gets run and one that gets
    // skipped.
    const SCORE_CASES: Record<0 | 1, number>[] = [
      { 0: 0, 1: 0 },
      { 0: 850, 1: 400 },
      { 0: 400, 1: 900 },
    ]

    try {
      for (let deal = 0; deal < 8; deal++) {
        const deck = new Deck()
        deck.shuffle()
        const hands = deck.deal()

        for (const player of SEATS) {
          const partner = partnerOf(player)
          const opponent = ((player + 1) % 4) as PlayerIndex

          // Auction states worth sweeping, each paired with the currentBid that
          // actually goes with it. The partner-passed rows are the ones #177
          // lived in; the rest are there so the property covers the whole
          // function rather than the one branch known to have been wrong.
          const cases: { currentBid: number; context: AuctionContext }[] = []
          const spin = deal * 4 + player
          const push = (currentBid: number, partial: Omit<AuctionContext, 'dealer' | 'scores'>) => {
            const n = cases.length + spin
            cases.push({
              currentBid,
              context: { ...partial, dealer: (n % 4) as PlayerIndex, scores: SCORE_CASES[n % 3] },
            })
          }

          for (const passedPlayers of [[], [partner], [opponent], [partner, opponent]] as PlayerIndex[][]) {
            // Nobody has bid: opener, 3rd-bidder-opens-cheap, and dealer seats.
            for (const passesSoFar of [0, 1, 2, 3]) {
              push(OPENING_BID - 10, { everBid: false, passesSoFar, bidHistory: [], passedPlayers })
            }
            // Someone holds the bid — opponents, then partner, then this seat's
            // own earlier bid, at rungs on both sides of the partner-passed
            // floor so the raise ladder and the floor are both exercised.
            for (const currentBid of [300, 310, 320, 330, 390, 400]) {
              for (const lastBidder of [opponent, partner, player] as PlayerIndex[]) {
                push(currentBid, {
                  everBid: true,
                  passesSoFar: passedPlayers.length,
                  bidHistory: [
                    { player: opponent, amount: OPENING_BID },
                    { player: lastBidder, amount: currentBid },
                  ],
                  passedPlayers,
                })
              }
            }
          }

          for (const skill of SKILL_LEVELS) {
            for (const { currentBid, context } of cases) {
              const bid = chooseBid(player, hands[player], currentBid, 10, context, skill)
              if (bid === null) continue
              if (bid % 10 !== 0 || bid < OPENING_BID) {
                offGrid.push(
                  `${bid} (skill ${skill}, seat ${player}, dealer ${context.dealer}, currentBid ${currentBid}, ` +
                    `everBid ${context.everBid}, passed [${context.passedPlayers.join(',')}])`,
                )
              }
            }
          }
        }
      }
    } finally {
      Math.random = realRandom
    }

    // Reported as a list rather than as the first failure: if a constant is off
    // the grid it is off it in several places at once (#177 had three), and
    // seeing them together is what says "one wrong constant" rather than "one
    // wrong branch".
    expect(offGrid.slice(0, 10)).toEqual([])
  }, 30_000)

  it('takes the partner-passed floor to OPENER_THRESHOLD itself (#180)', () => {
    // **What this used to assert, and why it changed.** #179 pinned
    // `PARTNER_PASSED_FLOOR` to 330 with a `- OPENER_THRESHOLD === 10` guard
    // whose stated purpose was "guards against a later 'simplify' that sets the
    // floor to OPENER_THRESHOLD itself". #180 is that change — made as a
    // decision rather than as a simplification. Paul's call is that a seat
    // bidding alone must *reach* the opener threshold, not clear it, and 320
    // measured 8-11 points per deal ahead of 330 on the shipped levels
    // (`web/README.md`). The guard is inverted rather than deleted, so a later
    // drift back to 330 fails here just as loudly.
    expect(PARTNER_PASSED_FLOOR).toBe(320)
    expect(PARTNER_PASSED_FLOOR).toBe(OPENER_THRESHOLD)
    // Unchanged, and the part #177 was actually about: the floor is a bid, not
    // a ceiling, so it has to be one the ladder and the +/- buttons can reach.
    // 321 fails this; 320 and 330 both pass, which is why the choice between
    // them was a design question and not a correctness one.
    expect(PARTNER_PASSED_FLOOR % 10).toBe(0)
    expect(PARTNER_PASSED_FLOOR).toBeGreaterThanOrEqual(OPENING_BID)
  })

  it('opens a partner-passed seat on a ceiling of exactly OPENER_THRESHOLD (#180)', () => {
    // The half of #180 the constant swap does not cover, and the half the
    // ~10-per-deal table did not measure: collapsing
    // `partnerPassed ? ceiling > OPENER_THRESHOLD : ceiling >= ...` to one
    // `>=` lets a hand whose ceiling is *exactly* 320 open where it used to
    // decline. Ceilings move in tens, so that is a whole rung of hands, not a
    // rounding edge.
    //
    // Pinned to `medium`, the one shipped level still on `bidPolicy: 'static'`
    // — a `'distilled'` level discards the static verdict entirely, so this
    // branch is only reachable there (see `worthContract`). Asserting the
    // ceiling first so a drift in the valuation constants fails as itself
    // rather than as a bidding regression.
    //
    // The hand was a trump Run plus an off-suit Ace until #242, which added
    // the run's own Royal Marriage to the valuation and carried it 40 past the
    // threshold it is here to sit exactly on; it was rebuilt out of a near-run
    // plus a Pinochle, and #277 carried *that* past the threshold in turn — the
    // lone Q(S) picked up both the new no-King-of-Spades pinochle bonus and the
    // unmarried-Queen line. What is left is the smallest hand that lands on 320
    // and the one with the least under it that can move: a bare near-run with
    // its Dix. 120 near-run + 10 Dix = 130 of Base Bid, and the trump Ace at 40
    // plus one trump past the fourth at 20 = 60 of trick potential, over the
    // 130 baseline adjustment. No Run rule, no Pinochle rule, no marriage rule
    // anywhere in it.
    const ceiling320Hand = [
      new Card(Suit.Hearts, 'A', 1),
      new Card(Suit.Hearts, 'K', 1),
      new Card(Suit.Hearts, 'Q', 1),
      new Card(Suit.Hearts, 'J', 1),
      new Card(Suit.Hearts, '9', 1),
    ]
    const { trump, total } = bestBaseBid(ceiling320Hand, 0, 0)
    expect(trump).toBe(Suit.Hearts)
    expect(total).toBe(OPENER_THRESHOLD) // 130 Base Bid + 60 trick potential + baseline adj 130

    // 4th bidder (dealer), partner (seat 2) has passed, nobody has bid.
    const context: AuctionContext = {
      everBid: false,
      passesSoFar: 3,
      bidHistory: [],
      dealer: 0,
      scores: { 0: 0, 1: 0 },
      passedPlayers: [2],
    }
    expect(chooseBid(0, ceiling320Hand, OPENING_BID - 10, 10, context, STATIC_LEVEL)).toBe(PARTNER_PASSED_FLOOR)
  })
})

// -- PARTNER_RAISE_FLOOR (#206) ----------------------------------------------
//
// The AI-vs-AI harness cannot see this rule. `Math.max(ceiling, 330)` in the
// competitive branch means an all-AI ladder arrives at 330 and `+ minIncrement`
// lands on 340 by arithmetic accident, so every bid an AI has ever placed over
// its own partner was already exactly 340 and a 4000-deal sweep shows nothing
// wrong. A human partner's bid is not on that ladder, which is the only reason
// the defect was ever visible — so these tests drive the branch from an
// off-ladder `currentBid` on purpose. Do not "simplify" them onto round AI
// numbers; that is precisely the blind spot.
describe('raising over a bid our own team already holds (#206)', () => {
  // Clears PARTNER_RAISE_FLOOR (340) with room above it, which is the only
  // property the tests below need and is now asserted as that rather than as a
  // number. It read 360 before #242, 400 while #242 paid the marriage the run
  // absorbs, 360 again after #273, and 400 again since #277 priced the trump
  // Ace at 40 and three trump past the fourth at 60.
  const strongHand = [
    ...RUN_RANKS.map((r) => new Card(Suit.Hearts, r, 1)),
    new Card(Suit.Hearts, 'K', 2),
    new Card(Suit.Hearts, 'Q', 2),
    new Card(Suit.Spades, 'A', 1),
  ]
  // Ceiling 320 — opens happily, but cannot support a 340 commitment. Same
  // hand and same history as #180's `ceiling320Hand` above: a trump Run plus an
  // off-suit Ace until #242, a near-run plus a Pinochle until #277 paid the
  // lone Q(S) twice over, and now a bare near-run with its Dix, which touches
  // none of the three rules that have moved under it.
  const modestHand = [
    new Card(Suit.Hearts, 'A', 1),
    new Card(Suit.Hearts, 'K', 1),
    new Card(Suit.Hearts, 'Q', 1),
    new Card(Suit.Hearts, 'J', 1),
    new Card(Suit.Hearts, '9', 1),
  ]

  /** Seat 2 opened one rung under `partnerBid`; its partner (seat 0) then bid
   *  `partnerBid`.
   *
   *  Seat 2's own number is scaffolding. The branch under test fires on
   *  `currentBid > myOwnBids.at(-1)` — all it needs is that the partner's bid
   *  is above seat 2's — so the open is derived from the raise rather than
   *  pinned to `OPENING_BID`. It was `OPENING_BID` until #257 moved that rung
   *  back to 300, at which point every `partnerBid` below 300 described an
   *  auction that ran *downhill*: seat 2 opened 300 and its partner "raised"
   *  to 260, so `chooseBid` correctly answered null on the grounds that its
   *  own bid still stood, and the test failed for a reason that had nothing to
   *  do with PARTNER_RAISE_FLOOR. Deriving the open keeps the off-ladder
   *  `partnerBid` values this block exists to exercise (see the note above)
   *  and stops the fixture tracking an opening rung it does not care about.
   */
  const afterPartnerRaise = (partnerBid: number): AuctionContext => ({
    everBid: true,
    passesSoFar: 0,
    bidHistory: [
      { player: 2 as PlayerIndex, amount: partnerBid - 10 },
      { player: 0 as PlayerIndex, amount: partnerBid },
    ],
    dealer: 1,
    scores: { 0: 0, 1: 0 },
    passedPlayers: [],
  })

  it('commits to PARTNER_RAISE_FLOOR rather than nudging its partner by ten', () => {
    // The two properties the fixture needs, derived rather than pinned: it can
    // carry the floor, and it can carry the rung above the highest partnerBid
    // the next test drives it from. A literal here has now been wrong three
    // times (#242, #273, #277) for reasons none of these tests are about.
    expect(bestBaseBid(strongHand, 0, 0).total).toBeGreaterThanOrEqual(PARTNER_RAISE_FLOOR)
    expect(bestBaseBid(strongHand, 0, 0).total).toBeGreaterThanOrEqual(360)
    // Every one of these used to answer `partnerBid + 10` — 270 over a 260 —
    // while requiring a 340-worthy hand to say it.
    for (const partnerBid of [260, 270, 280, 290, 300, 310, 320, 330]) {
      expect(chooseBid(2, strongHand, partnerBid, 10, afterPartnerRaise(partnerBid), SHIPPED_SKILL)).toBe(
        PARTNER_RAISE_FLOOR,
      )
    }
  })

  it('still takes the ordinary next rung once the partner is already past the floor', () => {
    // The floor is a floor, not a fixed bid: above it the normal ladder applies.
    expect(chooseBid(2, strongHand, 350, 10, afterPartnerRaise(350), SHIPPED_SKILL)).toBe(360)
  })

  it('backs off instead of being talked into a commitment it cannot make', () => {
    expect(bestBaseBid(modestHand, 0, 0).total).toBeLessThan(PARTNER_RAISE_FLOOR)
    for (const partnerBid of [260, 300, 330]) {
      expect(chooseBid(2, modestHand, partnerBid, 10, afterPartnerRaise(partnerBid), SHIPPED_SKILL)).toBeNull()
    }
  })

  it('never places a bid over its own partner below the floor, on any hand', () => {
    const realRandom = Math.random
    Math.random = seededRandom(0x2060_2026)
    try {
      for (let i = 0; i < 300; i++) {
        const deck = new Deck()
        deck.shuffle()
        const hands = deck.deal()
        for (const partnerBid of [260, 275, 290, 305, 330]) {
          // MELD_ONLY_LEVEL is excluded on purpose, not because it fails:
          // `meldOnlyBid` has no partner tracking of any kind (see its
          // docstring), so it never reaches this branch and answers the plain
          // next rung. Sweeping it here would assert that the meld-only arm has
          // partner logic, which is the opposite of what it is for.
          for (const level of SKILL_LEVELS.filter((l) => l !== MELD_ONLY_LEVEL)) {
            const out = chooseBid(2, hands[2], partnerBid, 10, afterPartnerRaise(partnerBid), level)
            if (out === null) continue
            expect(out).toBeGreaterThanOrEqual(PARTNER_RAISE_FLOOR)
          }
        }
      }
    } finally {
      Math.random = realRandom
    }
  })

  it('pushes opponents rather than handing them a cheap contract once the partner has bid', () => {
    // The other half of Paul's report: passing here would let the opponents buy
    // it low after both seats have shown cards. `Math.max(ceiling, 330)` already
    // covers it, and this pins that down — a ceiling-190 hand still pushes.
    const weakHand = [
      new Card(Suit.Hearts, 'K', 1),
      new Card(Suit.Hearts, 'Q', 1),
      new Card(Suit.Spades, 'A', 1),
    ]
    expect(bestBaseBid(weakHand, 0, 0).total).toBeLessThan(330)
    for (const oppBid of [260, 280, 300, 320]) {
      const context: AuctionContext = {
        everBid: true,
        passesSoFar: 0,
        bidHistory: [
          { player: 2 as PlayerIndex, amount: OPENING_BID },
          { player: 0 as PlayerIndex, amount: 260 },
          { player: 1 as PlayerIndex, amount: oppBid },
        ],
        dealer: 3,
        scores: { 0: 0, 1: 0 },
        passedPlayers: [],
      }
      expect(chooseBid(2, weakHand, oppBid, 10, context, SHIPPED_SKILL)).toBe(oppBid + 10)
    }
  })
})

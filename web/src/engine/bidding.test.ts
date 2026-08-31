import { describe, expect, it, vi } from 'vitest'
import type { SkillLevel } from '../persistence/options'
import { Card, Deck, GAME_WIN_SCORE, OPENING_BID, Suit } from './card'
import {
  ACE_VALUE,
  type AuctionContext,
  bestBaseBid,
  cappedBid,
  chooseBid,
  chooseTrump,
  computeBaseBid,
  computeCompetitiveAdjustment,
  computeMaxBid,
  ENDGAME_OPP_SCORE_CAP,
  ENDGAME_RESCUE_CEILING,
  ENDGAME_SCORE_FLOOR,
  maxBid,
  MAX_BID_DEFAULT,
  NEAR_DOUBLE_PINOCHLE_VALUE,
  NEAR_RUN_VALUE,
  OPENER_THRESHOLD,
  PARTNER_PASSED_FLOOR,
  PARTNER_RAISE_FLOOR,
} from './bidding'
import { ROYAL_MARRIAGE_VALUE, scoreMelds } from './melds'
import { partnerOf } from './round'
import { SKILL_PARAMS } from './skills'
import type { PlayerIndex } from './trick'

const trump = Suit.Spades
const RUN_RANKS = ['A', '10', 'K', 'Q', 'J'] as const

describe('computeBaseBid', () => {
  it('scores a full trump Run at 150, its Royal Marriage at 40, and its aces', () => {
    // The Run does not absorb the Royal Marriage (#242). Both are paid,
    // because the King and Queen of trump are in two *different* melds at
    // once and `pinochle_rules.md` says so in as many words. This line used
    // to read 170 and the Royal Marriage line used to be absent.
    const hand = RUN_RANKS.map((r) => new Card(trump, r, 1))
    const { total, breakdown } = computeBaseBid(hand, trump)
    expect(breakdown['Run/near-run']).toBe(150)
    expect(breakdown['Royal Marriage']).toBe(ROYAL_MARRIAGE_VALUE)
    expect(breakdown['Aces (flat, 20/ea)']).toBe(ACE_VALUE)
    expect(total).toBe(150 + ROYAL_MARRIAGE_VALUE + ACE_VALUE)
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

  it('credits both Royal Marriages when a Run and a spare K/Q are both held', () => {
    // Full run + a spare K/Q pair. Two Royal Marriages are held and two are
    // paid; this asserted 40 before #242, on the reading that the run had
    // already consumed the first one.
    const hand = [
      ...RUN_RANKS.map((r) => new Card(trump, r, 1)),
      new Card(trump, 'K', 2),
      new Card(trump, 'Q', 2),
    ]
    const { breakdown } = computeBaseBid(hand, trump)
    expect(breakdown['Run/near-run']).toBe(150)
    expect(breakdown['Royal Marriage']).toBe(2 * ROYAL_MARRIAGE_VALUE)
  })

  it('credits the Royal Marriage at full value when there is no run at all', () => {
    const hand = [new Card(trump, 'K', 1), new Card(trump, 'Q', 1)]
    const { breakdown } = computeBaseBid(hand, trump)
    expect(breakdown['Royal Marriage']).toBe(40)
    expect(breakdown['Run/near-run']).toBeUndefined()
  })

  // -- #242: the valuation must not price meld the scorer will actually pay --
  //
  // The bug was one judgement made twice, in `compute_base_bid` and here, and
  // the number was always wrong by exactly 40 per Royal Marriage held inside a
  // run. Pinning the new number alone would not stop that happening again, so
  // what these check is *agreement with `scoreMelds`* — the two are supposed to
  // describe the same cards, and the moment they stop doing so is the moment
  // the AI is bidding against a hand it does not have.
  describe('agrees with scoreMelds about certain meld (#242)', () => {
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
      ['a bare trump Run', RUN_RANKS.map((r) => new Card(trump, r, 1)), 150 + 40],
      [
        'a Run plus a second Royal Marriage',
        [
          ...RUN_RANKS.map((r) => new Card(trump, r, 1)),
          new Card(trump, 'K', 2),
          new Card(trump, 'Q', 2),
        ],
        150 + 80,
      ],
      [
        'a Double Run',
        RUN_RANKS.flatMap((r) => [new Card(trump, r, 1), new Card(trump, r, 2)]),
        1500 + 80,
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
      // Explicitly out of #242's scope and not an oversight. NEAR_RUN_VALUE is
      // a guess at a run that is *not* in hand, so what it does or does not
      // already price in is a different question from what the scorer pays for
      // cards that are. Four run ranks and two K/Q pairs: the valuation credits
      // 120 + one marriage, the scorer pays two marriages and no run.
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

  it('always includes the flat Aces line even at zero', () => {
    const hand = [new Card(Suit.Hearts, '9', 1)] // non-trump 9: no Dix, no melds at all
    const { breakdown, total } = computeBaseBid(hand, trump)
    expect(breakdown['Aces (flat, 20/ea)']).toBe(0)
    expect(total).toBe(0)
  })

  it('awards the 3-different-aces bonus at 50 for D/S trump and 60 for H/C trump', () => {
    const handWithoutTrumpAce = [
      new Card(Suit.Diamonds, 'A', 1),
      new Card(Suit.Clubs, 'A', 1),
      new Card(Suit.Hearts, 'A', 1),
    ]
    const { breakdown: spadesBreakdown } = computeBaseBid(handWithoutTrumpAce, Suit.Spades)
    expect(spadesBreakdown['3 different Aces bonus']).toBe(50)

    const handHC = [
      new Card(Suit.Spades, 'A', 1),
      new Card(Suit.Diamonds, 'A', 1),
      new Card(Suit.Clubs, 'A', 1),
    ]
    const { breakdown: heartsBreakdown } = computeBaseBid(handHC, Suit.Hearts)
    expect(heartsBreakdown['3 different Aces bonus']).toBe(60)
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

describe('maxBid / cappedBid', () => {
  it('caps at 400 when actual meld is 300 or below', () => {
    const hand = [new Card(trump, 'K', 1), new Card(trump, 'Q', 1)] // Royal Marriage = 40
    expect(maxBid(hand, trump)).toBe(MAX_BID_DEFAULT)
    expect(cappedBid(hand, trump, 900)).toBe(MAX_BID_DEFAULT)
  })

  it('uncaps (null) when actual guaranteed meld exceeds 300', () => {
    const hand = [
      new Card(Suit.Spades, 'Q', 1),
      new Card(Suit.Spades, 'Q', 2),
      new Card(Suit.Diamonds, 'J', 1),
      new Card(Suit.Diamonds, 'J', 2),
    ] // Double Pinochle = 300, not > 300
    expect(maxBid(hand, Suit.Hearts)).toBe(MAX_BID_DEFAULT)
  })

  it('leaves the bid unclamped below the cap', () => {
    const hand = [new Card(trump, 'K', 1)]
    expect(cappedBid(hand, trump, 350)).toBe(350)
  })
})

describe('bestBaseBid', () => {
  it('picks the trump suit with the highest capped ceiling', () => {
    const hand = [
      ...RUN_RANKS.map((r) => new Card(Suit.Hearts, r, 1)),
      new Card(Suit.Spades, '9', 1),
      new Card(Suit.Diamonds, '9', 1),
    ]
    const { trump: bestTrump } = bestBaseBid(hand)
    expect(bestTrump).toBe(Suit.Hearts)
  })

  it('matches computeMaxBid + cappedBid for the winning trump', () => {
    const hand = [new Card(Suit.Clubs, 'K', 1), new Card(Suit.Clubs, 'Q', 1), new Card(Suit.Diamonds, 'A', 1)]
    const { trump: bestTrump, total } = bestBaseBid(hand, 100, 50)
    const { total: rawTotal } = computeMaxBid(hand, bestTrump, 100, 50)
    expect(total).toBe(cappedBid(hand, bestTrump, rawTotal))
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

  // The "good but not good enough" fixture: Base Bid 160 (near-run 120 + the
  // extra Royal Marriage 40) -> ceiling 290 at the default 0/0 score
  // adjustment (+130 baseline). Below OPENER_THRESHOLD (320), and below the
  // 330 the competitive branch relaxes to once a partner has bid.
  //
  // This was a bare trump Run until #242, which is the whole point: paying the
  // Royal Marriage inside a run moved that hand from 300 to 340 and put it
  // *over* the threshold, so it stopped being able to play this part. Four run
  // ranks and a second K/Q keeps a hand the valuation likes without one it
  // will open on. It sits in the near-run branch, which #242 deliberately left
  // alone — so if that branch is ever settled the same way, this fixture moves
  // again and these tests are where it shows up.
  const nearRunHand = [
    ...RUN_RANKS.filter((r) => r !== 'A').map((r) => new Card(Suit.Hearts, r, 1)),
    new Card(Suit.Hearts, 'K', 2),
    new Card(Suit.Hearts, 'Q', 2),
  ]

  // Base Bid 250 (Run 150 + two Royal Marriages 80 + Ace 20) -> ceiling
  // 380 at the default 0/0 adjustment (+130 baseline). Clears both
  // OPENER_THRESHOLD (320) and the 340 raise-support gate.
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
      // Pinned to a 'static' skill level (#114): this is the OPENER_THRESHOLD
      // rule specifically, and since #115 opened the gate only `easy` and
      // `medium` still run it.
      const context = baseContext({ dealer: 0, passesSoFar: 3 })
      expect(chooseBid(0, nearRunHand, OPENING_BID - 10, 10, context, 'medium')).toBeNull()
    })

    it('takes this hand on a distilled level and passes it on a static one (#114/#115)', () => {
      // nearRunHand's ceiling is 290, under OPENER_THRESHOLD, so the static
      // rule passes. The distilled evaluator takes it — it sees 80 guaranteed
      // meld and four fifths of a run, offered the contract at the 300 minimum.
      // That divergence is the clearest single illustration of what #114
      // changes, and #115's A/B is why `hard` now follows the evaluator rather
      // than the threshold.
      const context = baseContext({ dealer: 0, passesSoFar: 3 })
      expect(chooseBid(0, nearRunHand, OPENING_BID - 10, 10, context, 'medium')).toBeNull()
      expect(chooseBid(0, nearRunHand, OPENING_BID - 10, 10, context, 'hard')).toBe(OPENING_BID)
    })

    it('does not open a hopeless first-bidder hand (#126)', () => {
      // The first seat to speak (passesSoFar 0) used to open at OPENING_BID
      // unconditionally, which made this the first thing that happened on every
      // deal and left OPENER_THRESHOLD unreachable. `Player.choose_bid` has no
      // such tier: the hand decides. Pinned to a 'static' level so the
      // assertion is about the threshold rule rather than about the evaluator
      // (#114/#115), and to level scores so #256's endgame rule is not what is
      // answering.
      const context = baseContext({ dealer: 1 })
      expect(chooseBid(0, weakHand, OPENING_BID - 10, 10, context, 'medium')).toBeNull()
      // Same seat, a hand whose ceiling clears the threshold: it opens.
      expect(chooseBid(0, strongHand, OPENING_BID - 10, 10, context, 'medium')).toBe(OPENING_BID)
    })

    it('passes for a weak-handed 4th bidder when partner has already had a turn', () => {
      // 4th bidder (passesSoFar=3, dealer=player): partner has had a turn,
      // and the weak hand's ceiling (130) doesn't clear OPENER_THRESHOLD.
      const context = baseContext({ dealer: 0, passesSoFar: 3, scores: { 0: 850, 1: 500 } })
      expect(chooseBid(0, weakHand, OPENING_BID - 10, 10, context)).toBeNull()
    })

    it('3rd bidder (2 passes so far) always opens cheap when my score is not above 800', () => {
      const context = baseContext({ dealer: 1, passesSoFar: 2, scores: { 0: 0, 1: 0 } })
      expect(chooseBid(0, weakHand, OPENING_BID - 10, 10, context)).toBe(OPENING_BID)
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
      // nearRunHand has ceiling 290 (near-run 120 + Royal Marriage 40 + baseline adj 130) >= DEFENSIVE_PUSH_FLOOR (200)
      const context = baseContext({ everBid: true, bidHistory: [opener] })
      expect(chooseBid(0, nearRunHand, OPENING_BID, 10, context)).toBe(OPENING_BID + 10)

      // weakHand has ceiling 130 (no meld, no aces) < DEFENSIVE_PUSH_FLOOR (200) — truly hopeless
      const hopelessContext = baseContext({ everBid: true, bidHistory: [opener] })
      expect(chooseBid(0, weakHand, OPENING_BID, 10, hopelessContext)).toBeNull()
    })

    it('relaxes the ceiling to at least 330 once my partner has bid', () => {
      const withoutPartnerBid = baseContext({ everBid: true, bidHistory: [{ player: 1, amount: 320 }] })
      expect(chooseBid(0, nearRunHand, 320, 10, withoutPartnerBid)).toBeNull()

      const withPartnerBid = baseContext({
        everBid: true,
        bidHistory: [
          { player: 2, amount: 300 },
          { player: 1, amount: 320 },
        ],
      })
      expect(chooseBid(0, nearRunHand, 320, 10, withPartnerBid)).toBe(330)
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

  const ceilingOf = (hand: readonly Card[], ourScore: number, theirScore: number): number => {
    const { trump: t, total } = bestBaseBid(hand, ourScore, theirScore)
    const cap = maxBid(hand, t)
    return cap === null ? total : Math.min(total, cap)
  }

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
    // trigger. 'medium' pins the contrast case to OPENER_THRESHOLD rather than
    // to the evaluator.
    const opening = (ours: number, theirs: number) =>
      chooseBid(0, richHand, OPENING_BID - 10, 10,
        ctx({ dealer: 3, passesSoFar: 0, passedPlayers: [], scores: { 0: ours, 1: theirs } }), 'medium')

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
    expect(chooseBid(0, poorHand, OPENING_BID - 10, 10, context, 'medium')).toBeNull()
    // And outside the trigger the ordinary rules decide, where the old tier
    // would have opened on this hand too.
    const outside = ctx({ scores: { 0: 850, 1: 500 } })
    expect(chooseBid(0, poorHand, OPENING_BID - 10, 10, outside, 'medium')).toBeNull()
    expect(chooseBid(0, richHand, OPENING_BID - 10, 10, outside, 'medium')).toBe(OPENING_BID)
  })
})

describe('parity with the Python reference engine (#118)', () => {
  it('matches pinochle_engine.py Base Bid constants exactly', () => {
    expect(NEAR_RUN_VALUE).toBe(120)
    expect(NEAR_DOUBLE_PINOCHLE_VALUE).toBe(225)
    expect(ACE_VALUE).toBe(20)
    expect(MAX_BID_DEFAULT).toBe(400)
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
const SKILL_LEVELS: readonly SkillLevel[] = ['easy', 'medium', 'hard', 'proficient', 'expert']
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
    // threshold it is here to sit exactly on. No hand holding a run can land
    // on 320 any more — the floor for one is 340 — so this is built out of a
    // near-run instead: 120 + Dix 10 + Pinochle 40 + one Ace 20 = 190.
    const ceiling320Hand = [
      new Card(Suit.Hearts, 'A', 1),
      new Card(Suit.Hearts, 'K', 1),
      new Card(Suit.Hearts, 'Q', 1),
      new Card(Suit.Hearts, 'J', 1),
      new Card(Suit.Hearts, '9', 1),
      new Card(Suit.Spades, 'Q', 1),
      new Card(Suit.Diamonds, 'J', 1),
    ]
    const { trump, total } = bestBaseBid(ceiling320Hand, 0, 0)
    expect(trump).toBe(Suit.Hearts)
    expect(total).toBe(OPENER_THRESHOLD) // 190 of hand value + baseline adj 130

    // 4th bidder (dealer), partner (seat 2) has passed, nobody has bid.
    const context: AuctionContext = {
      everBid: false,
      passesSoFar: 3,
      bidHistory: [],
      dealer: 0,
      scores: { 0: 0, 1: 0 },
      passedPlayers: [2],
    }
    expect(chooseBid(0, ceiling320Hand, OPENING_BID - 10, 10, context, 'medium')).toBe(PARTNER_PASSED_FLOOR)
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
  // Ceiling 400 — clears PARTNER_RAISE_FLOOR with room above it. It read 360
  // before #242 paid the second Royal Marriage this hand has always held.
  const strongHand = [
    ...RUN_RANKS.map((r) => new Card(Suit.Hearts, r, 1)),
    new Card(Suit.Hearts, 'K', 2),
    new Card(Suit.Hearts, 'Q', 2),
    new Card(Suit.Spades, 'A', 1),
  ]
  // Ceiling 320 — opens happily, but cannot support a 340 commitment. This was
  // a trump Run plus an off-suit Ace, which #242 moved to 360 and straight over
  // the floor this fixture exists to sit under; a near-run of the same value
  // takes its place (120 + Dix 10 + Pinochle 40 + one Ace 20 + adj 130).
  const modestHand = [
    new Card(Suit.Hearts, 'A', 1),
    new Card(Suit.Hearts, 'K', 1),
    new Card(Suit.Hearts, 'Q', 1),
    new Card(Suit.Hearts, 'J', 1),
    new Card(Suit.Hearts, '9', 1),
    new Card(Suit.Spades, 'Q', 1),
    new Card(Suit.Diamonds, 'J', 1),
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
    expect(bestBaseBid(strongHand, 0, 0).total).toBe(400)
    // Every one of these used to answer `partnerBid + 10` — 270 over a 260 —
    // while requiring a 340-worthy hand to say it.
    for (const partnerBid of [260, 270, 280, 290, 300, 310, 320, 330]) {
      expect(chooseBid(2, strongHand, partnerBid, 10, afterPartnerRaise(partnerBid), 'hard')).toBe(
        PARTNER_RAISE_FLOOR,
      )
    }
  })

  it('still takes the ordinary next rung once the partner is already past the floor', () => {
    // The floor is a floor, not a fixed bid: above it the normal ladder applies.
    expect(chooseBid(2, strongHand, 350, 10, afterPartnerRaise(350), 'hard')).toBe(360)
  })

  it('backs off instead of being talked into a commitment it cannot make', () => {
    expect(bestBaseBid(modestHand, 0, 0).total).toBeLessThan(PARTNER_RAISE_FLOOR)
    for (const partnerBid of [260, 300, 330]) {
      expect(chooseBid(2, modestHand, partnerBid, 10, afterPartnerRaise(partnerBid), 'hard')).toBeNull()
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
          // `easy` is excluded on purpose, not because it fails: `meldOnlyBid`
          // is the deliberately-weak skill-1 path with no partner tracking of
          // any kind (see its docstring), so it never reaches this branch and
          // answers the plain next rung. Sweeping it here would assert that
          // skill 1 has partner logic, which is the opposite of what it is for.
          for (const level of SKILL_LEVELS.filter((l) => l !== 'easy')) {
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
      expect(chooseBid(2, weakHand, oppBid, 10, context, 'hard')).toBe(oppBid + 10)
    }
  })
})

// -- openingPolicy: 'walk' (#204) -------------------------------------------
//
// No shipped `SKILL_PARAMS` row selects `'walk'`, so these install it the way
// `abRun.ts` does. The measurement said `'fixed'` wins on score margin and the
// dial ships off; these exist so the arm stays correct and re-measurable rather
// than rotting into something the harness can no longer trust.
describe("openingPolicy: 'walk'", () => {
  // Base Bid 250 (Run 150 + two Royal Marriages 80 + Ace 20) -> ceiling 380 at
  // the 0/0 adjustment, so it clears OPENER_THRESHOLD and has room above the
  // opening rung for the walk to actually climb into.
  const strongHand = [
    ...RUN_RANKS.map((r) => new Card(Suit.Hearts, r, 1)),
    new Card(Suit.Hearts, 'K', 2),
    new Card(Suit.Hearts, 'Q', 2),
  ]

  // Dealer 1, so dealer-protection (which keys off the partner being dealer)
  // does not fire and the opening branch is a hand judgement.
  const context: AuctionContext = {
    everBid: false,
    passesSoFar: 0,
    bidHistory: [],
    dealer: 1,
    scores: { 0: 0, 1: 0 },
    passedPlayers: [],
  }

  const withWalk = (level: SkillLevel, run: () => void) => {
    const saved = SKILL_PARAMS[level]
    SKILL_PARAMS[level] = { ...saved, openingPolicy: 'walk' }
    try {
      run()
    } finally {
      SKILL_PARAMS[level] = saved
    }
  }

  it('opens above OPENING_BID on a hand worth more than the opening rung', () => {
    // The defect #204 names: `'fixed'` prices this hand at whatever rung the
    // auction happens to start on, however much it is holding.
    expect(chooseBid(0, strongHand, OPENING_BID - 10, 10, context, 'hard')).toBe(OPENING_BID)
    withWalk('hard', () => {
      expect(chooseBid(0, strongHand, OPENING_BID - 10, 10, context, 'hard')).toBeGreaterThan(OPENING_BID)
    })
  })

  it('never opens a hand that would have passed — it changes price, not appetite', () => {
    // `openingLevelFor` runs only once `opens` is already true, so both arms
    // open on an identical set of deals. That is what lets #204's A/B attribute
    // its result to the level named and not to a change in how often the AI
    // bids at all.
    const realRandom = Math.random
    Math.random = seededRandom(20260820)
    try {
      for (let i = 0; i < 100; i++) {
        const deck = new Deck()
        deck.shuffle()
        const hands = deck.deal()
        for (const level of ['medium', 'hard'] as SkillLevel[]) {
          for (const seat of SEATS) {
            const fixed = chooseBid(seat, hands[seat], OPENING_BID - 10, 10, context, level)
            withWalk(level, () => {
              const walked = chooseBid(seat, hands[seat], OPENING_BID - 10, 10, context, level)
              expect(walked === null).toBe(fixed === null)
            })
          }
        }
      }
    } finally {
      Math.random = realRandom
    }
  })

  it('stays on the multiple-of-ten grid and never exceeds the hand ceiling (#177)', () => {
    const realRandom = Math.random
    Math.random = seededRandom(4242)
    try {
      withWalk('hard', () => {
        for (let i = 0; i < 200; i++) {
          const deck = new Deck()
          deck.shuffle()
          const hands = deck.deal()
          const opened = chooseBid(0, hands[0], OPENING_BID - 10, 10, context, 'hard')
          if (opened === null) continue
          expect(opened % 10).toBe(0)
          expect(opened).toBeGreaterThanOrEqual(OPENING_BID)
          // The walk is ceiling-bounded; the opening *floor* is not — a
          // distilled seat may take OPENING_BID on a hand whose speculative
          // ceiling is under it, and always could. What must never happen is
          // the walk carrying a seat above what its cards are worth.
          expect(opened).toBeLessThanOrEqual(Math.max(OPENING_BID, bestBaseBid(hands[0], 0, 0).total))
        }
      })
    } finally {
      Math.random = realRandom
    }
  })

  it('leaves every shipped level on the fixed opening rung', () => {
    for (const level of SKILL_LEVELS) {
      expect(SKILL_PARAMS[level].openingPolicy).toBe('fixed')
    }
  })
})

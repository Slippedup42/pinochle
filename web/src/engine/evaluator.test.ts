// Behaviour of the distilled evaluator and of the skill dial that gates it
// (#114). Numerical agreement with Python lives in `evaluatorParity.test.ts`;
// this file is about the things parity cannot check — that the wiring is
// hooked up, that the two models stay apart, and that the evaluator responds to
// the bid level, which is the whole reason it replaces a fixed threshold.

import { describe, expect, it } from 'vitest'
import { type AuctionContext, chooseBid } from './bidding'
import { Card, OPENING_BID, type Rank, Suit } from './card'
import { evaluateBid, evaluateFold, modelLogit, shouldBid } from './evaluator'
import { BID_MODEL, FOLD_MODEL, MODEL_PROVENANCE } from './evaluatorModel'
import { SKILL_PARAMS } from './skills'

const RUN_RANKS: readonly Rank[] = ['A', '10', 'K', 'Q', 'J']

/** A full Hearts Run plus a second royal marriage, an off-suit marriage and
 *  filler. Ceiling 360: Run 150 + extra Royal Marriage 40 + Common Marriage 20
 *  + one Ace 20, plus the 130 baseline competitive adjustment. */
const strongHand = [
  ...RUN_RANKS.map((r) => new Card(Suit.Hearts, r, 1)),
  new Card(Suit.Hearts, 'K', 2),
  new Card(Suit.Hearts, 'Q', 2),
  new Card(Suit.Spades, 'K', 1),
  new Card(Suit.Spades, 'Q', 1),
  new Card(Suit.Clubs, '9', 1),
  new Card(Suit.Clubs, '9', 2),
  new Card(Suit.Diamonds, '9', 1),
]

/** Same ceiling (360) as `strongHand`, reached without a Run: five Spades
 *  headed A-10-K-Q, two side marriages, two Aces. The pair is the point — a
 *  threshold on the ceiling cannot tell these two hands apart at any level. */
const middlingHand = [
  new Card(Suit.Spades, 'A', 1),
  new Card(Suit.Spades, 'K', 1),
  new Card(Suit.Spades, 'Q', 1),
  new Card(Suit.Spades, '10', 1),
  new Card(Suit.Spades, '9', 1),
  new Card(Suit.Hearts, 'K', 1),
  new Card(Suit.Hearts, 'Q', 1),
  new Card(Suit.Clubs, 'A', 1),
  new Card(Suit.Clubs, 'J', 1),
  new Card(Suit.Diamonds, 'J', 1),
  new Card(Suit.Diamonds, '9', 1),
  new Card(Suit.Hearts, '9', 1),
]

/** Eight nines and four jacks: no meld, no aces, ceiling 190. */
const hopelessHand = [
  new Card(Suit.Clubs, '9', 1),
  new Card(Suit.Clubs, '9', 2),
  new Card(Suit.Diamonds, '9', 1),
  new Card(Suit.Diamonds, '9', 2),
  new Card(Suit.Hearts, '9', 1),
  new Card(Suit.Hearts, '9', 2),
  new Card(Suit.Spades, '9', 1),
  new Card(Suit.Spades, '9', 2),
  new Card(Suit.Clubs, 'J', 1),
  new Card(Suit.Diamonds, 'J', 1),
  new Card(Suit.Hearts, 'J', 1),
  new Card(Suit.Spades, 'J', 2),
]

const at = (hand: readonly Card[], bid: number) => ({
  hand,
  bid,
  ourScore: 0,
  theirScore: 0,
  partnerHasBid: false,
  partnerHasPassed: false,
})

const situation = (bid: number) => at(strongHand, bid)

describe('the exported model', () => {
  it('carries the provenance of the configuration it was fitted against', () => {
    // A model fitted against a strategy flag that has since flipped is worse
    // than no model, so the artefact says what it describes rather than
    // leaving a reader to assume.
    expect(MODEL_PROVENANCE.datasetRows).toBe(2000)
    expect(MODEL_PROVENANCE.formatVersion).toBe(1)
  })

  it('keeps the fold model free of the game score and the auction flags', () => {
    // Not an accident to be tidied up later: `should_fold` was measured with
    // the scores withheld, so `verdict_fold` is mathematically independent of
    // the score and any weight fitted on it would be fitting noise. The
    // partner flags are constant-false on every fold row — the auction is over.
    expect(FOLD_MODEL.features).not.toContain('score_diff')
    expect(FOLD_MODEL.features).not.toContain('partner_has_bid')
    expect(FOLD_MODEL.features).not.toContain('partner_has_passed')
    expect(BID_MODEL.features).toContain('score_diff')
  })

  it('refuses to score one model with the other model\'s features', () => {
    // The two are fitted on disjoint rows with different feature lists, so
    // crossing them is meaningless rather than merely inaccurate. Missing
    // features throw instead of defaulting to zero, which for columns like
    // `bidding_meld` would be a real value and a plausible wrong answer.
    const bidFeatures = evaluateBid(situation(OPENING_BID)).features
    expect(() => modelLogit(FOLD_MODEL, bidFeatures)).toThrow(/bidding_meld/)
  })
})

describe('the bid model responds to the level, not just the hand', () => {
  // The point of replacing OPENER_THRESHOLD. A ceiling threshold answers
  // "is this hand good" once and applies the answer at every level; the same
  // hand is a different proposition at 310 than at 400.
  it('is less willing as the contract climbs', () => {
    const levels = [300, 320, 340, 360, 400]
    const probabilities = levels.map((bid) => evaluateBid(situation(bid)).probability)
    for (let i = 1; i < probabilities.length; i++) {
      expect(probabilities[i]).toBeLessThan(probabilities[i - 1])
    }
  })

  it('separates two hands of identical ceiling by what the shape can carry', () => {
    // Both hands value at 360, so `ceiling >= OPENER_THRESHOLD` gives them the
    // same answer at every level — that is the limitation being replaced. The
    // evaluator takes both at 300, and at 400 keeps only the one holding a Run.
    expect(evaluateBid(at(strongHand, OPENING_BID)).ceiling).toBe(360)
    expect(evaluateBid(at(middlingHand, OPENING_BID)).ceiling).toBe(360)

    expect(shouldBid(at(strongHand, OPENING_BID))).toBe(true)
    expect(shouldBid(at(middlingHand, OPENING_BID))).toBe(true)

    expect(shouldBid(at(strongHand, 400))).toBe(true)
    expect(shouldBid(at(middlingHand, 400))).toBe(false)
  })

  it('never takes a hopeless hand, at any level', () => {
    for (const bid of [OPENING_BID, 320, 340, 400]) {
      expect(shouldBid(at(hopelessHand, bid))).toBe(false)
    }
  })

  it('names the same trump bestBaseBid does, since that is where the ceiling comes from', () => {
    expect(evaluateBid(at(strongHand, OPENING_BID)).trump).toBe(Suit.Hearts)
    expect(evaluateBid(at(middlingHand, OPENING_BID)).trump).toBe(Suit.Spades)
  })
})

describe('the fold model', () => {
  it('concedes a contract the bidding side cannot reach and plays on when it can', () => {
    const hopeless = evaluateFold({
      hand: hopelessHand,
      trump: Suit.Spades,
      bid: 400,
      biddingMeld: 0,
      defendingMeld: 0,
    })
    expect(hopeless.decision).toBe(true)

    const comfortable = evaluateFold({
      hand: strongHand,
      trump: Suit.Hearts,
      bid: 300,
      biddingMeld: 250,
      defendingMeld: 0,
    })
    expect(comfortable.decision).toBe(false)
  })
})

describe('the skill dial gates the evaluator (#114)', () => {
  const context: AuctionContext = {
    everBid: false,
    passesSoFar: 3,
    bidHistory: [],
    dealer: 0,
    scores: { 0: 0, 1: 0 },
    passedPlayers: [],
  }

  // Ceiling 300 — under OPENER_THRESHOLD, so the static rule passes, while the
  // evaluator opens (a full trump Run is 150 guaranteed meld). One hand, two
  // policies, which is what makes it a usable probe of the dial.
  const runOnlyHand = RUN_RANKS.map((r) => new Card(Suit.Hearts, r, 1))

  it('maps the levels the way skills.ts documents', () => {
    expect(SKILL_PARAMS.easy.bidPolicy).toBe('static')
    expect(SKILL_PARAMS.medium.bidPolicy).toBe('distilled')
    expect(SKILL_PARAMS.hard.bidPolicy).toBe('distilled')
    expect(SKILL_PARAMS.proficient.bidPolicy).toBe('static')
    expect(SKILL_PARAMS.expert.bidPolicy).toBe('static')
  })

  it('runs the static thresholds on proficient and expert', () => {
    expect(chooseBid(0, runOnlyHand, OPENING_BID - 10, 10, context, 'proficient')).toBeNull()
    expect(chooseBid(0, runOnlyHand, OPENING_BID - 10, 10, context, 'expert')).toBeNull()
  })

  it('runs the evaluator on medium and hard', () => {
    expect(chooseBid(0, runOnlyHand, OPENING_BID - 10, 10, context, 'medium')).toBe(OPENING_BID)
    expect(chooseBid(0, runOnlyHand, OPENING_BID - 10, 10, context, 'hard')).toBe(OPENING_BID)
  })

  it('leaves easy on the meld-only path, which the evaluator never enters', () => {
    // Skill 1 short-circuits before any Base Bid valuation happens, so its
    // bidding is unchanged by #114 and MELD_ONLY_TRICK_ESTIMATE stays live.
    // A lone trump Run scores 150 meld + 60 flat + noise in [-30, 30], never
    // reaching the 300 opening bid.
    expect(chooseBid(0, runOnlyHand, OPENING_BID - 10, 10, context, 'easy')).toBeNull()
  })
})

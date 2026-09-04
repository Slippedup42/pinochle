// Behaviour of the distilled evaluator and of the `bidPolicy` field that
// selects it (#114). Numerical agreement with Python lives in
// `evaluatorParity.test.ts`; this file is about the things parity cannot check
// — that the wiring is hooked up, that the two models stay apart, and that the
// evaluator responds to the bid level, which is the whole reason it replaces a
// fixed threshold.

import { describe, expect, it, vi } from 'vitest'
import { type AuctionContext, chooseBid } from './bidding'
import { Card, OPENING_BID, type Rank, Suit } from './card'
import { evaluateBid, evaluateFold, modelLogit, shouldBid } from './evaluator'
import { BID_MODEL, FOLD_MODEL, MODEL_PROVENANCE } from './evaluatorModel'
import { SHIPPED_PARAMS, SHIPPED_SKILL, SKILL_LEVELS, SKILL_PARAMS, type SkillLevel, type SkillParams } from './skills'

const RUN_RANKS: readonly Rank[] = ['A', '10', 'K', 'Q', 'J']

/** A full Hearts Run plus a second royal marriage, an off-suit marriage and
 *  filler. Ceiling 340: a bare trump Run at 150, the trump Ace at 40 (the flat
 *  Ace line and the Ace-of-trump line both), one trump past the fourth at 20,
 *  plus the 130 baseline competitive adjustment.
 *
 *  Everything but the run and the filler has now been removed twice for the
 *  same reason, and it is worth stating once. The pairing with `middlingHand`
 *  below is the entire point of this fixture and it only works at equal
 *  *uncapped* ceilings — pinning both at 400 would make "identical ceiling" an
 *  artefact of clamping instead of a statement about the two hands. #242 pushed
 *  it to the cap by paying the marriage inside the run, and the second K/Q of
 *  Hearts came out; #273 reversed that and they came back; #277 pushed it to
 *  the cap again by pricing trump length and the trump Ace, and this time the
 *  spare K/Q of Hearts and the side marriage in Spades come out for good. What
 *  is left is a run and eight cards that are worth nothing at all, which is the
 *  cheapest hand that can hold this role. */
const strongHand = [
  ...RUN_RANKS.map((r) => new Card(Suit.Hearts, r, 1)),
  new Card(Suit.Clubs, 'J', 1),
  new Card(Suit.Clubs, '9', 1),
  new Card(Suit.Clubs, '9', 2),
  new Card(Suit.Diamonds, '9', 1),
  new Card(Suit.Diamonds, '9', 2),
  new Card(Suit.Spades, '9', 1),
  new Card(Suit.Spades, '9', 2),
]

/** Same ceiling (340) as `strongHand`, reached without a Run: five Spades
 *  headed A-K-Q-10 (a near-run) with its Dix, and a side marriage in Hearts.
 *  The pair is the point — a threshold on the ceiling cannot tell these two
 *  hands apart at any level. The Jack of Diamonds it used to carry is gone
 *  along with the second Ace: with the Q(S) in the same hand that was a
 *  Pinochle, which #277 now pays an extra 20 for holding no King of Spades. */
const middlingHand = [
  new Card(Suit.Spades, 'A', 1),
  new Card(Suit.Spades, 'K', 1),
  new Card(Suit.Spades, 'Q', 1),
  new Card(Suit.Spades, '10', 1),
  new Card(Suit.Spades, '9', 1),
  new Card(Suit.Hearts, 'K', 1),
  new Card(Suit.Hearts, 'Q', 1),
  new Card(Suit.Hearts, 'J', 1),
  new Card(Suit.Hearts, '9', 1),
  new Card(Suit.Clubs, 'J', 1),
  new Card(Suit.Clubs, '9', 1),
  new Card(Suit.Diamonds, '9', 1),
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
    // Both hands value at 340, so `ceiling >= OPENER_THRESHOLD` gives them the
    // same answer at every level — that is the limitation being replaced. The
    // evaluator takes both at 300, and at 400 keeps only the one holding a Run.
    // Asserted as equality to each other first, because *equal* is the property
    // and the number has moved three times (#242, #273, #277) without the
    // property changing. The companion assertion that both sit under the 400
    // cap went with the cap itself (#283): with nothing clamped, two hands
    // cannot be made falsely equal by both hitting a ceiling.
    expect(evaluateBid(at(strongHand, OPENING_BID)).ceiling).toBe(
      evaluateBid(at(middlingHand, OPENING_BID)).ceiling,
    )
    expect(evaluateBid(at(strongHand, OPENING_BID)).ceiling).toBe(340)

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

/**
 * `bidPolicy` selects the bid policy (#114, opened by #115).
 *
 * This described a dial until #222 removed it. The two policies both still
 * exist and `chooseBid` still branches on the field, so the behaviour these
 * tests are about is unchanged — what changed is how the `'static'` arm is
 * reached, since no level selects it any more. `withPolicy` installs it onto a
 * slot for the duration, which is the same save/restore `abRun.installPolicies`
 * uses to seat two policies at one table.
 */
describe('bidPolicy selects the bid policy (#114, opened by #115)', () => {
  /** A slot to park an arm on. Any level would do — after #222 they are
   *  interchangeable carriers — but not `SHIPPED_SKILL`, so a leaked override
   *  could not quietly change what the rest of the suite thinks ships. */
  const AB_SLOT: SkillLevel = 'easy'

  function withPolicy<T>(patch: Partial<SkillParams>, play: (level: SkillLevel) => T): T {
    const saved = SKILL_PARAMS[AB_SLOT]
    SKILL_PARAMS[AB_SLOT] = { ...saved, ...patch }
    try {
      return play(AB_SLOT)
    } finally {
      SKILL_PARAMS[AB_SLOT] = saved
    }
  }

  const context: AuctionContext = {
    everBid: false,
    passesSoFar: 3,
    bidHistory: [],
    dealer: 0,
    scores: { 0: 0, 1: 0 },
    passedPlayers: [],
  }

  // Ceiling 300 (Run 150 + Ace 20 + adj 130) - 340 while #242 also paid the
  // marriage the run absorbs, 300 again since #273. Kept for the meld-only
  // arithmetic below, which needs a hand whose certain meld is a known number.
  const runOnlyHand = RUN_RANKS.map((r) => new Card(Suit.Hearts, r, 1))

  // Ceiling 290 — under OPENER_THRESHOLD, so the static rule passes, while the
  // evaluator opens (80 guaranteed meld and four fifths of a run). One hand,
  // two policies, which is what makes it a usable probe of the dial.
  //
  // `runOnlyHand` was that probe until #242. Paying the Royal Marriage inside
  // the run took it to 340, which the static threshold opens on too — so the
  // hand stopped separating the policies and would have gone on passing while
  // proving nothing. A near-run took over, and stays: #273 puts `runOnlyHand`
  // back under the threshold at 300, but the near-run branch is untouched by
  // both changes, which is exactly the property a fixture chosen to sit under
  // a threshold should be resting on.
  const belowThresholdHand = [
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

  it('runs the evaluator, on every seat the product deals (#115)', () => {
    // #114 pinned every level to 'static' so the model could not reach a player
    // by accident; #115 measured it and opened the gate for `hard` upward —
    // 211 deals swept to static's 50 over 1000 mirrored pairs, +227 score
    // margin per deal with a 95% CI of +198 to +257 (see src/ab/). #222 then
    // removed the levels below it, so what once read "which tiers are gated
    // on" now reads "what ships", which is the same drift guard pointed at
    // one row instead of five.
    //
    // Both halves matter. The first is the gate; the second is that no slot
    // carries a stale copy of some older configuration, since `SKILL_PARAMS`
    // is mutable and a leaked A/B override is the way that would happen.
    expect(SHIPPED_PARAMS.bidPolicy).toBe('distilled')
    for (const level of SKILL_LEVELS) {
      expect(SKILL_PARAMS[level]).toEqual(SHIPPED_PARAMS)
    }
  })

  it('separates the two policies on one hand that can be probed with', () => {
    // Ceiling 310, under OPENER_THRESHOLD, so the static rule passes while the
    // evaluator opens — one hand that reads the field's effect directly rather
    // than asserting on SKILL_PARAMS a second time. It is the same twelve-card
    // hand `bidding.test.ts` calls `belowOpenerHand`; see the note there for
    // why #277 forced a full hand rather than a six-card sketch.
    withPolicy({ bidPolicy: 'static' }, (level) => {
      expect(chooseBid(0, belowThresholdHand, OPENING_BID - 10, 10, context, level)).toBeNull()
    })
    expect(chooseBid(0, belowThresholdHand, OPENING_BID - 10, 10, context, SHIPPED_SKILL)).toBe(OPENING_BID)
  })

  it('opens this hand when the evaluator is consulted directly', () => {
    // The same decision as above with the dial taken out of the picture: two
    // Royal Marriages and the Dix are 90 guaranteed meld behind six trump, and
    // the model takes the contract on it where a threshold on the ceiling alone
    // does not.
    expect(
      shouldBid({
        hand: belowThresholdHand,
        bid: OPENING_BID,
        ourScore: 0,
        theirScore: 0,
        partnerHasBid: false,
        partnerHasPassed: false,
      }),
    ).toBe(true)
  })

  it('keeps the meld-only path short-circuiting before the evaluator', () => {
    // `handValuation: 'meld_only'` short-circuits before any Base Bid valuation
    // happens, so that arm is unchanged by #114 and MELD_ONLY_TRICK_ESTIMATE
    // stays live. `easy` selected it until #222 removed the dial; it is
    // installed here for the same reason `'static'` is above.
    // This hand melds 150 under Hearts (a bare Run, whose Royal Marriage the Run
    // absorbs - #273), so the meld-only ceiling is 150 + 60 flat + noise in
    // [-30, 30] = [180, 240]. It read [220, 280] while #242 paid that marriage.
    //
    // The noise stays pinned even though it no longer has to be. #200's 250
    // opener sat *inside* [220, 280], which turned a bare `toBeNull()` into a
    // coin flip that passed roughly half the time; #257 put the opener back to
    // 300 and the whole range falls short again, so the bare assertion would be
    // deterministic once more. Pinning is kept because it asserts the
    // arithmetic rather than the outcome: both extremes are named, and the
    // upper one records how far short the miss is. If either
    // MELD_ONLY_TRICK_ESTIMATE or the opening rung moves back toward the other,
    // this fails on the specific number instead of going quietly random.
    const random = vi.spyOn(Math, 'random')
    try {
      withPolicy({ handValuation: 'meld_only' }, (meldOnly) => {
        random.mockReturnValue(0) // noise -30 -> ceiling 180, 120 under the opener
        expect(chooseBid(0, runOnlyHand, OPENING_BID - 10, 10, context, meldOnly)).toBeNull()
        expect(chooseBid(0, runOnlyHand, OPENING_BID - 10, 10, context, SHIPPED_SKILL)).toBe(OPENING_BID)

        random.mockReturnValue(1) // noise +30 -> ceiling 240, still 60 under it
        expect(chooseBid(0, runOnlyHand, OPENING_BID - 10, 10, context, meldOnly)).toBeNull()
        expect(chooseBid(0, runOnlyHand, OPENING_BID - 10, 10, context, SHIPPED_SKILL)).toBe(OPENING_BID)
      })
    } finally {
      random.mockRestore()
    }
  })
})

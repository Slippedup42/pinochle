// #326: the off-by-default `LOOSE_KQ_PASS_ONLY` reading of Paul's written
// valuation (`pinochle_valuation.md`): "for every K or Q that is not a marriage
// *and you will pass* - 20". Mirrors `test_loose_kq_pass_only.py` hand for
// hand; Python's `compute_trick_potential` is the reference.

import { afterEach, describe, expect, it } from 'vitest'
import {
  ACE_VALUE,
  bestBaseBid,
  chooseTrump,
  computeMaxBid,
  computeTrickPotential,
  EXTRA_TRUMP_VALUE,
  LOOSE_KING_VALUE,
  LOOSE_KQ_PASS_ONLY,
  LOOSE_KQ_PASSED_VALUE,
  LOOSE_QUEEN_VALUE,
  TRUMP_ACE_VALUE,
} from './bidding'
import { Card, Deck, type Rank, Suit, SUITS } from './card'
import { evaluateBid } from './evaluator'
import { bidderPassSelection } from './passing'
import { SHIPPED_PARAMS, SKILL_PARAMS, type SkillLevel, type SkillParams } from './skills'

const H = Suit.Hearts
const C = Suit.Clubs
const D = Suit.Diamonds
const S = Suit.Spades
const PASSED_LABEL = 'Unmarried K/Q going into the pass'

function hand(...specs: [Rank, Suit][]): Card[] {
  const seen = new Map<string, number>()
  return specs.map(([rank, suit]) => {
    const key = `${rank}${suit}`
    const copy = (seen.get(key) ?? 0) + 1
    seen.set(key, copy)
    return new Card(suit, rank, copy as 1 | 2)
  })
}

// Hearts trump. K(C) and Q(D) are loose, and the bidder's spare-K/Q tier sends
// both (the third card is the unprotected 10 of diamonds).
const BOTH_PASSED = hand(
  ['A', H], ['10', H], ['K', H], ['Q', H], ['J', H],
  ['A', C], ['K', C], ['9', C], ['9', C],
  ['A', D], ['Q', D], ['10', D],
)

// Hearts trump. K(S), K(C), K(D) are all loose. K(S) is a singleton suit, so
// the void tier sends it; K(C) and K(D) each hold up Kings Around, so the
// spare-K tier skips them and they are kept.
const ONE_PASSED_TWO_KEPT = hand(
  ['A', H], ['10', H], ['K', H], ['Q', H], ['J', H],
  ['A', C], ['K', C], ['9', C],
  ['A', D], ['K', D], ['9', D],
  ['K', S],
)

const NON_KQ_LINES = 3 * ACE_VALUE + TRUMP_ACE_VALUE + EXTRA_TRUMP_VALUE

const names = (cards: readonly Card[]) => cards.map((c) => `${c.rank}${c.suit}`).sort()

describe('LOOSE_KQ_PASS_ONLY (#326)', () => {
  it('ships off, with the shipped loose values untouched', () => {
    expect(LOOSE_KQ_PASS_ONLY).toBe(false)
    expect(SHIPPED_PARAMS.looseKqPolicy).toBe(LOOSE_KQ_PASS_ONLY ? 'passOnly' : 'flat')
    expect(LOOSE_KQ_PASSED_VALUE).toBe(20)
    expect(LOOSE_KING_VALUE).toBe(30)
    expect(LOOSE_QUEEN_VALUE).toBe(20)
  })

  it('uses fixture hands that pass what the tests say they pass', () => {
    expect(names(bidderPassSelection(BOTH_PASSED, H, 'HC', 3))).toEqual(
      names([new Card(C, 'K', 1), new Card(D, 'Q', 1), new Card(D, '10', 1)]),
    )
    expect(names(bidderPassSelection(ONE_PASSED_TWO_KEPT, H, 'HC', 3))).toEqual(
      names([new Card(S, 'K', 1), new Card(C, '9', 1), new Card(D, '9', 1)]),
    )
  })

  it('flag off is the flat rule', () => {
    const both = computeTrickPotential(BOTH_PASSED, H)
    expect(both.breakdown['Unmarried Kings']).toBe(LOOSE_KING_VALUE)
    expect(both.breakdown['Unmarried Queens']).toBe(LOOSE_QUEEN_VALUE)
    expect(both.breakdown[PASSED_LABEL]).toBeUndefined()
    expect(both.total).toBe(NON_KQ_LINES + LOOSE_KING_VALUE + LOOSE_QUEEN_VALUE)

    const kept = computeTrickPotential(ONE_PASSED_TWO_KEPT, H)
    expect(kept.breakdown['Unmarried Kings']).toBe(3 * LOOSE_KING_VALUE)
    expect(kept.total).toBe(NON_KQ_LINES + 3 * LOOSE_KING_VALUE)
  })

  it('flag on pays 20 for a passed King or Queen alike', () => {
    const { total, breakdown } = computeTrickPotential(BOTH_PASSED, H, true)
    expect(breakdown[PASSED_LABEL]).toBe(2 * LOOSE_KQ_PASSED_VALUE)
    expect(breakdown['Unmarried Kings']).toBeUndefined()
    expect(breakdown['Unmarried Queens']).toBeUndefined()
    expect(total).toBe(NON_KQ_LINES + 2 * LOOSE_KQ_PASSED_VALUE)
  })

  it('flag on pays nothing for a kept King or Queen', () => {
    const { total, breakdown } = computeTrickPotential(ONE_PASSED_TWO_KEPT, H, true)
    expect(breakdown[PASSED_LABEL]).toBe(LOOSE_KQ_PASSED_VALUE)
    expect(total).toBe(NON_KQ_LINES + LOOSE_KQ_PASSED_VALUE)
  })

  it('flag off leaves every valuation unchanged on random deals', () => {
    for (let i = 0; i < 200; i++) {
      const deck = new Deck()
      deck.shuffle()
      const cards = deck.cards.slice(0, 12)
      for (const t of SUITS) {
        expect(computeMaxBid(cards, t, 300, 500)).toEqual(computeMaxBid(cards, t, 300, 500, false))
      }
      expect(bestBaseBid(cards)).toEqual(bestBaseBid(cards, 0, 0, false))
      const situation = {
        hand: cards,
        bid: 330,
        ourScore: 0,
        theirScore: 0,
        partnerHasBid: false,
        partnerHasPassed: false,
      }
      expect(evaluateBid(situation)).toEqual(evaluateBid({ ...situation, looseKqPassOnly: false }))
    }
  })

  describe('as a seat policy', () => {
    const level: SkillLevel = 'hard'
    const saved: SkillParams = SKILL_PARAMS[level]
    afterEach(() => {
      SKILL_PARAMS[level] = saved
    })

    it("reaches the seat's trump choice and the evaluator's ceiling", () => {
      expect(chooseTrump(ONE_PASSED_TWO_KEPT, level)).toBe(bestBaseBid(ONE_PASSED_TWO_KEPT).trump)
      SKILL_PARAMS[level] = { ...saved, looseKqPolicy: 'passOnly' }
      expect(chooseTrump(ONE_PASSED_TWO_KEPT, level)).toBe(bestBaseBid(ONE_PASSED_TWO_KEPT, 0, 0, true).trump)

      const situation = {
        hand: ONE_PASSED_TWO_KEPT,
        bid: 330,
        ourScore: 0,
        theirScore: 0,
        partnerHasBid: false,
        partnerHasPassed: false,
      }
      expect(evaluateBid({ ...situation, looseKqPassOnly: true }).ceiling).toBe(
        bestBaseBid(ONE_PASSED_TWO_KEPT, 0, 0, true).total,
      )
      expect(evaluateBid({ ...situation, looseKqPassOnly: true }).ceiling).toBeLessThan(
        evaluateBid(situation).ceiling,
      )
    })
  })
})

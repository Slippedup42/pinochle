// What a raise is worth, as numbers, so a seat can say why it raised.
//
// The raise ladder in `bidding.ts` used to be a number against a number: bid
// the next rung while it sits under the hand's Max Bid ceiling. That says
// nothing about what a rung is *worth*, and it cannot say why a seat would
// bid past the number it was told - which Paul asked for on 2026-10-10: the
// AI should understand why it pushes above 320, not have 320 hardcoded.
//
// Two value functions, in score-differential points from our side, for a hand
// with features `x` and a contract level `b`:
//
//   T(x, b)  we hold the contract at b
//   D(x, b)  an opponent holds it at b and we defend
//
// and one probability, `s(r)`: given an opponent bid `r - 10`, the chance they
// cannot answer a bid of `r` (their own ceiling is under it).
//
// A seat facing a standing bid `c` may raise to `r = c + step`. If the opponent
// cannot answer, the seat holds the contract at `r` (T). If they can, they
// hold it at `r + step` against us (D) - which is *better* for us than
// defending at `c`, because every rung they take costs them. The raise is
// worth taking when
//
//   s(r) * T(x, r) + (1 - s(r)) * D(x, r + step)  >  D(x, c)
//
// Pushing is therefore a trade, not a floor: what being left holding the
// contract costs against what each rung costs the other side. The tables are
// fitted by `fit_rung_value.py`, which carries the method and the caveats.

import { computeBaseBid, computeTrickPotential } from './bidding'
import type { Card, Suit } from './card'
import {
  RUNG_DEFEND,
  RUNG_LEVELS,
  RUNG_STOP,
  RUNG_TAKE,
  THIRD_OPEN_COEF,
  THIRD_OPEN_THETA,
} from './rungValueModel'

const FIRST_LEVEL = RUNG_LEVELS[0]
const LAST_LEVEL = RUNG_LEVELS[RUNG_LEVELS.length - 1]

/**
 * The seven features the tables were fitted on, in `RUNG_FEATURES` order:
 * constant, Base Bid, trick potential, trump length, Aces, trump Aces, nines.
 * Valued at the trump the seat would name, and at 0-0: the model prices the
 * hand, and the score reaches the decision through the gates around it.
 */
export function rungFeatures(hand: readonly Card[], trump: Suit): number[] {
  let trumpLength = 0
  let aces = 0
  let trumpAces = 0
  let nines = 0
  for (const c of hand) {
    if (c.suit === trump) trumpLength++
    if (c.rank === 'A') {
      aces++
      if (c.suit === trump) trumpAces++
    }
    if (c.rank === '9') nines++
  }
  return [
    1,
    computeBaseBid(hand, trump).total,
    computeTrickPotential(hand, trump).total,
    trumpLength,
    aces,
    trumpAces,
    nines,
  ]
}

function dot(coefficients: readonly number[], x: readonly number[]): number {
  let total = 0
  for (let i = 0; i < coefficients.length; i++) total += coefficients[i] * x[i]
  return total
}

/** The table at `level`, interpolated between fitted levels and held flat
 *  outside them (levels under 300 are not bids a raise can reach). */
function atLevel<T>(level: number, read: (fitted: number) => T, mix: (a: T, b: T, w: number) => T): T {
  if (level <= FIRST_LEVEL) return read(FIRST_LEVEL)
  if (level >= LAST_LEVEL) return read(LAST_LEVEL)
  const lower = FIRST_LEVEL + Math.floor((level - FIRST_LEVEL) / 10) * 10
  const weight = (level - lower) / 10
  return weight === 0 ? read(lower) : mix(read(lower), read(lower + 10), weight)
}

const lerp = (a: number, b: number, w: number) => a + (b - a) * w

/** T(x, b): what holding the contract at `level` is worth to the seat. */
export function takeValue(x: readonly number[], level: number): number {
  return atLevel(level, (l) => dot(RUNG_TAKE[l], x), lerp)
}

/** D(x, b): what defending an opponent's contract at `level` is worth. */
export function defendValue(x: readonly number[], level: number): number {
  return atLevel(level, (l) => dot(RUNG_DEFEND[l], x), lerp)
}

/** s(r): the chance an opponent who bid `r - step` cannot answer a bid of `r`. */
export function stopProbability(level: number): number {
  return atLevel(level, (l) => RUNG_STOP[l], lerp)
}

/**
 * The third seat's open, as the same kind of comparison: the value of opening
 * at 300 minus the value of passing and leaving the dealer holding the
 * contract (at its own opening if it has the hand, at the forced 250 if it has
 * not), as a linear score of the hand. Fitted by `fit_rung_value.py fit-third`;
 * the method and its proxies are in that file's docstring.
 */
export function thirdSeatScore(hand: readonly Card[], trump: Suit): number {
  return dot(THIRD_OPEN_COEF, rungFeatures(hand, trump))
}

/**
 * Whether the third seat opens at 300. The threshold is set so the model opens
 * as often as the 320 floor does, which is where a ceiling floor measured
 * best; the model's contribution is *which* hands, ranked by what they are
 * worth against the dealer's alternative rather than by one number.
 */
export function thirdSeatOpens(hand: readonly Card[], trump: Suit): boolean {
  return thirdSeatScore(hand, trump) >= THIRD_OPEN_THETA
}

export interface RungDecision {
  /** True when raising to `level` beats letting the opponent keep `current`. */
  readonly raise: boolean
  readonly level: number
  /** Value of raising: s*T(level) + (1-s)*D(level + step). */
  readonly raiseValue: number
  /** Value of passing: D(current). */
  readonly passValue: number
  readonly stop: number
}

/**
 * Should a seat that holds `hand` (valued at `trump`) raise an opponent's
 * standing bid `current` by one `step`?
 */
export function rungDecision(
  hand: readonly Card[],
  trump: Suit,
  current: number,
  step: number,
): RungDecision {
  const x = rungFeatures(hand, trump)
  const level = current + step
  const stop = stopProbability(level)
  const raiseValue = stop * takeValue(x, level) + (1 - stop) * defendValue(x, level + step)
  const passValue = defendValue(x, current)
  return { raise: raiseValue > passValue, level, raiseValue, passValue, stop }
}

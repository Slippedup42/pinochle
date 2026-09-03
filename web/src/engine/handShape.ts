// Hand-shape predicates — shared by the valuation and the pass.
//
// These say something about the *cards* rather than about a decision, so they
// live above both consumers instead of inside either. #276 put `isProtectedTen`
// in `passing.ts` because passing was the only caller; #277 gave the same rule a
// price in `computeTrickPotential`, and a bidding predicate reached for out of
// the passing module is exactly the shape that lets two statements of one rule
// drift apart. One definition, two readers.
//
// `card.ts` was the other candidate and was rejected: it is the rules module —
// deck, rank order, the bid rungs — and this is strategy, which the two engines
// are allowed to diverge on (#213) in a way they are not allowed to diverge on
// the deck. Ported from the matching section in `pinochle_engine.py`, which
// stays authoritative for the predicate itself.

import { type Card, handCount, type Suit } from './card'

/**
 * Is this a non-trump 10 that the hand's own Aces make a winner?
 *
 * Paul's ruling, 2026-09-02, from live play: a non-trump 10 is **protected**
 * when the hand holds BOTH Aces of that suit. Two reasons, either of which is
 * sufficient:
 *
 * - **Held**: with both Aces of the suit in this hand, the suit can be played
 *   out last and the 10 takes the trick behind them.
 * - **Passed**: a 10 delivered to a partner holding the Ace becomes a
 *   20-point trick when the Ace is led and the 10 falls on it.
 *
 * Two consequences, and they are one ruling read at two moments. At a *pass*
 * (#276) a protected 10 must not be shed ahead of ordinary filler; which of the
 * two reasons applies there is worth being precise about, because it settles
 * where the card belongs. If *this* hand holds both Aces then the other hand
 * holds none, so passing this 10 cannot buy the drop-on-partner's-Ace trick.
 * All of the value is in keeping the suit intact and cashing it late, which is
 * why the pass tiers rank a protected 10 *behind* ordinary filler rather than
 * ahead of it. At a *bid* (#277) the same card is worth `PROTECTED_TEN_VALUE`,
 * for the first of those two reasons: it is a trick this hand can cash.
 *
 * Deliberately narrow, per issue #276. A 10 behind a single Ace is only
 * partially protected and is NOT covered here; trump 10s are run cards and were
 * never in scope. This is a different notion from the `isProtected` closure in
 * `bidderPassSelection`, which means "trump, or Q(S), or J(D)" - i.e. meld
 * significance - and the two must not be folded together.
 */
export function isProtectedTen(hand: readonly Card[], trump: Suit, card: Card): boolean {
  return card.rank === '10' && card.suit !== trump && handCount(hand, card.suit, 'A') === 2
}

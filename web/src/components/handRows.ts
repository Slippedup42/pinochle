/** Above this many cards the hand needs a second row to fit a narrow phone. Six
 *  64px cards at the 44px pitch span 284px, inside the ~304px a 320px viewport
 *  leaves once the board's padding is off. */
const MAX_SINGLE_ROW = 6

/**
 * Splits the human's hand into the rows it is dealt across (#187).
 *
 * One row of 12 put the fan at `11 * 24 + 64 = 328px`, which fits a 390px phone
 * with 46px to spare and a 360px phone with none — below about 350px it
 * overflowed, and because that row is `justify-center` *and* `overflow-x-auto` an
 * overflowing fan centres inside its own scroll box: cards clipped off the right,
 * the leading ones unreachable at `scrollLeft: 0`, and nothing on screen saying
 * the rest exists. That is "you can only see half your hand".
 *
 * Two rows halve the width that has to fit, which buys back enough room to widen
 * the reveal from 24px — a corner index and little else — to most of the card.
 *
 * Split by **count, not by suit**. Paul suggested pairing suits (spades/diamonds,
 * hearts/clubs) and the intent behind it is right, but suit counts are not
 * balanced: nine spades and three hearts is an ordinary hand, and that split would
 * put nine cards in one row and rebuild the overflow this exists to remove.
 * `sortHandForDisplay` already groups by suit, so an even split keeps suits
 * contiguous in practice while staying bounded in the worst case.
 *
 * The larger half goes on top, so an odd hand grows upward rather than leaving a
 * short trailing row under a full one. A hand at or under `MAX_SINGLE_ROW` stays
 * on one row rather than rendering two rows of one card each as the last tricks
 * play out.
 *
 * Lives in its own module rather than in `Seat.tsx` so that file exports only its
 * component (oxlint's `react(only-export-components)` — a mixed module breaks
 * fast refresh).
 */
export function splitHandIntoRows<T>(cards: readonly T[]): readonly (readonly T[])[] {
  if (cards.length <= MAX_SINGLE_ROW) return [cards]
  const top = Math.ceil(cards.length / 2)
  return [cards.slice(0, top), cards.slice(top)]
}

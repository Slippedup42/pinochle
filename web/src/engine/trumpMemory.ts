// Skill-capped trump memory (#157) — a capacity-limited *view* of which trump
// have been seen this round, in meld and in play.
//
// Trick-play *rules* are identical at every skill level (#156): every seat runs
// the same cascade in `tracker.ts`. This module is the one thing the skill dial
// still changes during trick play — not the decision, the information the
// decision is made on. Same reasoning, worse recall.
//
// Why this is a sibling of `PlayTracker` rather than a subclass or a wrapper:
// `PlayTracker` stores counts, not order, and order is exactly what a capacity
// limit needs — "the oldest sighting is the one you forget" is unanswerable
// from a count. So `TrumpMemory` observes card sightings itself, on the same
// feed. `PlayTracker` is left counting perfectly, deliberately: the parity
// fixtures (`engineParity.*`) and `chooseFollowCard`'s trump-secure test depend
// on exact counts, and degrading it in place would break both.
//
// SCOPE — trump only, and knowingly lopsided. Non-trump counting stays perfect
// via `PlayTracker`, so an `easy` seat has flawless recall of the side suits and
// remembers only 2 of the 12 trump. That is odd on its face and it is the
// accepted simplification (#157): trump counting is the thing that separates a
// weak player from a strong one, so it is the thing that is modelled first. Not
// a bug to be fixed in passing — if side-suit memory should degrade too, that is
// its own issue with its own measurement.
//
// INERT ON ARRIVAL. Nothing constructs a `TrumpMemory` yet; the consumer is
// #158, which uses it to answer "is my 10 the boss card now" instead of
// guessing. Landing it unwired keeps the eventual behaviour change measurable on
// its own, the way #114 landed the bid evaluator switched on for nobody so #115
// could measure it, and the way #153 landed the play-policy dial.

import type { SkillLevel } from '../persistence/options'
import type { Card, CopyId, Rank, Suit } from './card'

/**
 * How many of the 12 trump a seat can hold in mind at once: **2 x skill level**,
 * skill 1 (`easy`) through skill 5 (`expert`).
 *
 * `expert` at 10 of 12 is deliberately imperfect. A tier that never forgets a
 * card is not a strong player, it is a different kind of thing to play against,
 * and the top of the dial is meant to still be beatable.
 *
 * The 12-copy total (6 ranks x 2 copies) is `TOTAL_TRUMP_COPIES` in
 * `tracker.ts`, which is module-private there. This module deliberately does
 * **not** declare a second copy of it: capacity is expressed against skill
 * level, and nothing here needs the total. When #158 needs to compare the two,
 * export the existing constant rather than adding one.
 */
export const TRUMP_MEMORY_CAPACITY: Record<SkillLevel, number> = {
  easy: 2,
  medium: 4,
  hard: 6,
  proficient: 8,
  expert: 10,
}

/** One remembered card, identified within the trump suit by rank plus which of
 *  the two copies it is. The suit is fixed for the whole memory, so it is not
 *  part of the identity. */
export interface TrumpSighting {
  readonly rank: Rank
  readonly copyId: CopyId
}

/**
 * What one seat remembers about trump this round.
 *
 * The model, in full:
 *
 *   - **Capacity** is `TRUMP_MEMORY_CAPACITY[skill]` *physical trump cards*, not
 *     sightings. Once it is full, seeing a new one pushes the oldest out.
 *   - **Most recent wins.** Sightings are held newest-first; the card whose
 *     sighting is furthest back is the one forgotten.
 *   - **Meld counts.** Meld is laid face-up before trick play, so trump shown
 *     there is real information and consumes a slot exactly like a played card
 *     does. Feed `extractMeldCards`' output through `seeAll` alongside every
 *     card `PlayTracker.record` sees.
 *   - **Re-seeing a card refreshes it, it does not consume a second slot.** A
 *     trump melded and then played later is one card and one fact; charging it
 *     twice would let a round produce more sightings than the 12 trump that
 *     exist, and then "10 of 12" would not mean anything. So this is an LRU over
 *     physical cards, keyed on rank + copy id.
 *   - **Non-trump is ignored**, silently, so a caller can pipe every card of the
 *     round through `see` without filtering first.
 *
 * Nothing here is authoritative about the round — it is one seat's recollection,
 * and it is *supposed* to be wrong below `expert`. Anything that needs the truth
 * (parity fixtures, rules enforcement, scoring) must keep using `PlayTracker`.
 */
export class TrumpMemory {
  /** Remembered sightings, oldest first — index 0 is the next to be forgotten. */
  private readonly recent: TrumpSighting[] = []
  private distinctSeen = 0

  readonly trump: Suit
  readonly skill: SkillLevel
  readonly capacity: number

  constructor(trump: Suit, skill: SkillLevel = 'hard') {
    this.trump = trump
    this.skill = skill
    this.capacity = TRUMP_MEMORY_CAPACITY[skill]
  }

  /** Note one card. Non-trump is discarded; trump is remembered as the most
   *  recent sighting, evicting the oldest if that puts it over capacity. */
  see(card: Card): void {
    if (card.suit !== this.trump) return
    const existing = this.recent.findIndex((s) => s.rank === card.rank && s.copyId === card.copyId)
    if (existing >= 0) {
      this.recent.splice(existing, 1) // same card again — refresh, don't double-charge
    } else {
      this.distinctSeen += 1
    }
    this.recent.push({ rank: card.rank, copyId: card.copyId })
    if (this.recent.length > this.capacity) this.recent.shift()
  }

  /** `see` over a group — a meld spread, a completed trick. */
  seeAll(cards: readonly Card[]): void {
    for (const card of cards) this.see(card)
  }

  /** Copies of this trump rank (0-2) the seat currently recalls seeing. Answers
   *  "are both trump Aces gone?" as far as this seat knows, which is the whole
   *  point — a low count may mean the copies are still out, or may mean they
   *  were seen and forgotten. The seat cannot tell the difference, by design. */
  seenCount(rank: Rank): number {
    return this.recent.reduce((count, s) => count + (s.rank === rank ? 1 : 0), 0)
  }

  /** How many distinct trump are currently recalled. Never exceeds `capacity`. */
  get size(): number {
    return this.recent.length
  }

  /** Distinct trump seen and since forgotten — the gap between what passed in
   *  front of this seat and what it can still use. */
  get forgottenCount(): number {
    return this.distinctSeen - this.recent.length
  }

  /** Everything currently recalled, oldest first. Diagnostics and tests —
   *  strategy code should ask `seenCount`. */
  remembered(): readonly TrumpSighting[] {
    return [...this.recent]
  }
}

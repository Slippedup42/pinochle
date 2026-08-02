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
// WIRED BY #158, which is what this was built for. `tracker.ts` now asks a
// seat's memory "is this counter still beatable in its own suit?" before
// spending it, and `newTrumpMemories` at the bottom of this file is what builds
// one memory per seat at the top of a round. Until #158 the module was reachable
// only from its own test, on purpose — #114 and #153's pattern of landing the
// machinery inert so the behaviour change can be measured on its own.

import type { SkillLevel } from '../persistence/options'
import type { Card, CopyId, Rank, Suit } from './card'
import { extractMeldCards } from './melds'
import type { PlayerIndex } from './trick'

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

/**
 * One memory per seat for a round about to be played, pre-loaded with the trump
 * each seat can see in **the other three seats' meld** (#158).
 *
 * Two things about the seeding are load-bearing rather than incidental:
 *
 *   **A seat is not shown its own meld.** #157 says meld consumes capacity like
 *   anything else, and it does — but only for cards the seat does not already
 *   hold. `tracker.ts` answers "is this card still beatable" as *seen +
 *   held >= 2 copies*, counting the hand separately, so feeding a seat its own
 *   melded trump would count that one physical card twice and manufacture
 *   certainty out of nothing. Over-counting is the one failure mode this model
 *   must not have: an unknown has to resolve to "beatable", never to "boss".
 *   Under-counting is fine, and is exactly what forgetting already does.
 *
 *   **Nothing else here is in a seat's own hand either**, so the same
 *   invariant holds for the rest of the round: every later sighting is a card
 *   played to a trick, which by then has left whoever's hand it came from.
 *
 * The caller drives it from there — feed every card played to a trick through
 * `see` on all four memories, after it is chosen. A card melded by one seat and
 * played later is deduplicated by rank + copy id, so it still costs one slot.
 *
 * @param hands - Hands as of the start of trick play, i.e. after the 3-card
 *   pass and the meld reveal. Melds are derived from these.
 * @param skillOf - The level each seat plays at, which fixes its capacity.
 */
export function newTrumpMemories(
  hands: readonly (readonly Card[])[],
  trump: Suit,
  skillOf: (seat: PlayerIndex) => SkillLevel,
): Record<PlayerIndex, TrumpMemory> {
  const seats: readonly PlayerIndex[] = [0, 1, 2, 3]
  const meldBySeat = seats.map((seat) => extractMeldCards(hands[seat] ?? [], trump).meldCards)
  const memories = {} as Record<PlayerIndex, TrumpMemory>
  for (const seat of seats) {
    const memory = new TrumpMemory(trump, skillOf(seat))
    for (const other of seats) {
      if (other !== seat) memory.seeAll(meldBySeat[other])
    }
    memories[seat] = memory
  }
  return memories
}

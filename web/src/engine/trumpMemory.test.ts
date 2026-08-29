import { describe, expect, it } from 'vitest'
import type { SkillLevel } from '../persistence/options'
import { type CopyId, Card, RANKS, Suit, TOTAL_TRUMP_COPIES } from './card'
import { TRUMP_MEMORY_CAPACITY, TrumpMemory, newTrumpMemories } from './trumpMemory'

const TRUMP = Suit.Spades

/** Every trump in the deck, in a fixed order: both copies of 9, then J, and so
 *  on up to A. Order is what these tests are about, so it must not be random. */
function allTrumpInOrder(): Card[] {
  return RANKS.flatMap((rank) => [new Card(TRUMP, rank, 1), new Card(TRUMP, rank, 2)])
}

describe('TRUMP_MEMORY_CAPACITY', () => {
  it('is 2 x skill level for each of the five levels', () => {
    expect(TRUMP_MEMORY_CAPACITY).toEqual({
      easy: 2,
      medium: 4,
      hard: 6,
      proficient: 8,
      expert: 10,
    })
  })

  it('leaves even expert short of the full 12 trump', () => {
    expect(TOTAL_TRUMP_COPIES).toBe(12)
    expect(TRUMP_MEMORY_CAPACITY.expert).toBeLessThan(TOTAL_TRUMP_COPIES)
  })

  const levels: [SkillLevel, number][] = [
    ['easy', 2],
    ['medium', 4],
    ['hard', 6],
    ['proficient', 8],
    ['expert', 10],
  ]
  it.each(levels)('a %s memory holds %i trump', (skill, capacity) => {
    expect(new TrumpMemory(TRUMP, skill).capacity).toBe(capacity)
  })
})

describe('TrumpMemory recall', () => {
  it('starts empty', () => {
    const memory = new TrumpMemory(TRUMP, 'hard')
    expect(memory.size).toBe(0)
    expect(memory.forgottenCount).toBe(0)
    for (const rank of RANKS) expect(memory.seenCount(rank)).toBe(0)
  })

  it('counts both copies of a rank separately', () => {
    const memory = new TrumpMemory(TRUMP, 'hard')
    memory.see(new Card(TRUMP, 'A', 1))
    expect(memory.seenCount('A')).toBe(1)
    memory.see(new Card(TRUMP, 'A', 2))
    expect(memory.seenCount('A')).toBe(2)
  })

  it('ignores non-trump entirely, so callers can pipe every card through', () => {
    const memory = new TrumpMemory(TRUMP, 'easy')
    memory.seeAll([
      new Card(Suit.Hearts, 'A', 1),
      new Card(Suit.Clubs, 'K', 1),
      new Card(Suit.Diamonds, '10', 1),
    ])
    expect(memory.size).toBe(0)
    expect(memory.seenCount('A')).toBe(0)
    // ...and no capacity was spent on them
    memory.seeAll([new Card(TRUMP, '9', 1), new Card(TRUMP, 'J', 1)])
    expect(memory.size).toBe(2)
  })
})

describe('TrumpMemory forgetting', () => {
  it('at exactly capacity, nothing is forgotten yet', () => {
    const memory = new TrumpMemory(TRUMP, 'easy') // capacity 2
    memory.seeAll([new Card(TRUMP, '9', 1), new Card(TRUMP, 'J', 1)])
    expect(memory.size).toBe(2)
    expect(memory.forgottenCount).toBe(0)
    expect(memory.seenCount('9')).toBe(1)
    expect(memory.seenCount('J')).toBe(1)
  })

  it('past capacity, the oldest goes and the newest is kept', () => {
    const memory = new TrumpMemory(TRUMP, 'easy') // capacity 2
    memory.seeAll([new Card(TRUMP, '9', 1), new Card(TRUMP, 'J', 1), new Card(TRUMP, 'Q', 1)])
    expect(memory.size).toBe(2)
    expect(memory.forgottenCount).toBe(1)
    expect(memory.seenCount('9')).toBe(0) // oldest — gone
    expect(memory.seenCount('J')).toBe(1)
    expect(memory.seenCount('Q')).toBe(1) // newest — kept
  })

  it('forgets in sighting order, not rank order', () => {
    const memory = new TrumpMemory(TRUMP, 'medium') // capacity 4
    // Aces first, junk last: the Aces are the high cards but the oldest news.
    memory.seeAll([
      new Card(TRUMP, 'A', 1),
      new Card(TRUMP, 'A', 2),
      new Card(TRUMP, '10', 1),
      new Card(TRUMP, '10', 2),
      new Card(TRUMP, '9', 1),
      new Card(TRUMP, '9', 2),
    ])
    expect(memory.size).toBe(4)
    expect(memory.seenCount('A')).toBe(0) // both Aces seen, both forgotten
    expect(memory.seenCount('10')).toBe(2)
    expect(memory.seenCount('9')).toBe(2)
    expect(memory.remembered().map((s) => s.rank)).toEqual(['10', '10', '9', '9'])
  })

  it('an expert who sees all 12 trump still forgets the first 2', () => {
    const memory = new TrumpMemory(TRUMP, 'expert') // capacity 10
    memory.seeAll(allTrumpInOrder()) // 9,9,J,J,Q,Q,K,K,10,10,A,A
    expect(memory.size).toBe(10)
    expect(memory.forgottenCount).toBe(TOTAL_TRUMP_COPIES - TRUMP_MEMORY_CAPACITY.expert)
    expect(memory.seenCount('9')).toBe(0) // the two earliest sightings
    expect(memory.seenCount('J')).toBe(2)
    expect(memory.seenCount('A')).toBe(2)
  })

  it('re-seeing a remembered card refreshes it instead of pushing it out', () => {
    const memory = new TrumpMemory(TRUMP, 'easy') // capacity 2
    memory.seeAll([new Card(TRUMP, '9', 1), new Card(TRUMP, 'J', 1)])
    memory.see(new Card(TRUMP, '9', 1)) // same physical card again
    expect(memory.size).toBe(2)
    expect(memory.forgottenCount).toBe(0) // no second slot spent, nothing evicted
    // ...but the 9 is now the fresher of the two, so the J is next to go.
    memory.see(new Card(TRUMP, 'Q', 1))
    expect(memory.seenCount('J')).toBe(0)
    expect(memory.seenCount('9')).toBe(1)
    expect(memory.seenCount('Q')).toBe(1)
  })

  it('re-seeing a forgotten card admits it again', () => {
    const memory = new TrumpMemory(TRUMP, 'easy') // capacity 2
    memory.seeAll([new Card(TRUMP, '9', 1), new Card(TRUMP, 'J', 1), new Card(TRUMP, 'Q', 1)])
    expect(memory.seenCount('9')).toBe(0)
    memory.see(new Card(TRUMP, '9', 1))
    expect(memory.seenCount('9')).toBe(1)
    expect(memory.seenCount('J')).toBe(0) // the J was next in line and is now out
    expect(memory.size).toBe(2)
  })
})

describe('TrumpMemory and meld', () => {
  it('counts trump shown in meld, before a card is played', () => {
    const memory = new TrumpMemory(TRUMP, 'hard')
    // A trump run melded face-up: A,10,K,Q,J of trump.
    memory.seeAll([
      new Card(TRUMP, 'A', 1),
      new Card(TRUMP, '10', 1),
      new Card(TRUMP, 'K', 1),
      new Card(TRUMP, 'Q', 1),
      new Card(TRUMP, 'J', 1),
    ])
    expect(memory.size).toBe(5)
    expect(memory.seenCount('A')).toBe(1)
    expect(memory.seenCount('J')).toBe(1)
  })

  it('meld consumes capacity like anything else', () => {
    const memory = new TrumpMemory(TRUMP, 'easy') // capacity 2
    memory.seeAll([new Card(TRUMP, 'A', 1), new Card(TRUMP, '10', 1)]) // melded
    memory.see(new Card(TRUMP, '9', 1)) // then one played
    expect(memory.size).toBe(2)
    expect(memory.seenCount('A')).toBe(0) // the melded Ace is already crowded out
    expect(memory.seenCount('10')).toBe(1)
    expect(memory.seenCount('9')).toBe(1)
  })

  it('a trump melded and later played is one card, not two sightings', () => {
    const memory = new TrumpMemory(TRUMP, 'medium') // capacity 4
    const meldedAce = new Card(TRUMP, 'A', 1)
    memory.see(meldedAce) // laid face-up in meld
    memory.seeAll([new Card(TRUMP, '9', 1), new Card(TRUMP, 'J', 1), new Card(TRUMP, 'Q', 1)])
    memory.see(meldedAce) // taken back into hand and played
    expect(memory.size).toBe(4)
    expect(memory.forgottenCount).toBe(0)
    expect(memory.seenCount('A')).toBe(1) // one Ace copy accounted for, not two
  })
})

describe('newTrumpMemories (#158)', () => {
  /** A hand melding a Royal Marriage in trump (K+Q) plus filler that melds
   *  nothing, so `extractMeldCards` returns exactly the two trump cards. */
  function royalMarriageHand(copy: CopyId): Card[] {
    return [
      new Card(TRUMP, 'K', copy),
      new Card(TRUMP, 'Q', copy),
      new Card(Suit.Hearts, '9', copy),
    ]
  }

  const hands = [
    royalMarriageHand(1), // seat 0 melds K+Q of trump, copy 1
    royalMarriageHand(2), // seat 1 melds K+Q of trump, copy 2
    [new Card(Suit.Hearts, 'J', 1)], // seats 2 and 3 meld nothing
    [new Card(Suit.Clubs, 'J', 1)],
  ]

  it('seeds each seat with the trump the other three melded', () => {
    const memories = newTrumpMemories(hands, TRUMP, () => 'expert')
    // Seat 2 melded nothing and can see all four trump laid out opposite it.
    expect(memories[2].seenCount('K')).toBe(2)
    expect(memories[2].seenCount('Q')).toBe(2)
    expect(memories[2].size).toBe(4)
  })

  it('does not show a seat its own meld, because its own cards are counted from its hand', () => {
    // The invariant that keeps the model from ever over-counting. `tracker.ts`
    // reads "accounted for" as *seen + still held >= 2 copies*, tallying the
    // hand separately, so a seat fed its own melded King would count one
    // physical card twice and conclude a Queen was boss when it is not. An
    // under-count only ever reads as "still beatable", which is safe; an
    // over-count invents certainty, which is not.
    const memories = newTrumpMemories(hands, TRUMP, () => 'expert')
    expect(memories[0].seenCount('K')).toBe(1) // seat 1's copy only, not its own
    expect(memories[0].remembered().map((s) => s.copyId)).toEqual([2, 2])
    expect(memories[1].seenCount('K')).toBe(1) // seat 0's copy only
    expect(memories[1].remembered().map((s) => s.copyId)).toEqual([1, 1])
  })

  it('gives each seat the capacity its own level buys', () => {
    const memories = newTrumpMemories(hands, TRUMP, (seat) => (seat === 0 ? 'easy' : 'expert'))
    expect(memories[0].capacity).toBe(TRUMP_MEMORY_CAPACITY.easy)
    expect(memories[1].capacity).toBe(TRUMP_MEMORY_CAPACITY.expert)
  })

  it('spends capacity on the meld, so a weak seat arrives at trick 1 already short', () => {
    // Seat 2 can see four melded trump and can hold two of them. Meld is not a
    // free look — it consumes the memory exactly as played cards do (#157).
    const memories = newTrumpMemories(hands, TRUMP, () => 'easy')
    expect(memories[2].size).toBe(TRUMP_MEMORY_CAPACITY.easy)
    expect(memories[2].forgottenCount).toBe(2)
  })
})

import { describe, expect, it } from 'vitest'
import type { SkillLevel } from '../persistence/options'
import { Card, Suit } from './card'
import { SKILL_PARAMS } from './skills'
import { Trick, type TrickPlay } from './trick'
import { chooseFollowCard, chooseLeadCard, PlayTracker } from './tracker'
import { TrumpMemory } from './trumpMemory'

/**
 * Runs `play` with one level temporarily moved onto `'simple'` card play,
 * handing it the level to pass to `chooseLeadCard` / `chooseFollowCard`.
 *
 * Since #156 no `SKILL_PARAMS` row ships `'simple'` — trick play is identical
 * at all five levels — so it can no longer be reached by naming `easy`, the way
 * these tests used to reach it. It is still a live policy: `PLAY_AB_POLICIES`
 * is the baseline every child of epic #152 is measured against, and an arm the
 * suite never exercises is an arm nothing vouches for.
 *
 * This is `installPolicies`' mechanism (`ab/abRun.ts`) narrowed to one level,
 * rather than that import, to keep the engine's unit tests off the A/B harness
 * — it pulls the whole headless game in behind it. Restoring in a `finally` is
 * the load-bearing part: a leaked override would quietly change every later
 * assertion in this file.
 */
function withSimplePlay<T>(play: (skill: SkillLevel) => T): T {
  const level: SkillLevel = 'easy'
  const saved = SKILL_PARAMS[level]
  SKILL_PARAMS[level] = { ...saved, playPolicy: 'simple' }
  try {
    return play(level)
  } finally {
    SKILL_PARAMS[level] = saved
  }
}

/**
 * Runs `play` with one level temporarily switched **back** onto
 * `safeCounterPolicy: 'off'` — the state #155 left the forced-beat tier in,
 * before #158 taught it which counter would actually hold.
 *
 * The inverse of `withSimplePlay`, and for the inverse reason: `'counted'` ships
 * on every row (#158 measured positive at all five capacities), so it is
 * `'off'` that is now reachable only through an override. It stays live as
 * `SAFE_COUNTER_AB_POLICIES`' baseline arm, and the tests using this pin what
 * that baseline still does, so the A/B has a ruler that the suite vouches for.
 *
 * Note that the level is fixed at `hard` here while `withSafeCounter`'s
 * replacement below takes it as an argument — the `'off'` arm ignores the
 * capacity entirely, so one level is as good as another for it.
 */
function withSafeCounterOff<T>(play: (skill: SkillLevel) => T): T {
  const level: SkillLevel = 'hard'
  const saved = SKILL_PARAMS[level]
  SKILL_PARAMS[level] = { ...saved, safeCounterPolicy: 'off' }
  try {
    return play(level)
  } finally {
    SKILL_PARAMS[level] = saved
  }
}

/** A trump memory that has watched `seen` go by, in that order. */
function memoryOf(level: SkillLevel, trump: Suit, seen: readonly Card[]): TrumpMemory {
  const memory = new TrumpMemory(trump, level)
  memory.seeAll(seen)
  return memory
}

describe('PlayTracker', () => {
  it('starts with nothing played', () => {
    const tracker = new PlayTracker()
    expect(tracker.playedCount(Suit.Spades, 'A')).toBe(0)
  })

  it('accumulates played counts per suit/rank, up to 2 copies', () => {
    const tracker = new PlayTracker()
    tracker.record(new Card(Suit.Spades, 'A', 1))
    expect(tracker.playedCount(Suit.Spades, 'A')).toBe(1)
    tracker.record(new Card(Suit.Spades, 'A', 2))
    expect(tracker.playedCount(Suit.Spades, 'A')).toBe(2)
  })

  it('keeps suit/rank counts independent of each other', () => {
    const tracker = new PlayTracker()
    tracker.record(new Card(Suit.Spades, 'A', 1))
    expect(tracker.playedCount(Suit.Hearts, 'A')).toBe(0)
    expect(tracker.playedCount(Suit.Spades, 'K')).toBe(0)
  })
})

describe('chooseLeadCard', () => {
  it('priority 1: leads an unsecured trump Ace over everything else', () => {
    const hand = [
      new Card(Suit.Spades, 'A', 1), // trump, only 1 copy in hand, other copy unplayed
      new Card(Suit.Hearts, 'A', 1),
      new Card(Suit.Hearts, 'A', 2), // secure double ace, would otherwise be a safe card
    ]
    const tracker = new PlayTracker()
    const led = chooseLeadCard(hand, Suit.Spades, tracker)
    expect(led.suit).toBe(Suit.Spades)
    expect(led.rank).toBe('A')
  })

  it('a trump Ace is not "unsecured" once its partner copy has already been played', () => {
    const hand = [new Card(Suit.Spades, 'A', 1), new Card(Suit.Clubs, '9', 1)]
    const tracker = new PlayTracker()
    tracker.record(new Card(Suit.Spades, 'A', 2)) // the other copy is already gone
    const led = chooseLeadCard(hand, Suit.Spades, tracker)
    // Falls through past priority 1 - the remaining Ace is now safe (rank A
    // is always safe), so it's still the pick, just via priority 3.
    expect(led.suit).toBe(Suit.Spades)
    expect(led.rank).toBe('A')
  })

  it('priority 2: leads an unsecured non-trump Ace, preferring the longest suit', () => {
    const hand = [
      new Card(Suit.Hearts, 'A', 1), // unsecured, Hearts length 1
      new Card(Suit.Clubs, 'A', 1), // unsecured, Clubs length 2
      new Card(Suit.Clubs, '9', 1),
    ]
    const tracker = new PlayTracker()
    const led = chooseLeadCard(hand, Suit.Spades, tracker) // trump not present in hand
    expect(led.suit).toBe(Suit.Clubs)
    expect(led.rank).toBe('A')
  })

  it('priority 3: leads a safe card, cascading top-down by rank', () => {
    const hand = [
      new Card(Suit.Hearts, 'A', 1), // secure double ace -> safe, highest rank
      new Card(Suit.Hearts, 'A', 2),
      new Card(Suit.Clubs, '9', 1), // not safe: higher clubs ranks unaccounted for
    ]
    const tracker = new PlayTracker()
    const led = chooseLeadCard(hand, Suit.Spades, tracker)
    expect(led.suit).toBe(Suit.Hearts)
    expect(led.rank).toBe('A')
  })

  it('priority 3: within the same rank tier, prefers the longer suit', () => {
    // Both suits have all 5 higher ranks accounted for (all in hand), so the
    // 9s of each suit are equally "safe" - the tiebreak is suit length.
    const hand = [
      new Card(Suit.Hearts, '9', 1),
      new Card(Suit.Hearts, 'J', 1),
      new Card(Suit.Hearts, 'Q', 1),
      new Card(Suit.Hearts, 'K', 1),
      new Card(Suit.Hearts, '10', 1),
      new Card(Suit.Hearts, 'A', 1),
      new Card(Suit.Hearts, 'A', 2),
      new Card(Suit.Clubs, '9', 1),
      new Card(Suit.Clubs, 'J', 1),
      new Card(Suit.Clubs, 'Q', 1),
      new Card(Suit.Clubs, 'K', 1),
      new Card(Suit.Clubs, '10', 1),
    ]
    const tracker = new PlayTracker()
    const led = chooseLeadCard(hand, Suit.Spades, tracker)
    // Hearts (7 cards) is longer than Clubs (5 cards); both suits' 9s are
    // safe (every higher card is in hand), so Hearts' 9 wins the tiebreak.
    // But the Hearts Aces outrank everything by rank cascade first.
    expect(led.suit).toBe(Suit.Hearts)
    expect(led.rank).toBe('A')
  })

  it('priority 4: with no aces or safe cards, leads junk (non-point, non-trump), shortest suit first', () => {
    const hand = [
      new Card(Suit.Diamonds, 'J', 1), // Diamonds length 1
      new Card(Suit.Hearts, '9', 1), // Hearts length 2
      new Card(Suit.Hearts, '9', 2),
    ]
    const tracker = new PlayTracker()
    const led = chooseLeadCard(hand, Suit.Spades, tracker)
    expect(led.suit).toBe(Suit.Diamonds)
    expect(led.rank).toBe('J')
  })

  it('priority 5: falls back to non-point trump when only trump/point cards remain', () => {
    const hand = [
      new Card(Suit.Spades, '9', 1), // trump, non-point, not safe
      new Card(Suit.Hearts, '10', 1), // point card, not safe
    ]
    const tracker = new PlayTracker()
    const led = chooseLeadCard(hand, Suit.Spades, tracker)
    expect(led.suit).toBe(Suit.Spades)
    expect(led.rank).toBe('9')
  })

  it('last resort: leads the lowest-ranked card when every option is a point card', () => {
    const hand = [
      new Card(Suit.Hearts, '10', 1), // non-trump point card
      new Card(Suit.Spades, 'K', 1), // trump point card, lower rank than 10
    ]
    const tracker = new PlayTracker()
    const led = chooseLeadCard(hand, Suit.Spades, tracker)
    expect(led.suit).toBe(Suit.Spades)
    expect(led.rank).toBe('K')
  })

  // -- Side dispatch, against `choose_lead_card`'s Python original (#126) ----

  it('offense leads the trump Ace when the bidding team is on lead', () => {
    const hand = [new Card(Suit.Spades, 'A', 1), new Card(Suit.Hearts, 'A', 1), new Card(Suit.Hearts, 'A', 2)]
    const led = chooseLeadCard(hand, Suit.Spades, new PlayTracker(), false, 'hard', true)
    expect(led.suit).toBe(Suit.Spades)
    expect(led.rank).toBe('A')
  })

  it('a defender never leads trump while it holds anything else (#126)', () => {
    // The unsecured trump Ace is the safe-card cascade's very first tier, so
    // running the cascade over the whole hand hands it straight to the bidder's
    // trump-draw plan. Python's `_defender_lead` restricts to non-trump before
    // the cascade ever sees the hand, unconditionally — this used to fire only
    // once every trump copy was accounted for.
    const hand = [
      new Card(Suit.Spades, 'A', 1), // trump, unsecured
      new Card(Suit.Hearts, 'A', 1), // unsecured non-trump Ace
      new Card(Suit.Clubs, '9', 1),
    ]
    const led = chooseLeadCard(hand, Suit.Spades, new PlayTracker(), false, 'hard', false)
    expect(led.suit).not.toBe(Suit.Spades)
    expect(led.suit).toBe(Suit.Hearts)
  })

  it('a defender leads trump only when the hand is nothing but trump', () => {
    const hand = [new Card(Suit.Spades, 'A', 1), new Card(Suit.Spades, '9', 1)]
    const led = chooseLeadCard(hand, Suit.Spades, new PlayTracker(), false, 'hard', false)
    expect(led.suit).toBe(Suit.Spades)
  })

  // -- The play-policy branch (#153, #156) ----------------------------------

  it("'simple' leads its lowest non-trump non-counter and ignores everything else", () => {
    // Same hand as the defender test above, where `cascade` picks the Ace of
    // Hearts. `simple` takes the Clubs 9: no cascade, no side dispatch, no
    // tracker. The two arms are visibly different rules, which is what makes
    // `PLAY_AB_POLICIES` a comparison rather than a formality.
    const hand = [
      new Card(Suit.Spades, 'A', 1),
      new Card(Suit.Hearts, 'A', 1),
      new Card(Suit.Clubs, '9', 1),
    ]
    const led = withSimplePlay((skill) =>
      chooseLeadCard(hand, Suit.Spades, new PlayTracker(), false, skill, false),
    )
    expect(led.suit).toBe(Suit.Clubs)
    expect(led.rank).toBe('9')
  })

  it("'simple' ignores the bidder's forced trump lead", () => {
    // The `meld_only` test this branch replaces sat above the
    // `isBidderFirstLead` rule, so the shortcut never honoured rule #82 at all.
    // Kept as a property of the arm, not of a level — since #156 nobody plays
    // it, and the line below is what `easy` does now.
    const hand = [new Card(Suit.Spades, 'A', 1), new Card(Suit.Clubs, '9', 1)]
    const led = withSimplePlay((skill) =>
      chooseLeadCard(hand, Suit.Spades, new PlayTracker(), true, skill),
    )
    expect(led.suit).toBe(Suit.Clubs)
  })

  it('easy leads with the cascade like every other level (#156)', () => {
    // The behaviour change #156 is. Both hands above, played by `easy` as it
    // now ships: the defender hand goes to the unsecured Ace of Hearts instead
    // of the Clubs 9, and the bidder's first lead is trump as rule #82 requires
    // rather than a shrug. A bad bid is invisible to the other seats; a card
    // this wrong is face up on the table.
    const defenderHand = [
      new Card(Suit.Spades, 'A', 1),
      new Card(Suit.Hearts, 'A', 1),
      new Card(Suit.Clubs, '9', 1),
    ]
    const defenderLed = chooseLeadCard(defenderHand, Suit.Spades, new PlayTracker(), false, 'easy', false)
    expect(defenderLed.suit).toBe(Suit.Hearts)
    expect(defenderLed.rank).toBe('A')

    const bidderHand = [new Card(Suit.Spades, 'A', 1), new Card(Suit.Clubs, '9', 1)]
    const bidderLed = chooseLeadCard(bidderHand, Suit.Spades, new PlayTracker(), true, 'easy')
    expect(bidderLed.suit).toBe(Suit.Spades)
  })

  // -- The bidder's opening lead (#159) --------------------------------------

  it('opens on the highest non-counter trump when the bidder holds no trump Ace', () => {
    // The measured half of #159. This used to be `maxByRank`, which leads the
    // 10 — handing the opponents' Ace ten points for the privilege of drawing
    // one round of trump. The Queen drags out a King and an Ace for nothing and
    // can leave the bidder's own 10 as the boss trump.
    const hand = [
      new Card(Suit.Spades, '10', 1),
      new Card(Suit.Spades, 'K', 1),
      new Card(Suit.Spades, 'Q', 1),
      new Card(Suit.Spades, '9', 1),
      new Card(Suit.Hearts, 'A', 1),
      new Card(Suit.Clubs, 'J', 1),
    ]
    const led = chooseLeadCard(hand, Suit.Spades, new PlayTracker(), true, 'hard', true)
    expect(led.suit).toBe(Suit.Spades)
    expect(led.rank).toBe('Q')
  })

  it('opens on the trump Ace ahead of the Queen when it holds one', () => {
    // Rule #82's trump lead and its Ace preference are untouched — the Queen is
    // the *aceless* fallback, not a replacement for drawing trump with the Ace.
    const hand = [
      new Card(Suit.Spades, 'A', 1),
      new Card(Suit.Spades, 'Q', 1),
      new Card(Suit.Spades, '10', 1),
    ]
    const led = chooseLeadCard(hand, Suit.Spades, new PlayTracker(), true, 'hard', true)
    expect(led.suit).toBe(Suit.Spades)
    expect(led.rank).toBe('A')
  })

  it('opens on the trump Jack when the Queen is not held — highest non-counter, not lowest trump', () => {
    // "Non-counter" is the property that matters (A/10/K each pay 10), so the
    // rule cascades Q -> J -> 9 rather than simply leading the cheapest trump.
    const hand = [
      new Card(Suit.Spades, '10', 1),
      new Card(Suit.Spades, 'J', 1),
      new Card(Suit.Spades, '9', 1),
    ]
    const led = chooseLeadCard(hand, Suit.Spades, new PlayTracker(), true, 'hard', true)
    expect(led.rank).toBe('J')
  })

  it('falls back to the highest trump when every trump held is a counter', () => {
    // Nothing to donate zero points with, so the pre-#159 rule stands: lead the
    // highest one and take the round of trump.
    const hand = [
      new Card(Suit.Spades, '10', 1),
      new Card(Suit.Spades, 'K', 1),
      new Card(Suit.Hearts, '9', 1),
    ]
    const led = chooseLeadCard(hand, Suit.Spades, new PlayTracker(), true, 'hard', true)
    expect(led.suit).toBe(Suit.Spades)
    expect(led.rank).toBe('10')
  })

  // -- Leading a counter that is provably boss (#158) -------------------------

  it('counted: an expert cashes a trump 10 it knows is boss, on an all-trump hand', () => {
    // The leading half of #158 — "a counter that is provably boss is safe to
    // lead; one that is not, is not." Both trump Aces have gone past this seat,
    // so the 10 is the highest trump left and tier 3 of the cascade leads it.
    //
    // Trump reaches the cascade only on an all-trump hand: `offenseTrumpLead`
    // and `defenderLead` both strip trump out first whenever the hand holds
    // anything else, which is why this position looks contrived. It is the one
    // that exists.
    const trump = Suit.Spades
    const hand = [new Card(trump, '10', 1), new Card(trump, 'K', 1), new Card(trump, '9', 1)]
    const seen = [
      new Card(trump, 'A', 1),
      new Card(trump, 'A', 2),
      new Card(trump, '9', 2), // two later sightings, to crowd an `easy` memory
      new Card(trump, 'J', 1),
    ]
    const led = chooseLeadCard(hand, trump, new PlayTracker(), false, 'expert', true, memoryOf('expert', trump, seen))
    expect(led.rank).toBe('10')
  })

  it('counted: an easy seat cannot recall the Aces and leads junk instead', () => {
    // Same hand, same cards gone by, capacity 2. It does not know the 10 is
    // boss, so no card qualifies as safe, and the cascade drops through to the
    // junk tier and surrenders the 9. Ten points left in hand that an expert
    // would have banked — the cost of not counting, made visible.
    const trump = Suit.Spades
    const hand = [new Card(trump, '10', 1), new Card(trump, 'K', 1), new Card(trump, '9', 1)]
    const seen = [
      new Card(trump, 'A', 1),
      new Card(trump, 'A', 2),
      new Card(trump, '9', 2),
      new Card(trump, 'J', 1),
    ]
    const led = chooseLeadCard(hand, trump, new PlayTracker(), false, 'easy', true, memoryOf('easy', trump, seen))
    expect(led.rank).toBe('9')
  })

  it('changes nothing after the opening trick — the bidding side still cashes a trump Ace', () => {
    // #159's other half, "hold trump back", was measured and did not ship: over
    // 5000 paired deals, suppressing this tier costs 13.6 points a deal. The
    // holding-back it describes is already what `offenseTrumpLead` does — the
    // Ace is the only trump it ever chooses to lead.
    const hand = [
      new Card(Suit.Spades, 'A', 1),
      new Card(Suit.Hearts, 'K', 1),
      new Card(Suit.Clubs, 'J', 1),
    ]
    const led = chooseLeadCard(hand, Suit.Spades, new PlayTracker(), false, 'hard', true)
    expect(led.suit).toBe(Suit.Spades)
    expect(led.rank).toBe('A')
  })
})

describe('chooseFollowCard', () => {
  it('plays the only legal move without consulting any other context', () => {
    const onlyCard = new Card(Suit.Hearts, '9', 1)
    const played = chooseFollowCard([onlyCard], [onlyCard], [], Suit.Spades, [])
    expect(played).toBe(onlyCard)
  })

  it('forced beat: takes with the cheapest card that will still be standing at the end of the trick', () => {
    // Opponent (player 1) is winning with a weak 9 of the lead suit; both legal
    // cards outrank it, so this is a forced beat regardless of who is winning.
    //
    // This asserted the 10 until #158. "The lowest one that still wins" is only
    // the right reading if nothing behind can take it back, and here the second
    // Ace of Hearts is unaccounted for with two seats still to play — so the 10
    // does not win, it loses 20 points to whoever holds that Ace. The Ace is the
    // cheapest card in this legal set that cannot be beaten in suit, and the
    // rule is now stated in those terms.
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, '9', 1) }]
    const legalMoves = [new Card(Suit.Hearts, '10', 1), new Card(Suit.Hearts, 'A', 1)]
    const hand = legalMoves
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2])
    expect(played.rank).toBe('A')

    // ...and with the other Ace gone, the 10 *is* the boss card and the Ace
    // stays in hand. Same rule, different information — which is the whole
    // difference between this and the assertion it replaces.
    const tracker = new PlayTracker()
    tracker.record(new Card(Suit.Hearts, 'A', 2))
    expect(chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2], tracker).rank).toBe('10')
  })

  // -- Forced-beat selection (#155) -----------------------------------------

  it('forced beat: prefers a non-counter beater over a counter, taking the trick for free', () => {
    // Step 1 of Paul's rule. Opponent is winning with the Jack; the Queen, King
    // and 10 all beat it, so the trick is taken either way — the Queen takes it
    // without also putting 10 points into it.
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, 'J', 1) }]
    const legalMoves = [
      new Card(Suit.Hearts, 'K', 1),
      new Card(Suit.Hearts, 'Q', 1),
      new Card(Suit.Hearts, '10', 1),
    ]
    const played = chooseFollowCard(legalMoves, legalMoves, trickPlays, Suit.Spades, [0, 2])
    expect(played.rank).toBe('Q')
  })

  it("the 'off' arm still spends the cheapest counter, whatever is outstanding", () => {
    // #155's step 3, pinned on the baseline arm rather than on the shipped dial.
    // No free beat is available, so a counter has to go in, and this arm spends
    // the King without asking whether it will hold — which is exactly the
    // behaviour #158 measured against and beat, so it has to stay reachable and
    // has to stay asserted.
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, 'Q', 1) }]
    const legalMoves = [
      new Card(Suit.Hearts, '10', 1),
      new Card(Suit.Hearts, 'A', 1),
      new Card(Suit.Hearts, 'K', 1),
    ]
    const played = withSafeCounterOff((skill) =>
      chooseFollowCard(legalMoves, legalMoves, trickPlays, Suit.Spades, [0, 2], new PlayTracker(), skill),
    )
    expect(played.rank).toBe('K')
  })

  it('a trump ruff by partner is not a forced beat — no card of the lead suit can touch it', () => {
    // The #155 bug. `currentWinner` returns the trump, and the old test compared
    // `rankValue` alone: the 9 of trump has the lowest rank there is, so every
    // legal Heart "beat" it and the seat skipped the feed-partner tier to throw
    // its cheapest card into a trick its own side had already won. A Heart
    // cannot beat a Spade at any rank — partner is winning, so feed the King.
    const trickPlays: TrickPlay[] = [
      { player: 3, card: new Card(Suit.Hearts, '9', 1) }, // opponent leads
      { player: 0, card: new Card(Suit.Spades, '9', 1) }, // partner is void, ruffs
      { player: 1, card: new Card(Suit.Diamonds, '9', 1) }, // opponent sluffs
    ]
    // Seat 2 holds Hearts, so it must follow, and must beat the 9 of Hearts.
    const legalMoves = [new Card(Suit.Hearts, 'Q', 1), new Card(Suit.Hearts, 'K', 1)]
    const played = chooseFollowCard(legalMoves, legalMoves, trickPlays, Suit.Spades, [0, 2])
    expect(played.rank).toBe('K')
  })

  it('a trump ruff by an opponent is not a forced beat either, and still costs them nothing', () => {
    // Same suit-blind comparison, opponent side. Both the old and the fixed
    // reading play the Queen here — the forced-beat tier and the dump-low tier
    // agree, because pinochle's rank order puts every non-counter below every
    // counter — so this pins that the fix changed nothing on this side.
    const trickPlays: TrickPlay[] = [
      { player: 3, card: new Card(Suit.Hearts, '9', 1) },
      { player: 1, card: new Card(Suit.Spades, '9', 1) }, // opponent ruffs
    ]
    const legalMoves = [new Card(Suit.Hearts, 'Q', 1), new Card(Suit.Hearts, 'K', 1)]
    const played = chooseFollowCard(legalMoves, legalMoves, trickPlays, Suit.Spades, [0, 2])
    expect(played.rank).toBe('Q')
  })

  it("#155's worked example is decided before the comparison is reached", () => {
    // Partner leads the King of Diamonds, an opponent ruffs with the 9 of
    // trump, this seat holds the Ace and the 9 of Diamonds. `legalMoves` is
    // forced to the Ace alone, so `chooseFollowCard` returns on the
    // single-legal-move line and never evaluates `forcedBeat` at all — the
    // suit-blind comparison was unreachable in exactly the position that made
    // it look suspicious. It is the multi-card positions above that expose it.
    const trick = new Trick(Suit.Spades)
    trick.play(0, new Card(Suit.Diamonds, 'K', 1))
    trick.play(1, new Card(Suit.Spades, '9', 1))
    const hand = [new Card(Suit.Diamonds, 'A', 1), new Card(Suit.Diamonds, '9', 1)]
    const legalMoves = trick.legalMoves(hand)
    expect(legalMoves.map((c) => c.rank)).toEqual(['A'])
    const played = chooseFollowCard(hand, legalMoves, trick.plays, Suit.Spades, [0, 2])
    expect(played.rank).toBe('A')
  })

  it('feeds partner the lowest King/10 when partner is winning and not every card is a forced beat', () => {
    // Partner (player 0) is winning with a Queen; the 9 doesn't beat it, so
    // this isn't a forced beat - falls through to the feed-partner tier.
    const trickPlays: TrickPlay[] = [{ player: 0, card: new Card(Suit.Hearts, 'Q', 1) }]
    const legalMoves = [
      new Card(Suit.Hearts, '9', 1),
      new Card(Suit.Hearts, 'K', 1),
      new Card(Suit.Hearts, '10', 1),
    ]
    const hand = legalMoves
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2])
    // #154: King and 10 bank the same 10 points, so spend the King and keep the
    // 10 - it loses only to an Ace and often takes a later trick outright. This
    // asserted the 10 until #154 swapped it.
    expect(played.rank).toBe('K')
  })

  it('feeding partner with no King/10 available plays the lowest card instead (avoid donating a live Ace)', () => {
    const trickPlays: TrickPlay[] = [{ player: 0, card: new Card(Suit.Hearts, 'Q', 1) }]
    const legalMoves = [new Card(Suit.Hearts, '9', 1), new Card(Suit.Hearts, 'J', 1)]
    const hand = legalMoves
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2])
    expect(played.rank).toBe('9')
  })

  it('feeding partner holds the Ace back when it is the only counter, donating junk instead', () => {
    // The measured half of #154. "Play your lowest legal point" read literally
    // orders K -> 10 -> A, which puts the Ace in here for 10 points. That variant
    // ran as its own arm over 5000 paired deals: a null against the pre-#154
    // behaviour and 3.6 points a deal behind this one, so the Ace stays home.
    // The trick pays the same 10 either way; the boss of a suit does not.
    const trickPlays: TrickPlay[] = [{ player: 0, card: new Card(Suit.Hearts, 'Q', 1) }]
    const legalMoves = [new Card(Suit.Hearts, '9', 1), new Card(Suit.Hearts, 'A', 1)]
    const hand = legalMoves
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2])
    expect(played.rank).toBe('9')
  })

  it('opponent winning: plays the lowest non-point card rather than feeding them a point', () => {
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, 'K', 1) }]
    const legalMoves = [
      new Card(Suit.Hearts, 'J', 1), // non-point
      new Card(Suit.Hearts, 'Q', 1), // non-point
      new Card(Suit.Hearts, 'A', 1), // point, beats the King, but not forced (Q/J don't)
    ]
    const hand = legalMoves
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2])
    expect(played.rank).toBe('J')
  })

  it('opponent winning with only point cards available: plays the lowest legal card', () => {
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, 'A', 1) }]
    const legalMoves = [new Card(Suit.Hearts, '10', 1), new Card(Suit.Hearts, 'K', 1)]
    const hand = legalMoves
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2])
    expect(played.rank).toBe('K')
  })

  it('void in the lead suit, forced to trump, no tracker supplied: defaults to trump-secure and conserves the lowest trump', () => {
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, 'K', 1) }]
    const legalMoves = [new Card(Suit.Spades, '9', 1), new Card(Suit.Spades, 'A', 1)]
    const hand = legalMoves
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2])
    expect(played.rank).toBe('9')
  })

  it('forced to trump, trump secure per tracker (all 12 copies accounted for): plays the lowest trump', () => {
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, 'K', 1) }]
    const hand = [new Card(Suit.Spades, '9', 1), new Card(Suit.Spades, 'A', 1)]
    const legalMoves = hand
    const tracker = new PlayTracker()
    for (const rank of ['J', 'Q', 'K', '10'] as const) {
      tracker.record(new Card(Suit.Spades, rank, 1))
      tracker.record(new Card(Suit.Spades, rank, 2))
    }
    tracker.record(new Card(Suit.Spades, '9', 2))
    tracker.record(new Card(Suit.Spades, 'A', 2))
    // 8 (J/Q/K/10 both copies) + 2 (spare 9/A copies) played, + 2 in hand = 12: fully accounted for.
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2], tracker)
    expect(played.rank).toBe('9')
  })

  it('forced to trump, not secure per tracker, has a point trump available: surrenders the lowest point trump', () => {
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, '9', 1) }]
    const hand = [new Card(Suit.Spades, 'J', 1), new Card(Suit.Spades, 'K', 1)]
    const legalMoves = hand
    const tracker = new PlayTracker() // nothing played -> nowhere near 12 accounted for
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2], tracker)
    expect(played.rank).toBe('K')
  })

  it('forced to trump, not secure, no point trump available: plays the lowest trump', () => {
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, '9', 1) }]
    const hand = [new Card(Suit.Spades, 'J', 1), new Card(Suit.Spades, '9', 1)]
    const legalMoves = hand
    const tracker = new PlayTracker()
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2], tracker)
    expect(played.rank).toBe('9')
  })

  it('sluff (void in lead suit and trump): plays from the shortest suit', () => {
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, 'K', 1) }]
    const hand = [
      new Card(Suit.Clubs, '9', 1),
      new Card(Suit.Clubs, '10', 1), // Clubs length 2
      new Card(Suit.Diamonds, '9', 1), // Diamonds length 1 - shortest
    ]
    const legalMoves = hand
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2])
    expect(played.suit).toBe(Suit.Diamonds)
    expect(played.rank).toBe('9')
  })

  it('sluff: when suit lengths tie, plays the lowest rank', () => {
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, 'K', 1) }]
    const hand = [new Card(Suit.Clubs, '9', 1), new Card(Suit.Diamonds, 'A', 1)] // both suits length 1
    const legalMoves = hand
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2])
    expect(played.suit).toBe(Suit.Clubs)
    expect(played.rank).toBe('9')
  })

  // -- The play-policy branch (#153, #156) ----------------------------------

  it("'simple' plays the lowest legal card, skipping every tier above", () => {
    // Partner is winning, so `cascade` feeds them the King (the tier asserted
    // above). `simple` plays the 9 — it never asks who is winning, which is
    // exactly the weakness epic #152 exists to fix and #153 exists to measure.
    const trickPlays: TrickPlay[] = [{ player: 0, card: new Card(Suit.Hearts, 'Q', 1) }]
    const legalMoves = [
      new Card(Suit.Hearts, '9', 1),
      new Card(Suit.Hearts, 'K', 1),
      new Card(Suit.Hearts, '10', 1),
    ]
    const played = withSimplePlay((skill) =>
      chooseFollowCard(legalMoves, legalMoves, trickPlays, Suit.Spades, [0, 2], undefined, skill),
    )
    expect(played.rank).toBe('9')
  })

  // -- "Cannot be beaten" (#158) --------------------------------------------

  it('the two arms answer one position differently, which is what makes the A/B a comparison', () => {
    // The dial-is-read check, before any A/B number is believed. One position,
    // forced to beat, only counters legal, the King beatable by an unseen 10 or
    // Ace with two seats still to come. The shipped `'counted'` rule takes with
    // the Ace because it is the only card here that cannot be beaten in suit;
    // the `'off'` baseline spends the King and hopes.
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, 'Q', 1) }]
    const hand = [new Card(Suit.Hearts, 'K', 1), new Card(Suit.Hearts, '10', 1), new Card(Suit.Hearts, 'A', 1)]
    const counted = chooseFollowCard(hand, hand, trickPlays, Suit.Spades, [0, 2], new PlayTracker())
    const off = withSafeCounterOff((skill) =>
      chooseFollowCard(hand, hand, trickPlays, Suit.Spades, [0, 2], new PlayTracker(), skill),
    )
    expect(counted.rank).toBe('A')
    expect(off.rank).toBe('K')
  })

  it('counted: takes with the cheapest counter that cannot be beaten in suit', () => {
    // #158's rule, in a side suit, where `PlayTracker` is exact at every level.
    // The King is boss here: this hand holds one copy of the 10 and one of the
    // Ace, and the other copy of each has been played, so nothing outstanding in
    // Hearts can take the trick off it. Spend the King and keep the Ace.
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, 'Q', 1) }]
    const hand = [new Card(Suit.Hearts, 'K', 1), new Card(Suit.Hearts, '10', 1), new Card(Suit.Hearts, 'A', 1)]
    const tracker = new PlayTracker()
    tracker.record(new Card(Suit.Hearts, '10', 2))
    tracker.record(new Card(Suit.Hearts, 'A', 2))
    const played = chooseFollowCard(hand, hand, trickPlays, Suit.Spades, [0, 2], tracker, 'hard')
    expect(played.rank).toBe('K')
  })

  it('counted: an unknown resolves to "beatable", so the boss card goes in instead', () => {
    // The same position with nothing played. The King *might* hold and the 10
    // *might* hold, and #158 is explicit that a seat must not play the best case
    // — spending a King into a trick an opponent's Ace then takes gives away 20
    // points rather than 10. The Ace is the only card here that cannot lose in
    // suit, so it is the one that takes the trick.
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, 'Q', 1) }]
    const hand = [new Card(Suit.Hearts, 'K', 1), new Card(Suit.Hearts, '10', 1), new Card(Suit.Hearts, 'A', 1)]
    const played = chooseFollowCard(hand, hand, trickPlays, Suit.Spades, [0, 2], new PlayTracker(), 'hard')
    expect(played.rank).toBe('A')
  })

  it('counted: last to the trick, nothing is outstanding, so the cheapest counter wins it', () => {
    // Three cards already down means no seat is left to beat anything, and
    // "cannot be beaten by anything still outstanding" is trivially true of
    // every card. The King takes it and the Ace stays in hand — the same card
    // the `'off'` arm plays, which is why switching #158 on cannot cost the
    // fourth seat anything.
    const trickPlays: TrickPlay[] = [
      { player: 1, card: new Card(Suit.Hearts, 'Q', 1) },
      { player: 2, card: new Card(Suit.Hearts, '9', 1) },
      { player: 3, card: new Card(Suit.Hearts, 'J', 1) },
    ]
    const hand = [new Card(Suit.Hearts, 'K', 1), new Card(Suit.Hearts, '10', 1), new Card(Suit.Hearts, 'A', 1)]
    const played = chooseFollowCard(hand, hand, trickPlays, Suit.Spades, [0, 2], new PlayTracker(), 'hard')
    expect(played.rank).toBe('K')
  })

  it('counted: a free beat still outranks the whole question', () => {
    // Tier 1 is untouched — if a non-counter takes the trick, no counter needs
    // to be evaluated at all. #158 only ever fires where #155 left a gap.
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, 'J', 1) }]
    const hand = [new Card(Suit.Hearts, 'Q', 1), new Card(Suit.Hearts, 'K', 1), new Card(Suit.Hearts, 'A', 1)]
    const played = chooseFollowCard(hand, hand, trickPlays, Suit.Spades, [0, 2], new PlayTracker(), 'hard')
    expect(played.rank).toBe('Q')
  })

  it('counted: with no boss counter and no Ace, it falls back to the cheapest', () => {
    // Tier 3. The King and the 10 can both be beaten by an unaccounted Ace, and
    // there is no Ace in hand to take with, so there is nothing safe to pick and
    // the rule degrades to #155's answer rather than inventing a preference.
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, 'Q', 1) }]
    const hand = [new Card(Suit.Hearts, 'K', 1), new Card(Suit.Hearts, '10', 1)]
    const played = chooseFollowCard(hand, hand, trickPlays, Suit.Spades, [0, 2], new PlayTracker(), 'hard')
    expect(played.rank).toBe('K')
  })

  it('counted: forced to overtrump, expert remembers both Aces are gone and the King is boss', () => {
    // The issue's own worked example, and the only place the skill dial decides
    // a card. Trump was led with the Queen, so `Trick.legalMoves` restricts this
    // seat to beaters and every one of them is a counter. Both trump 10s and
    // both trump Aces are accounted for — one of each in hand, the other of each
    // seen — so the King cannot be beaten in trump and is what takes the trick.
    const trump = Suit.Spades
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(trump, 'Q', 1) }]
    const hand = [new Card(trump, 'K', 1), new Card(trump, '10', 1), new Card(trump, 'A', 1)]
    const seen = [
      new Card(trump, '10', 2),
      new Card(trump, 'A', 2),
      new Card(trump, '9', 1), // two later sightings, to crowd an `easy` memory
      new Card(trump, 'J', 1),
    ]
    const played = chooseFollowCard(hand, hand, trickPlays, trump, [0, 2], new PlayTracker(), 'expert', memoryOf('expert', trump, seen))
    expect(played.rank).toBe('K')
  })

  it('counted: the same position at easy, which has forgotten, plays the Ace instead', () => {
    // Identical cards, identical rule, capacity 2 instead of 10. The two Aces
    // and the second 10 went past four sightings ago and are gone, so as far as
    // this seat knows the King and the 10 can both still be beaten — and #158
    // says an unknown is played as beatable. It takes the trick with the card it
    // is sure of and gives up the Ace to do it.
    //
    // This assertion is the skill dial during trick play. If it ever stops
    // differing from the expert case above, the capacity model has stopped
    // reaching a decision and #157 is inert again.
    const trump = Suit.Spades
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(trump, 'Q', 1) }]
    const hand = [new Card(trump, 'K', 1), new Card(trump, '10', 1), new Card(trump, 'A', 1)]
    const seen = [
      new Card(trump, '10', 2),
      new Card(trump, 'A', 2),
      new Card(trump, '9', 1),
      new Card(trump, 'J', 1),
    ]
    const played = chooseFollowCard(hand, hand, trickPlays, trump, [0, 2], new PlayTracker(), 'easy', memoryOf('easy', trump, seen))
    expect(played.rank).toBe('A')
  })

  it('counted: an exact tracker does not stand in for a forgotten trump', () => {
    // The trap this would have fallen into. `PlayTracker` is handed the same
    // four cards the memory saw and still counts them all, because #157 left it
    // counting perfectly on purpose. If trump safety read the tracker rather
    // than the memory, `easy` would answer this exactly like `expert` and the
    // capacity model would be decorative. It plays the Ace, so it does not.
    const trump = Suit.Spades
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(trump, 'Q', 1) }]
    const hand = [new Card(trump, 'K', 1), new Card(trump, '10', 1), new Card(trump, 'A', 1)]
    const seen = [
      new Card(trump, '10', 2),
      new Card(trump, 'A', 2),
      new Card(trump, '9', 1),
      new Card(trump, 'J', 1),
    ]
    const tracker = new PlayTracker()
    for (const card of seen) tracker.record(card)
    const played = chooseFollowCard(hand, hand, trickPlays, trump, [0, 2], tracker, 'easy', memoryOf('easy', trump, seen))
    expect(played.rank).toBe('A')
  })

  it('counted: a plain ruff is not a forced overtrump and keeps its own tier', () => {
    // Void in Hearts with no trump yet on the table. Every trump in hand beats
    // the Heart winner, but the rules restricted nothing — the seat chose to
    // ruff — so this is not the position #158 is about, and the existing
    // "surrender the lowest point trump" tier still answers it. Pinned because
    // the `Card.beats` test alone would have swallowed this case.
    const trump = Suit.Spades
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, '9', 1) }]
    const hand = [new Card(trump, 'J', 1), new Card(trump, 'K', 1)]
    const played = chooseFollowCard(hand, hand, trickPlays, trump, [0, 2], new PlayTracker(), 'expert', new TrumpMemory(trump, 'expert'))
    expect(played.rank).toBe('K')
  })

  it('every level follows with the cascade, easy included (#156)', () => {
    // `easy` used to be the one level that took the shortcut; now there is no
    // such level. This is the assertion that fails if a future change gives a
    // tier its own card play again — trick play is shared competence, and
    // difficulty lives in `bidPolicy`.
    const trickPlays: TrickPlay[] = [{ player: 0, card: new Card(Suit.Hearts, 'Q', 1) }]
    const legalMoves = [
      new Card(Suit.Hearts, '9', 1),
      new Card(Suit.Hearts, 'K', 1),
      new Card(Suit.Hearts, '10', 1),
    ]
    for (const skill of ['easy', 'medium', 'hard', 'proficient', 'expert'] as const) {
      const played = chooseFollowCard(legalMoves, legalMoves, trickPlays, Suit.Spades, [0, 2], undefined, skill)
      expect(played.rank).toBe('K')
    }
  })
})

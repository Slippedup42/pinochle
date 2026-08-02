import { describe, expect, it } from 'vitest'
import type { SkillLevel } from '../persistence/options'
import { Card, Suit } from './card'
import { SKILL_PARAMS } from './skills'
import type { TrickPlay } from './trick'
import { chooseFollowCard, chooseLeadCard, PlayTracker } from './tracker'

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

  it('forced beat: every legal card already beats the winner - plays the lowest one that still wins', () => {
    // Opponent (player 1) is winning with a weak 9 of the lead suit; both
    // legal cards outrank it, so this is a forced beat regardless of who's
    // winning - the cheapest winner is played to save bigger cards.
    const trickPlays: TrickPlay[] = [{ player: 1, card: new Card(Suit.Hearts, '9', 1) }]
    const legalMoves = [new Card(Suit.Hearts, '10', 1), new Card(Suit.Hearts, 'A', 1)]
    const hand = legalMoves
    const played = chooseFollowCard(hand, legalMoves, trickPlays, Suit.Spades, [0, 2])
    expect(played.rank).toBe('10')
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

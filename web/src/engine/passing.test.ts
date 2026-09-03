import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SKILL_LEVELS, SKILL_PARAMS, type SkillLevel, type SkillParams } from './skills'
import { Card, Deck, Suit } from './card'
import { PASS_COUNT, bidderPassSelection, choosePassCards, partnerPassSelection } from './passing'

describe('partnerPassSelection', () => {
  it('D/S category: sends QS and JD to the bidder first', () => {
    const hand = [
      new Card(Suit.Spades, 'Q', 1),
      new Card(Suit.Diamonds, 'J', 1),
      new Card(Suit.Diamonds, 'K', 1),
      new Card(Suit.Hearts, '9', 1),
      new Card(Suit.Clubs, '9', 1),
    ]
    const chosen = partnerPassSelection(hand, Suit.Diamonds, 'DS', 2)
    expect(chosen).toHaveLength(2)
    expect(chosen.some((c) => c.suit === Suit.Spades && c.rank === 'Q')).toBe(true)
    expect(chosen.some((c) => c.suit === Suit.Diamonds && c.rank === 'J')).toBe(true)
  })

  it('H/C category: sends trump K/Q first (no QS/JD tier)', () => {
    const hand = [
      new Card(Suit.Hearts, 'K', 1),
      new Card(Suit.Hearts, 'Q', 1),
      new Card(Suit.Clubs, 'A', 1),
      new Card(Suit.Spades, '9', 1),
    ]
    const chosen = partnerPassSelection(hand, Suit.Hearts, 'HC', 1)
    expect(chosen).toHaveLength(1)
    expect(chosen[0].suit).toBe(Suit.Hearts)
    expect(['K', 'Q']).toContain(chosen[0].rank)
  })

  it('always returns exactly `count` cards, padding with a fallback tier', () => {
    const hand = [new Card(Suit.Clubs, '9', 1), new Card(Suit.Hearts, '9', 1), new Card(Suit.Spades, '9', 2)]
    const chosen = partnerPassSelection(hand, Suit.Diamonds, 'DS', 3)
    expect(chosen).toHaveLength(3)
  })
})

describe('bidderPassSelection', () => {
  it('protects trump cards, preferring safe non-trump filler', () => {
    const hand = [
      new Card(Suit.Spades, 'A', 1), // trump, protected
      new Card(Suit.Spades, 'K', 1), // trump, protected
      new Card(Suit.Hearts, '9', 1), // safe non-trump filler
      new Card(Suit.Clubs, '9', 1),
      new Card(Suit.Diamonds, '10', 1),
    ]
    const chosen = bidderPassSelection(hand, Suit.Spades, 'DS', 1)
    expect(chosen).toHaveLength(1)
    expect(chosen[0].suit).not.toBe(Suit.Spades)
  })

  it('H/C pro move (Queens Around + Pinochle + a trump run card) withholds QS/JD', () => {
    const hand = [
      new Card(Suit.Hearts, 'Q', 1), // trump Q -> Queens Around piece + run card
      new Card(Suit.Spades, 'Q', 1), // Queens Around piece + Pinochle piece
      new Card(Suit.Diamonds, 'Q', 1), // Queens Around piece
      new Card(Suit.Clubs, 'Q', 1), // Queens Around piece
      new Card(Suit.Diamonds, 'J', 1), // Pinochle piece
      new Card(Suit.Clubs, '9', 1), // safe filler
    ]
    const chosen = bidderPassSelection(hand, Suit.Hearts, 'HC', 1)
    expect(chosen.some((c) => c.suit === Suit.Spades && c.rank === 'Q')).toBe(false)
    expect(chosen.some((c) => c.suit === Suit.Diamonds && c.rank === 'J')).toBe(false)
  })

  it('without the pro move, H/C still sends QS/JD first', () => {
    const hand = [new Card(Suit.Spades, 'Q', 1), new Card(Suit.Diamonds, 'J', 1), new Card(Suit.Clubs, '9', 1)]
    const chosen = bidderPassSelection(hand, Suit.Hearts, 'HC', 1)
    expect(chosen).toHaveLength(1)
    const c = chosen[0]
    const isPinochlePiece = (c.suit === Suit.Spades && c.rank === 'Q') || (c.suit === Suit.Diamonds && c.rank === 'J')
    expect(isPinochlePiece).toBe(true)
  })

  it('never passes an Ace unless every other tier is exhausted', () => {
    const hand = [new Card(Suit.Diamonds, 'A', 1), new Card(Suit.Clubs, '9', 1)]
    const chosen = bidderPassSelection(hand, Suit.Spades, 'DS', 1)
    expect(chosen[0].rank).not.toBe('A')
  })
})

describe('choosePassCards', () => {
  it('falls back to a random sample when trumpSuit/isBidWinner are omitted', () => {
    const hand = [
      new Card(Suit.Spades, 'A', 1),
      new Card(Suit.Diamonds, 'K', 1),
      new Card(Suit.Clubs, '9', 1),
      new Card(Suit.Hearts, 'J', 1),
    ]
    const chosen = choosePassCards(hand, 3)
    expect(chosen).toHaveLength(3)
    for (const c of chosen) expect(hand).toContain(c)
  })

  it('dispatches to bidderPassSelection / partnerPassSelection based on isBidWinner', () => {
    const hand = [
      new Card(Suit.Spades, 'A', 1),
      new Card(Suit.Spades, 'K', 1),
      new Card(Suit.Hearts, '9', 1),
      new Card(Suit.Clubs, '9', 1),
    ]
    const asBidder = choosePassCards(hand, 2, Suit.Spades, true)
    const asPartner = choosePassCards(hand, 2, Suit.Spades, false)
    expect(asBidder).toEqual(bidderPassSelection(hand, Suit.Spades, 'DS', 2))
    expect(asPartner).toEqual(partnerPassSelection(hand, Suit.Spades, 'DS', 2))
  })

  it('returns exactly `count` cards for a full 12-card hand', () => {
    const suits = [Suit.Spades, Suit.Diamonds, Suit.Clubs, Suit.Hearts]
    const ranks = ['9', 'J', 'Q', 'K', '10', 'A'] as const
    const hand = suits.flatMap((s) => ranks.map((r) => new Card(s, r, 1)))
    expect(choosePassCards(hand, 3, Suit.Spades, true)).toHaveLength(3)
    expect(choosePassCards(hand, 3, Suit.Spades, false)).toHaveLength(3)
  })

  // Parity with the Python fallback-padding safety net (pinochle_engine.py:913-916):
  // both bidderPassSelection and partnerPassSelection end in a catch-all "take
  // anything left" tier, so in practice they always fill `count` on their own
  // whenever the hand has at least `count` cards - the padding branch in
  // choosePassCards is defensive and normally never adds anything. These tests
  // exercise that branch directly via a hand smaller than `count`, where the
  // strategy necessarily under-fills and there's nothing left in the pool to pad
  // with. Python's `random.sample(remaining, count - len(chosen))` would raise
  // ValueError there (sample size > population); the TS port degrades
  // gracefully instead, returning every card the hand actually has.
  it('degrades gracefully (no throw, no duplicates) when the hand has fewer cards than `count`', () => {
    const hand = [new Card(Suit.Hearts, '9', 1), new Card(Suit.Clubs, '9', 1)]

    const asBidder = choosePassCards(hand, 3, Suit.Spades, true)
    expect(asBidder).toHaveLength(hand.length)
    expect(new Set(asBidder).size).toBe(asBidder.length)
    for (const c of asBidder) expect(hand).toContain(c)

    const asPartner = choosePassCards(hand, 3, Suit.Spades, false)
    expect(asPartner).toHaveLength(hand.length)
    expect(new Set(asPartner).size).toBe(asPartner.length)
    for (const c of asPartner) expect(hand).toContain(c)
  })

  it('never fabricates or duplicates cards when padding a single-card hand', () => {
    const onlyCard = new Card(Suit.Diamonds, '9', 1)
    const hand = [onlyCard]

    expect(choosePassCards(hand, 3, Suit.Hearts, true)).toEqual([onlyCard])
    expect(choosePassCards(hand, 3, Suit.Hearts, false)).toEqual([onlyCard])
  })
})

/**
 * A non-trump 10 behind BOTH Aces of its suit is a winner, not a liability
 * (#276) - Paul's ruling, 2026-09-02, from live play.
 *
 * - **Held**: with both Aces of the suit in hand, the suit can be played out
 *   last and the 10 takes the trick behind them.
 * - **Passed**: a 10 delivered to a partner holding the Ace becomes a
 *   20-point trick when the Ace is led and the 10 falls on it.
 *
 * Which of the two applies at a pass decision decides where the card belongs.
 * If THIS hand holds both Aces then the other hand holds none, so passing the
 * 10 cannot buy the drop-on-partner's-Ace trick; all of the value is in
 * keeping the suit intact and cashing it late. So the protected 10 is shed
 * only once ordinary filler is gone, and the two Aces holding it up go with
 * it - keeping the 10 while shedding an Ace would leave a bare 10, which is
 * strictly worse than the behaviour this replaces.
 *
 * Mirrors `test_protected_tens.py`, which covers the Python-only tier-0/tier-1
 * and return-pass paths as well. Trump is spades in the fixtures below so that
 * every J/9 in the hand is trump: that strips out the safe-filler tier which
 * would otherwise fill all three slots before the 10s tier is reached, and
 * leaves the spare K/Q as the ordinary filler the 10 has to outlast.
 */
describe('a 10 behind both Aces of its suit is protected (#276)', () => {
  const names = (cards: readonly Card[]) => cards.map((c) => `${c.rank}${c.suit}`).sort()

  const CLUB_ACES = [new Card(Suit.Clubs, 'A', 1), new Card(Suit.Clubs, 'A', 2)]
  const SIDE_SUITS = [
    new Card(Suit.Hearts, 'A', 1),
    new Card(Suit.Hearts, 'K', 1),
    new Card(Suit.Diamonds, 'A', 1),
    new Card(Suit.Diamonds, 'K', 1),
  ]
  const TRUMP_FILLER = [
    new Card(Suit.Spades, 'A', 1),
    new Card(Suit.Spades, '10', 1),
    new Card(Suit.Spades, '10', 2),
    new Card(Suit.Spades, 'Q', 1),
    new Card(Suit.Spades, 'Q', 2),
    new Card(Suit.Spades, 'J', 1),
    new Card(Suit.Spades, 'J', 2),
    new Card(Suit.Spades, '9', 1),
    new Card(Suit.Spades, '9', 2),
  ]

  /** 15-card bidder hand holding the 10 of clubs and `clubAces` Aces of clubs. */
  const bidderHand = (clubAces: number): Card[] => {
    const hand = [new Card(Suit.Clubs, '10', 1), new Card(Suit.Clubs, 'K', 1)]
    hand.push(...CLUB_ACES.slice(0, clubAces))
    hand.push(...SIDE_SUITS)
    hand.push(...TRUMP_FILLER.slice(0, 15 - hand.length))
    expect(hand).toHaveLength(15)
    return hand
  }

  it('keeps a 10 with both Aces of its suit behind it, and keeps the Aces too', () => {
    const chosen = names(bidderPassSelection(bidderHand(2), Suit.Spades, 'DS', 3))
    expect(chosen).not.toContain(`10${Suit.Clubs}`)
    expect(chosen).not.toContain(`A${Suit.Clubs}`)
  })

  it('still sheds a 10 behind only one Ace - partial protection is out of scope', () => {
    const chosen = names(bidderPassSelection(bidderHand(1), Suit.Spades, 'DS', 3))
    expect(chosen).toContain(`10${Suit.Clubs}`)
  })

  it('is unchanged for a 10 with no Ace of its suit - still the first thing thrown', () => {
    const chosen = names(bidderPassSelection(bidderHand(0), Suit.Spades, 'DS', 3))
    expect(chosen).toContain(`10${Suit.Clubs}`)
  })

  it('stands the duplicate-Ace pro move down when that pair is holding a 10 up', () => {
    const hand = [
      new Card(Suit.Spades, '10', 1),
      new Card(Suit.Spades, 'A', 1),
      new Card(Suit.Spades, 'A', 2),
      new Card(Suit.Spades, 'K', 1),
      new Card(Suit.Hearts, 'A', 1),
      new Card(Suit.Hearts, 'K', 1),
      new Card(Suit.Clubs, 'A', 1),
      new Card(Suit.Clubs, 'K', 1),
      new Card(Suit.Diamonds, 'A', 1),
      new Card(Suit.Diamonds, '10', 1),
      new Card(Suit.Diamonds, '10', 2),
      new Card(Suit.Diamonds, 'Q', 1),
      new Card(Suit.Diamonds, 'J', 1),
      new Card(Suit.Diamonds, '9', 1),
      new Card(Suit.Diamonds, '9', 2),
    ]
    const chosen = names(bidderPassSelection(hand, Suit.Diamonds, 'DS', 3))
    expect(chosen).not.toContain(`A${Suit.Spades}`)
    expect(chosen).not.toContain(`10${Suit.Spades}`)
  })

  describe("choosePassCards' simplified bidder branch", () => {
    const MELD_ONLY_LEVEL: SkillLevel = 'easy'
    let pristine: SkillParams
    beforeAll(() => {
      pristine = SKILL_PARAMS[MELD_ONLY_LEVEL]
      SKILL_PARAMS[MELD_ONLY_LEVEL] = { ...pristine, handValuation: 'meld_only' }
    })
    afterAll(() => {
      SKILL_PARAMS[MELD_ONLY_LEVEL] = pristine
    })

    // The simplified branch ships non-trump 10s on sight before ranking
    // anything by worth. The exception is tier-agnostic for the same reason
    // the rule is: it is what the card is worth, not a piece of expert-tier
    // sophistication.
    const easyHand = (clubAces: number): Card[] => {
      const hand = [
        new Card(Suit.Clubs, '10', 1),
        new Card(Suit.Clubs, '9', 1),
        new Card(Suit.Clubs, '9', 2),
        new Card(Suit.Clubs, 'J', 1),
        new Card(Suit.Spades, '9', 1),
        new Card(Suit.Spades, '9', 2),
        new Card(Suit.Spades, 'J', 1),
        new Card(Suit.Diamonds, '9', 1),
        new Card(Suit.Diamonds, '9', 2),
        new Card(Suit.Diamonds, 'J', 1),
        new Card(Suit.Hearts, 'A', 1),
        new Card(Suit.Hearts, 'K', 1),
      ]
      hand.push(...CLUB_ACES.slice(0, clubAces))
      return hand
    }

    it('keeps a protected 10 and ships 9/J filler instead', () => {
      const chosen = names(choosePassCards(easyHand(2), 3, Suit.Hearts, true, MELD_ONLY_LEVEL))
      expect(chosen).not.toContain(`10${Suit.Clubs}`)
    })

    it('still ships a 10 behind one Ace', () => {
      const chosen = names(choosePassCards(easyHand(1), 3, Suit.Hearts, true, MELD_ONLY_LEVEL))
      expect(chosen).toContain(`10${Suit.Clubs}`)
    })

    it('is unchanged for a 10 with no Ace of its suit', () => {
      const chosen = names(choosePassCards(easyHand(0), 3, Suit.Hearts, true, MELD_ONLY_LEVEL))
      expect(chosen).toContain(`10${Suit.Clubs}`)
    })
  })
})

/**
 * The 3-card pass, pinned against every configuration the engine has (#196).
 *
 * Paul's dad reported that changing the AI skill level let him pass **4** cards
 * instead of 3. It was not reproducible — he was on a stale deployed build whose
 * one-row hand overflowed and clipped, which is the likelier thing he saw — but
 * "not reproducible" is a weaker guarantee than the rules deserve, and the
 * report named a dial that nothing should connect to the pass at all.
 *
 * So this fixes the count as a property rather than trusting that no future
 * policy row grows a `passCount` field. Every combination the engine can
 * produce — five level slots x both roles x four trumps, over real dealt hands —
 * must return exactly three distinct cards that the hand actually held.
 *
 * #222 removed the setting the report named, and would have quietly gutted this
 * sweep with it: `choosePassCards` branches on `handValuation`, and with one
 * configuration on all five slots the loop would run the same branch five times.
 * So `meld_only` — the arm `easy` used to select, now reachable only through an
 * override — is installed onto one slot for the duration, using the same
 * save/restore `abRun.installPolicies` and `tracker.test.ts` use. The sweep
 * covers what it always covered.
 *
 * `pinochle_rules.md` is the authority: the pass is three cards, always. The
 * existing "returns exactly `count`" tests above take `count` as a parameter and
 * so cannot catch a caller passing the wrong one; these fix the number itself.
 */
describe('the 3-card pass is invariant across skill levels (#196)', () => {
  const SKILLS: readonly SkillLevel[] = SKILL_LEVELS
  const TRUMPS = [Suit.Spades, Suit.Diamonds, Suit.Clubs, Suit.Hearts] as const

  const MELD_ONLY_LEVEL: SkillLevel = 'easy'
  let pristine: SkillParams
  beforeAll(() => {
    pristine = SKILL_PARAMS[MELD_ONLY_LEVEL]
    SKILL_PARAMS[MELD_ONLY_LEVEL] = { ...pristine, handValuation: 'meld_only' }
  })
  afterAll(() => {
    SKILL_PARAMS[MELD_ONLY_LEVEL] = pristine
  })

  it('is three cards, and no configuration is wired to change it', () => {
    expect(PASS_COUNT).toBe(3)
  })

  it('gives exactly 3 distinct cards from the hand, at every skill, role and trump', () => {
    // Reported as a list rather than asserted per-iteration: a single failing
    // combination is far more useful than the first one, since the whole
    // question is *which* dial position misbehaves.
    const bad: string[] = []

    for (let deal = 0; deal < 60; deal++) {
      const deck = new Deck()
      deck.shuffle()
      const hands = deck.deal()

      for (const skill of SKILLS) {
        for (const isBidder of [true, false]) {
          for (const trump of TRUMPS) {
            for (const hand of hands) {
              const chosen = choosePassCards(hand, PASS_COUNT, trump, isBidder, skill)
              const where = `${skill}/${isBidder ? 'bidder' : 'partner'}/${trump}`
              if (chosen.length !== 3) bad.push(`${where}: passed ${chosen.length} cards`)
              if (new Set(chosen).size !== chosen.length) bad.push(`${where}: duplicated a card`)
              if (chosen.some((c) => !hand.includes(c))) bad.push(`${where}: passed a card not in hand`)
            }
          }
        }
      }
    }

    expect(bad.slice(0, 10)).toEqual([])
  })

  it('agrees on the count across every skill level for one identical hand', () => {
    const deck = new Deck()
    deck.shuffle()
    const [hand] = deck.deal()

    for (const isBidder of [true, false]) {
      const counts = SKILLS.map((skill) => choosePassCards(hand, PASS_COUNT, Suit.Spades, isBidder, skill).length)
      expect(new Set(counts)).toEqual(new Set([3]))
    }
  })
})

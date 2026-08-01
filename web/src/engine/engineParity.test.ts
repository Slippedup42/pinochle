// Parity between the TypeScript rules engine and the Python reference engine
// it was ported from (#125, ROADMAP.md Phase 1.6).
//
// `web/src/engine/` is a hand port of `pinochle_engine.py`, and until now each
// side was only ever checked against itself. #118 is what that costs: two Base
// Bid constants (`NEAR_RUN_VALUE`, `NEAR_DOUBLE_PINOCHLE_VALUE`) were ported at
// half value, so the browser named a different trump suit than the reference
// for months, and it surfaced because someone happened to read both files side
// by side while working on something else.
//
// The two things this suite refuses to do, because both are dead ends:
//
//   Seed both engines and compare deals. Python shuffles with `random.Random`;
//   `makeRng` reseeds `Math.random`. Different PRNGs, so the same seed cannot
//   produce the same deal.
//
//   Compare AI decisions. Python runs rollouts, TS `hard`+ runs the evaluator
//   distilled from them (#115). Divergence there is the design.
//
// So `engineParity.fixture.ts` pins the deal *and* the decisions — every card
// of a complete Python round — and what gets compared is only what both sides
// are supposed to agree on: the rules. Meld per hand, the winner and points of
// every trick, the last-trick bonus, the final round score. Plus legality,
// which is the check with the sharpest teeth: a recorded card that
// `Trick.legalMoves` rejects means the two legal-move filters disagree, and
// that is a rules bug regardless of what the scores come out to.

import { describe, expect, it } from 'vitest'
import { meldPointsByTeam } from '../components/gameFlowReducer'
import { Card, type CopyId, RANKS, type Rank, type Suit, SUITS } from './card'
import { PARITY_SCENARIOS, type ParityScenario } from './engineParity.fixture'
import { scoreMelds } from './melds'
import { type Hands, playTrickTakingPhase, scoreRound, type TeamId, teamOf } from './round'
import { type PlayerIndex, Trick } from './trick'

/**
 * Inverse of Python's `Card.__repr__` / TS's `Card.toString()`: `10D_1` ->
 * the 10 of Diamonds, first copy. Kept local to this test for the same reason
 * `evaluatorParity.test.ts` keeps its own copy — the app never parses cards
 * back out of strings, only fixtures do, and an engine API that exists solely
 * for a test is API that will get used somewhere it shouldn't.
 */
function parseHand(tokens: string): Card[] {
  if (tokens === '') return []
  return tokens.split(' ').map((token) => {
    const [body, copy] = token.split('_')
    const suit = body.slice(-1) as Suit
    const rank = body.slice(0, -1) as Rank
    if (!SUITS.includes(suit)) throw new Error(`bad suit in card token '${token}'`)
    if (!RANKS.includes(rank)) throw new Error(`bad rank in card token '${token}'`)
    return new Card(suit, rank, Number(copy) as CopyId)
  })
}

/** Sorted `toString()` tokens — the encoding the fixture stores hands in. */
function handTokens(hand: readonly Card[]): string {
  return hand.map((c) => c.toString()).sort().join(' ')
}

const SEATS: readonly PlayerIndex[] = [0, 1, 2, 3]
const TEAMS: readonly TeamId[] = [0, 1]

function partnerOf(player: PlayerIndex): PlayerIndex {
  return ((player + 2) % 4) as PlayerIndex
}

/**
 * The four hands as they stood when the first card was led, rebuilt from the
 * dealt hands and the two recorded pass lists.
 *
 * Deliberately *derived* rather than read from `handsAfterPass`: the recorded
 * post-pass hands are then something to check against rather than the input to
 * every later assertion, so a pass applied differently on this side shows up
 * here instead of silently disappearing.
 */
function handsAfterPass(scenario: ParityScenario): Hands {
  const hands = scenario.dealtHands.map(parseHand)
  const bidWinner = scenario.bidWinner
  const partner = partnerOf(bidWinner)
  const toBidder = parseHand(scenario.passToBidder)
  const toPartner = parseHand(scenario.passToPartner)

  const remove = (hand: Card[], cards: readonly Card[]) => {
    for (const card of cards) {
      const index = hand.findIndex((c) => c.equals(card))
      if (index === -1) {
        throw new Error(`${scenario.id}: passed ${card.toString()} is not in the dealt hand`)
      }
      hand.splice(index, 1)
    }
  }

  remove(hands[partner], toBidder)
  remove(hands[bidWinner], toPartner)
  hands[bidWinner].push(...toBidder)
  hands[partner].push(...toPartner)
  return hands as Hands
}

/** Every card of a scenario's trick play, flattened into the order it was played. */
function playSequence(scenario: ParityScenario): { seat: PlayerIndex; card: Card }[] {
  const sequence: { seat: PlayerIndex; card: Card }[] = []
  for (const trick of scenario.tricks) {
    let seat = trick.leader
    for (const token of trick.cards) {
      sequence.push({ seat, card: parseHand(token)[0] })
      seat = ((seat + 1) % 4) as PlayerIndex
    }
  }
  return sequence
}

describe('the parity fixture itself', () => {
  // A fixture of five all-Proficient rounds on one trump suit would pass every
  // check below while exercising a fraction of the rules. These assert the
  // coverage the rest of the suite is only as good as.
  it('carries enough complete rounds to be worth replaying', () => {
    expect(PARITY_SCENARIOS.length).toBeGreaterThanOrEqual(20)
    for (const scenario of PARITY_SCENARIOS) {
      expect(scenario.tricks).toHaveLength(12)
      expect(scenario.dealtHands).toHaveLength(4)
      for (const hand of scenario.dealtHands) expect(parseHand(hand)).toHaveLength(12)
      for (const trick of scenario.tricks) expect(trick.cards).toHaveLength(4)
    }
  })

  it('covers all four trump suits', () => {
    expect(new Set(PARITY_SCENARIOS.map((s) => s.trump)).size).toBe(SUITS.length)
  })

  it('covers both a made contract and a set one', () => {
    // The `-bid` branch of `scoreRound` is a rule in its own right, and a
    // fixture where every contract was made would never reach it.
    const verdicts = PARITY_SCENARIOS.map((s) => s.roundScoreByTeam[teamOf(s.bidWinner)] < 0)
    expect(verdicts).toContain(true)
    expect(verdicts).toContain(false)
  })

  it('leads each trick from the previous trick winner', () => {
    // Self-consistency of the recording, not a claim about the TS engine — but
    // if it did not hold, every replay below would be feeding cards to the
    // wrong seats and the failures would be unreadable.
    for (const scenario of PARITY_SCENARIOS) {
      const leaders = scenario.tricks.map((t) => t.leader)
      const expected = [scenario.bidWinner, ...scenario.tricks.slice(0, -1).map((t) => t.winner)]
      expect(`${scenario.id}: ${leaders.join(',')}`).toBe(`${scenario.id}: ${expected.join(',')}`)
    }
  })
})

describe('the 3-card pass', () => {
  it('lands the same 48 cards in the same hands as Python', () => {
    const mismatches = PARITY_SCENARIOS.flatMap((scenario) => {
      const derived = handsAfterPass(scenario)
      return SEATS.filter((seat) => handTokens(derived[seat]) !== scenario.handsAfterPass[seat])
        .map((seat) => `${scenario.id} seat ${seat}: ${handTokens(derived[seat])}`)
    })
    expect(mismatches).toEqual([])
  })

  it('leaves both defending hands untouched', () => {
    for (const scenario of PARITY_SCENARIOS) {
      const untouched = SEATS.filter(
        (seat) => seat !== scenario.bidWinner && seat !== partnerOf(scenario.bidWinner),
      )
      for (const seat of untouched) {
        expect(`${scenario.id} seat ${seat}: ${scenario.handsAfterPass[seat]}`).toBe(
          `${scenario.id} seat ${seat}: ${scenario.dealtHands[seat]}`,
        )
      }
    }
  })
})

describe('meld scoring', () => {
  it('agrees with Python on the total for every hand', () => {
    const mismatches: string[] = []
    for (const scenario of PARITY_SCENARIOS) {
      const hands = handsAfterPass(scenario)
      for (const seat of SEATS) {
        const { total } = scoreMelds(hands[seat], scenario.trump)
        if (total !== scenario.meldByPlayer[seat]) {
          mismatches.push(
            `${scenario.id} seat ${seat} (${scenario.trump} trump): ` +
              `TS ${total} vs Python ${scenario.meldByPlayer[seat]}`,
          )
        }
      }
    }
    expect(mismatches).toEqual([])
  })

  it('agrees on the breakdown, not just the total', () => {
    // Two errors that cancel — a Run counted at Double Run value while a
    // Royal Marriage went missing — produce the right total from the wrong
    // melds, and the total alone would call that parity.
    const mismatches: string[] = []
    for (const scenario of PARITY_SCENARIOS) {
      const hands = handsAfterPass(scenario)
      for (const seat of SEATS) {
        const { breakdown } = scoreMelds(hands[seat], scenario.trump)
        const ours = Object.entries(breakdown).sort().map(([k, v]) => `${k}=${v}`).join(' ')
        const theirs = Object.entries(scenario.meldBreakdownByPlayer[seat])
          .sort()
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')
        if (ours !== theirs) mismatches.push(`${scenario.id} seat ${seat}: [${ours}] vs [${theirs}]`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('agrees on the per-team totals the round is scored from', () => {
    // Through `meldPointsByTeam`, the function the app itself calls, so the
    // seat-to-team mapping is checked and not assumed.
    for (const scenario of PARITY_SCENARIOS) {
      const totals = meldPointsByTeam(handsAfterPass(scenario), scenario.trump)
      expect(`${scenario.id}: ${totals[0]},${totals[1]}`).toBe(
        `${scenario.id}: ${scenario.meldByTeam[0]},${scenario.meldByTeam[1]}`,
      )
    }
  })
})

describe('trick play', () => {
  // The sharpest check in the file. Every recorded card is a card Python's
  // `Trick.legal_moves` allowed at that exact point in that exact hand; if
  // `Trick.legalMoves` refuses one, the two filters disagree about the rules of
  // pinochle and everything downstream is unreliable.
  it('accepts every card Python played as legal', () => {
    const rejected: string[] = []
    for (const scenario of PARITY_SCENARIOS) {
      const sequence = playSequence(scenario)
      let index = 0
      playTrickTakingPhase(
        handsAfterPass(scenario),
        scenario.trump,
        scenario.bidWinner,
        (player, _hand, legal) => {
          const { seat, card } = sequence[index++]
          if (player !== seat) {
            throw new Error(
              `${scenario.id} play ${index - 1}: TS asked seat ${player}, Python played from ${seat}`,
            )
          }
          if (!legal.some((c) => c.equals(card))) {
            rejected.push(
              `${scenario.id} play ${index - 1}: seat ${seat} played ${card.toString()}, ` +
                `TS legal moves were ${legal.map((c) => c.toString()).join(' ')}`,
            )
          }
          return card
        },
      )
    }
    expect(rejected).toEqual([])
  })

  it('offers exactly the moves Python offered, at every follow', () => {
    // The two-directional version of the check above. "Python's card is legal
    // here" only catches a TS filter that is *stricter* than the reference; a
    // looser one passes that test and still ships a browser that lets you
    // underplay a trick you were required to beat, or duck a trump lead while
    // holding trump. Comparing the whole set catches both.
    //
    // Leads are excluded: the legal set there is the whole hand by definition
    // on both sides, so it would only restate `handsAfterPass`.
    const mismatches: string[] = []
    for (const scenario of PARITY_SCENARIOS) {
      const sequence = playSequence(scenario)
      let index = 0
      playTrickTakingPhase(
        handsAfterPass(scenario),
        scenario.trump,
        scenario.bidWinner,
        (_player, _hand, legal, trick) => {
          const { card } = sequence[index]
          const position = index % 4
          if (position > 0) {
            const trickNumber = Math.floor(index / 4)
            const theirs = scenario.tricks[trickNumber].legalFollows[position - 1]
            const ours = handTokens(legal)
            if (ours !== theirs) {
              mismatches.push(
                `${scenario.id} trick ${trickNumber} follow ${position} ` +
                  `(lead ${trick.leadSuit}, ${scenario.trump} trump): [${ours}] vs Python [${theirs}]`,
              )
            }
          }
          index++
          return card
        },
      )
    }
    expect(mismatches).toEqual([])
  })

  it('agrees on the winner and the points of every trick', () => {
    // Resolved through `Trick` directly rather than read out of
    // `playTrickTakingPhase`, so a failure names the trick that diverged
    // instead of a team total that is off by some amount.
    const mismatches: string[] = []
    for (const scenario of PARITY_SCENARIOS) {
      scenario.tricks.forEach((recorded, trickNumber) => {
        const trick = new Trick(scenario.trump)
        let seat = recorded.leader
        for (const token of recorded.cards) {
          trick.play(seat, parseHand(token)[0])
          seat = ((seat + 1) % 4) as PlayerIndex
        }
        const ours = `winner ${trick.winner()} points ${trick.points()}`
        const theirs = `winner ${recorded.winner} points ${recorded.points}`
        if (ours !== theirs) {
          mismatches.push(`${scenario.id} trick ${trickNumber}: ${ours} vs Python ${theirs}`)
        }
      })
    }
    expect(mismatches).toEqual([])
  })

  it('agrees on the trick points each team collected, last-trick bonus included', () => {
    const mismatches: string[] = []
    for (const scenario of PARITY_SCENARIOS) {
      const sequence = playSequence(scenario)
      let index = 0
      const { trickPointsByTeam, trickWinners } = playTrickTakingPhase(
        handsAfterPass(scenario),
        scenario.trump,
        scenario.bidWinner,
        () => sequence[index++].card,
      )
      const winners = `${trickWinners.join(',')}`
      const recordedWinners = scenario.tricks.map((t) => t.winner).join(',')
      if (winners !== recordedWinners) {
        mismatches.push(`${scenario.id} winners: ${winners} vs Python ${recordedWinners}`)
      }
      const ours = `${trickPointsByTeam[0]},${trickPointsByTeam[1]}`
      const theirs = `${scenario.trickPointsByTeam[0]},${scenario.trickPointsByTeam[1]}`
      if (ours !== theirs) mismatches.push(`${scenario.id} points: ${ours} vs Python ${theirs}`)
    }
    expect(mismatches).toEqual([])
  })

  it('awards the +10 last-trick bonus to the same team Python did', () => {
    // Isolated from the totals above because it is the one point in the round
    // that depends on the trick *index* rather than the cards, and a port that
    // dropped it or attached it to the wrong trick would otherwise show up as a
    // generic 10-point discrepancy.
    for (const scenario of PARITY_SCENARIOS) {
      const raw: Record<TeamId, number> = { 0: 0, 1: 0 }
      for (const trick of scenario.tricks) raw[teamOf(trick.winner)] += trick.points
      const bonusTeam = teamOf(scenario.tricks[11].winner)
      const expected = TEAMS.map((t) => raw[t] + (t === bonusTeam ? 10 : 0))
      expect(`${scenario.id}: ${expected.join(',')}`).toBe(
        `${scenario.id}: ${scenario.trickPointsByTeam.join(',')}`,
      )
    }
  })
})

describe('round scoring', () => {
  it('agrees on the final round score for both teams', () => {
    // The end-to-end number. Everything above can be right while the contract
    // check is wrong, and this is the value that actually reaches a player's
    // scoreboard.
    const mismatches: string[] = []
    for (const scenario of PARITY_SCENARIOS) {
      const scores = scoreRound({
        meldPointsByTeam: { 0: scenario.meldByTeam[0], 1: scenario.meldByTeam[1] },
        trickPointsByTeam: {
          0: scenario.trickPointsByTeam[0],
          1: scenario.trickPointsByTeam[1],
        },
        bidWinnerTeam: teamOf(scenario.bidWinner),
        bid: scenario.bid,
      })
      const ours = `${scores[0]},${scores[1]}`
      const theirs = `${scenario.roundScoreByTeam[0]},${scenario.roundScoreByTeam[1]}`
      if (ours !== theirs) {
        mismatches.push(`${scenario.id} (bid ${scenario.bid}): ${ours} vs Python ${theirs}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('replays every scenario end to end and lands on the same score', () => {
    // The same assertion as above, but with meld and trick points recomputed
    // from the cards instead of taken from the fixture — the one path where a
    // TS-side error anywhere in the round can still reach the final number.
    const mismatches: string[] = []
    for (const scenario of PARITY_SCENARIOS) {
      const hands = handsAfterPass(scenario)
      const sequence = playSequence(scenario)
      let index = 0
      const { trickPointsByTeam } = playTrickTakingPhase(
        hands,
        scenario.trump,
        scenario.bidWinner,
        () => sequence[index++].card,
      )
      const scores = scoreRound({
        meldPointsByTeam: meldPointsByTeam(hands, scenario.trump),
        trickPointsByTeam,
        bidWinnerTeam: teamOf(scenario.bidWinner),
        bid: scenario.bid,
      })
      const ours = `${scores[0]},${scores[1]}`
      const theirs = `${scenario.roundScoreByTeam[0]},${scenario.roundScoreByTeam[1]}`
      if (ours !== theirs) mismatches.push(`${scenario.id}: ${ours} vs Python ${theirs}`)
    }
    expect(mismatches).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { Deck, Suit } from './card'
import {
  type ChooseCardFn,
  type Hands,
  playTrickTakingPhase,
  scoreRound,
  teamOf,
} from './round'

describe('teamOf', () => {
  it('pairs player 0 & 2 as team A (0), player 1 & 3 as team B (1)', () => {
    expect(teamOf(0)).toBe(0)
    expect(teamOf(2)).toBe(0)
    expect(teamOf(1)).toBe(1)
    expect(teamOf(3)).toBe(1)
  })
})

// Always plays the first legal card — mirrors the Python engine's
// placeholder `choose_card` fallback (legal_moves[0]), enough to drive a
// full round through without needing real trick-play strategy (out of
// scope for this port).
const chooseFirstLegal: ChooseCardFn = (_player, _hand, legalMoves) => legalMoves[0]

describe('playTrickTakingPhase', () => {
  it('plays all 12 tricks and distributes exactly 250 trick points total (incl. last-trick bonus)', () => {
    const deck = new Deck()
    deck.shuffle()
    const hands = deck.deal() as Hands

    const result = playTrickTakingPhase(hands, Suit.Spades, 0, chooseFirstLegal)

    expect(result.trickWinners).toHaveLength(12)
    const total = result.trickPointsByTeam[0] + result.trickPointsByTeam[1]
    expect(total).toBe(250)
  })

  it('does not mutate the hands passed in', () => {
    const deck = new Deck()
    deck.shuffle()
    const hands = deck.deal() as Hands
    const originalCounts = hands.map((h) => h.length)

    playTrickTakingPhase(hands, Suit.Spades, 0, chooseFirstLegal)

    expect(hands.map((h) => h.length)).toEqual(originalCounts)
  })

  it('the contract winner leads the first trick', () => {
    const deck = new Deck()
    deck.shuffle()
    const hands = deck.deal() as Hands

    let firstTrickLeader: number | undefined
    const recordingChoose: ChooseCardFn = (player, _hand, legalMoves, trick) => {
      if (trick.plays.length === 0 && firstTrickLeader === undefined) {
        firstTrickLeader = player
      }
      return legalMoves[0]
    }

    playTrickTakingPhase(hands, Suit.Diamonds, 2, recordingChoose)
    expect(firstTrickLeader).toBe(2)
  })

  it('the winner of each trick leads the next', () => {
    const deck = new Deck()
    deck.shuffle()
    const hands = deck.deal() as Hands

    const leaders: number[] = []
    const recordingChoose: ChooseCardFn = (player, _hand, legalMoves, trick) => {
      if (trick.plays.length === 0) leaders.push(player)
      return legalMoves[0]
    }

    const result = playTrickTakingPhase(hands, Suit.Clubs, 1, recordingChoose)
    // Every leader after the first should be the previous trick's winner.
    for (let i = 1; i < 12; i++) {
      expect(leaders[i]).toBe(result.trickWinners[i - 1])
    }
  })
})

describe('scoreRound', () => {
  it("scores the bidding team -bid when their total falls short (going set)", () => {
    const scores = scoreRound({
      meldPointsByTeam: { 0: 20, 1: 40 },
      trickPointsByTeam: { 0: 100, 1: 150 },
      bidWinnerTeam: 0,
      bid: 300,
    })
    // Team 0 (bidding): 20 + 100 = 120 < 300 -> goes set, scores -300.
    expect(scores[0]).toBe(-300)
    // Team 1 (defending) always keeps its own meld + trick points.
    expect(scores[1]).toBe(190)
  })

  it('scores the bidding team their actual total when they make the contract', () => {
    const scores = scoreRound({
      meldPointsByTeam: { 0: 150, 1: 10 },
      trickPointsByTeam: { 0: 160, 1: 90 },
      bidWinnerTeam: 0,
      bid: 300,
    })
    // Team 0: 150 + 160 = 310 >= 300 -> makes it, scores the real total.
    expect(scores[0]).toBe(310)
    expect(scores[1]).toBe(100)
  })

  it('the defending team scores their own total even if the bidder goes set', () => {
    const scores = scoreRound({
      meldPointsByTeam: { 0: 0, 1: 60 },
      trickPointsByTeam: { 0: 90, 1: 100 },
      bidWinnerTeam: 1,
      bid: 400,
    })
    // Team 1 (bidding): 60 + 100 = 160 < 400 -> goes set, scores -400.
    expect(scores[1]).toBe(-400)
    expect(scores[0]).toBe(90)
  })
})

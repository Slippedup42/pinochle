import { describe, expect, it } from 'vitest'
import { Card, GAME_LOSE_SCORE, GAME_WIN_SCORE, Suit } from '../engine/card'
import type { Hands } from '../engine/round'
import type { PlayerIndex } from '../engine/trick'
import type { AuctionResult } from './auctionTypes'
import { gameFlowReducer, initGameFlowState, type GameFlowState } from './gameFlowReducer'
import type { HandLedgerEntry } from './scoreTypes'
import type { TrickPlayResult } from './trickPlayTypes'

function emptyHands(): Hands {
  return [[], [], [], []]
}

/** One already-played hand, for the ledger tests (#198). */
const ledgerEntry: HandLedgerEntry = {
  hand: 1,
  bidWinnerTeam: 0,
  bid: 300,
  trumpSuit: Suit.Hearts,
  wentSet: false,
  conceded: false,
  roundScoreByTeam: { 0: 320, 1: 90 },
  cumulativeScoresByTeam: { 0: 320, 1: 90 },
}

describe('initGameFlowState', () => {
  it('starts in the dealing phase with empty hands and 0-0 scores', () => {
    const state = initGameFlowState(3)
    expect(state.phase).toBe('dealing')
    expect(state.dealer).toBe(3)
    expect(state.scoresByTeam).toEqual({ 0: 0, 1: 0 })
    expect(state.hands).toEqual(emptyHands())
    expect(state.misdealCheckIndex).toBe(0)
  })

  it('seats the human as "You" and draws 3 unique opponent names (#73)', () => {
    const state = initGameFlowState(3)
    expect(state.seatNames[0]).toBe('You')
    const opponents = [state.seatNames[1], state.seatNames[2], state.seatNames[3]]
    expect(new Set(opponents).size).toBe(3)
    for (const name of opponents) expect(name).not.toBe('You')
  })

  it('draws 2 unique team names (#73)', () => {
    const state = initGameFlowState(3)
    expect(state.teamNames[0]).not.toBe(state.teamNames[1])
    expect(state.teamNames[0]).toBeTruthy()
    expect(state.teamNames[1]).toBeTruthy()
  })
})

describe('gameFlowReducer', () => {
  describe('HANDS_DEALT', () => {
    it('stores the dealt hands and moves to misdeal-check, resetting the check index', () => {
      const state = initGameFlowState(3)
      const hands = emptyHands()
      hands[0] = [new Card(Suit.Spades, 'A', 1)]
      const next = gameFlowReducer(state, { type: 'HANDS_DEALT', hands })
      expect(next.phase).toBe('misdeal-check')
      expect(next.hands).toBe(hands)
      expect(next.misdealCheckIndex).toBe(0)
    })
  })

  describe('MISDEAL_ADVANCE', () => {
    it('advances the check index within misdeal-check', () => {
      const state = { ...initGameFlowState(3), phase: 'misdeal-check' as const, misdealCheckIndex: 1 }
      const next = gameFlowReducer(state, { type: 'MISDEAL_ADVANCE' })
      expect(next.phase).toBe('misdeal-check')
      expect(next.misdealCheckIndex).toBe(2)
    })

    it('moves to the auction phase once all 4 seats have been checked', () => {
      const state = { ...initGameFlowState(3), phase: 'misdeal-check' as const, misdealCheckIndex: 3 }
      const next = gameFlowReducer(state, { type: 'MISDEAL_ADVANCE' })
      expect(next.phase).toBe('auction')
      expect(next.misdealCheckIndex).toBe(4)
    })

    it('is ignored outside misdeal-check', () => {
      const state = initGameFlowState(3) // phase: 'dealing'
      expect(gameFlowReducer(state, { type: 'MISDEAL_ADVANCE' })).toBe(state)
    })
  })

  describe('MISDEAL_RESHUFFLE', () => {
    it('sends the round back to dealing for a redeal', () => {
      const state = { ...initGameFlowState(3), phase: 'misdeal-check' as const, misdealCheckIndex: 2 }
      const next = gameFlowReducer(state, { type: 'MISDEAL_RESHUFFLE' })
      expect(next.phase).toBe('dealing')
    })

    it('is ignored outside misdeal-check', () => {
      const state = initGameFlowState(3)
      expect(gameFlowReducer(state, { type: 'MISDEAL_RESHUFFLE' })).toBe(state)
    })
  })

  describe('AUCTION_COMPLETE', () => {
    it('stores the auction result and moves to the meld phase', () => {
      const state = { ...initGameFlowState(3), phase: 'auction' as const }
      const result: AuctionResult = { hands: emptyHands(), trumpSuit: Suit.Hearts, bidWinner: 0, bid: 300, log: [] }
      const next = gameFlowReducer(state, { type: 'AUCTION_COMPLETE', result })
      expect(next.phase).toBe('meld')
      expect(next.auctionResult).toBe(result)
    })

    it('is ignored outside the auction phase', () => {
      const state = initGameFlowState(3)
      const result: AuctionResult = { hands: emptyHands(), trumpSuit: Suit.Hearts, bidWinner: 0, bid: 300, log: [] }
      expect(gameFlowReducer(state, { type: 'AUCTION_COMPLETE', result })).toBe(state)
    })
  })

  describe('MELD_COMPLETE', () => {
    it('stores meld points and moves to trick-play', () => {
      const state: GameFlowState = {
        ...initGameFlowState(3),
        phase: 'meld',
        auctionResult: { hands: emptyHands(), trumpSuit: Suit.Hearts, bidWinner: 0, bid: 300, log: [] },
      }
      const next = gameFlowReducer(state, { type: 'MELD_COMPLETE', meldPointsByTeam: { 0: 190, 1: 0 } })
      expect(next.phase).toBe('trick-play')
      expect(next.meldPointsByTeam).toEqual({ 0: 190, 1: 0 })
    })

    it('is ignored outside the meld phase', () => {
      const state = initGameFlowState(3)
      expect(gameFlowReducer(state, { type: 'MELD_COMPLETE', meldPointsByTeam: { 0: 0, 1: 0 } })).toBe(state)
    })
  })

  describe('TRICK_COMPLETE', () => {
    function stateAfterAuction(overrides: Partial<AuctionResult> = {}, scoresByTeam = { 0: 0, 1: 0 }): GameFlowState {
      // Player 0 (team 0) holds a Hearts run + Royal Marriage under Hearts
      // trump; player 1 (team 1) holds nothing special — gives a
      // deterministic, non-zero meld split to assert on.
      const hands = emptyHands()
      hands[0] = [
        new Card(Suit.Hearts, 'A', 1),
        new Card(Suit.Hearts, '10', 1),
        new Card(Suit.Hearts, 'K', 1),
        new Card(Suit.Hearts, 'Q', 1),
        new Card(Suit.Hearts, 'J', 1),
      ]
      hands[1] = [new Card(Suit.Spades, '9', 1)]
      const result: AuctionResult = { hands, trumpSuit: Suit.Hearts, bidWinner: 0, bid: 300, log: [], ...overrides }
      return {
        ...initGameFlowState(3),
        phase: 'trick-play',
        auctionResult: result,
        scoresByTeam,
      }
    }

    it('computes meld + trick points into a round summary and updates cumulative scores', () => {
      const state = stateAfterAuction()
      const trickResult: TrickPlayResult = { trickPointsByTeam: { 0: 100, 1: 150 }, trickWinners: [] }
      const next = gameFlowReducer(state, { type: 'TRICK_COMPLETE', result: trickResult })

      expect(next.phase).toBe('round-summary')
      expect(next.roundSummary).not.toBeNull()
      // Team 0: Run (150) + Royal Marriage (40) = 190 meld + 100 trick = 290 >= bid 300? no -> set.
      expect(next.roundSummary?.meldPointsByTeam[0]).toBe(190)
      expect(next.roundSummary?.meldPointsByTeam[1]).toBe(0)
      expect(next.roundSummary?.trickPointsByTeam).toEqual({ 0: 100, 1: 150 })
      expect(next.roundSummary?.bidWinnerTeam).toBe(0)
      expect(next.roundSummary?.bid).toBe(300)
      // 190 + 100 = 290 < 300 bid -> bidding team (0) goes set, scores -300.
      expect(next.roundSummary?.roundScoreByTeam).toEqual({ 0: -300, 1: 150 })
      expect(next.roundSummary?.cumulativeScoresByTeam).toEqual({ 0: -300, 1: 150 })
      expect(next.scoresByTeam).toEqual({ 0: -300, 1: 150 })
    })

    it('adds this round on top of prior cumulative scores', () => {
      const state = stateAfterAuction({}, { 0: 400, 1: 200 })
      // Now the bidding team clears their bid: 190 meld + 200 trick = 390 >= 300.
      const trickResult: TrickPlayResult = { trickPointsByTeam: { 0: 200, 1: 50 }, trickWinners: [] }
      const next = gameFlowReducer(state, { type: 'TRICK_COMPLETE', result: trickResult })
      expect(next.roundSummary?.roundScoreByTeam).toEqual({ 0: 390, 1: 50 })
      expect(next.scoresByTeam).toEqual({ 0: 790, 1: 250 })
    })

    it('is ignored outside trick-play', () => {
      const state = initGameFlowState(3)
      const trickResult: TrickPlayResult = { trickPointsByTeam: { 0: 0, 1: 0 }, trickWinners: [] }
      expect(gameFlowReducer(state, { type: 'TRICK_COMPLETE', result: trickResult })).toBe(state)
    })

    it('appends the hand to the game ledger, numbered and carrying the bid (#198)', () => {
      const state = stateAfterAuction()
      const trickResult: TrickPlayResult = { trickPointsByTeam: { 0: 100, 1: 150 }, trickWinners: [] }
      const next = gameFlowReducer(state, { type: 'TRICK_COMPLETE', result: trickResult })

      expect(next.handLedger).toHaveLength(1)
      expect(next.handLedger[0]).toEqual({
        hand: 1,
        bidWinnerTeam: 0,
        bid: 300,
        trumpSuit: Suit.Hearts,
        // 190 meld + 100 tricks = 290 < 300 -> set (see the first test above).
        wentSet: true,
        conceded: false,
        roundScoreByTeam: { 0: -300, 1: 150 },
        cumulativeScoresByTeam: { 0: -300, 1: 150 },
      })
    })

    it('numbers each hand after the last and keeps the earlier ones (#198)', () => {
      const first = gameFlowReducer(stateAfterAuction(), {
        type: 'TRICK_COMPLETE',
        result: { trickPointsByTeam: { 0: 100, 1: 150 }, trickWinners: [] },
      })
      // Second hand, played from the scores and ledger the first one left.
      const second = gameFlowReducer(
        { ...stateAfterAuction({}, first.scoresByTeam), handLedger: first.handLedger },
        { type: 'TRICK_COMPLETE', result: { trickPointsByTeam: { 0: 200, 1: 50 }, trickWinners: [] } },
      )

      expect(second.handLedger.map((e) => e.hand)).toEqual([1, 2])
      expect(second.handLedger[0].roundScoreByTeam).toEqual({ 0: -300, 1: 150 })
      // 190 meld + 200 tricks = 390 >= 300 -> made, and the running totals
      // pick up where hand 1 left off.
      expect(second.handLedger[1].wentSet).toBe(false)
      expect(second.handLedger[1].roundScoreByTeam).toEqual({ 0: 390, 1: 50 })
      expect(second.handLedger[1].cumulativeScoresByTeam).toEqual({ 0: 90, 1: 200 })
    })

    it('marks a folded hand as conceded in the ledger (#198)', () => {
      const state = stateAfterAuction()
      const next = gameFlowReducer(state, {
        type: 'TRICK_COMPLETE',
        result: { trickPointsByTeam: { 0: 0, 1: 0 }, trickWinners: [], conceded: true },
      })
      expect(next.handLedger[0].conceded).toBe(true)
      expect(next.handLedger[0].wentSet).toBe(true)
    })
  })

  describe('CONTINUE_ROUND', () => {
    function stateAfterRoundSummary(scoresByTeam: Record<0 | 1, number>, bidWinnerTeam: 0 | 1 = 0): GameFlowState {
      return {
        ...initGameFlowState(3),
        phase: 'round-summary',
        scoresByTeam,
        roundSummary: {
          meldPointsByTeam: { 0: 0, 1: 0 },
          trickPointsByTeam: { 0: 0, 1: 0 },
          roundScoreByTeam: { 0: 0, 1: 0 },
          bidWinnerTeam,
          bid: 300,
          cumulativeScoresByTeam: scoresByTeam,
          teamNames: { 0: 'Team A', 1: 'Team B' },
        },
      }
    }

    it('rotates the dealer clockwise and redeals when the game continues', () => {
      const state = stateAfterRoundSummary({ 0: 100, 1: 100 })
      const next = gameFlowReducer(state, { type: 'CONTINUE_ROUND' })
      expect(next.phase).toBe('dealing')
      expect(next.dealer).toBe(((3 + 1) % 4) as PlayerIndex)
      expect(next.auctionResult).toBeNull()
      expect(next.roundSummary).toBeNull()
    })

    it('ends the game once a team crosses the win threshold', () => {
      const state = stateAfterRoundSummary({ 0: GAME_WIN_SCORE, 1: 400 }, 0)
      const next = gameFlowReducer(state, { type: 'CONTINUE_ROUND' })
      expect(next.phase).toBe('game-over')
      expect(next.gameOverData).toEqual({
        winningTeam: 0,
        finalScoresByTeam: { 0: GAME_WIN_SCORE, 1: 400 },
        teamNames: state.teamNames,
      })
    })

    it('ends the game in the other team\'s favor once a team busts to the loss threshold', () => {
      const state = stateAfterRoundSummary({ 0: GAME_LOSE_SCORE, 1: 400 }, 0)
      const next = gameFlowReducer(state, { type: 'CONTINUE_ROUND' })
      expect(next.phase).toBe('game-over')
      expect(next.gameOverData?.winningTeam).toBe(1)
    })

    it('is ignored outside round-summary', () => {
      const state = initGameFlowState(3)
      expect(gameFlowReducer(state, { type: 'CONTINUE_ROUND' })).toBe(state)
    })

    it('carries the game ledger into the next round (#198)', () => {
      const state = { ...stateAfterRoundSummary({ 0: 100, 1: 100 }), handLedger: [ledgerEntry] }
      const next = gameFlowReducer(state, { type: 'CONTINUE_ROUND' })
      expect(next.phase).toBe('dealing')
      expect(next.handLedger).toEqual([ledgerEntry])
    })
  })

  describe('NEW_GAME', () => {
    it('resets scores to 0-0, sets the dealer, and moves to dealing', () => {
      const state: GameFlowState = {
        ...initGameFlowState(1),
        phase: 'game-over',
        scoresByTeam: { 0: 1000, 1: -400 },
        gameOverData: {
          winningTeam: 0,
          finalScoresByTeam: { 0: 1000, 1: -400 },
          teamNames: { 0: 'Team A', 1: 'Team B' },
        },
      }
      const next = gameFlowReducer(state, { type: 'NEW_GAME', dealer: 3 })
      expect(next.phase).toBe('dealing')
      expect(next.dealer).toBe(3)
      expect(next.scoresByTeam).toEqual({ 0: 0, 1: 0 })
      expect(next.gameOverData).toBeNull()
    })

    it('clears the game ledger so a new game starts from an empty one (#198)', () => {
      const state: GameFlowState = { ...initGameFlowState(1), phase: 'game-over', handLedger: [ledgerEntry] }
      expect(gameFlowReducer(state, { type: 'NEW_GAME', dealer: 3 }).handLedger).toEqual([])
    })

    it('redraws seat and team names for the new game (#73)', () => {
      const state: GameFlowState = { ...initGameFlowState(1), phase: 'game-over' }
      const next = gameFlowReducer(state, { type: 'NEW_GAME', dealer: 3 })
      expect(next.seatNames[0]).toBe('You')
      const opponents = [next.seatNames[1], next.seatNames[2], next.seatNames[3]]
      expect(new Set(opponents).size).toBe(3)
      expect(next.teamNames[0]).not.toBe(next.teamNames[1])
    })
  })
})

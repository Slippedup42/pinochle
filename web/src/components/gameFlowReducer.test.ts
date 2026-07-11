import { describe, expect, it } from 'vitest'
import { Card, GAME_LOSE_SCORE, GAME_WIN_SCORE, Suit } from '../engine/card'
import type { Hands } from '../engine/round'
import type { PlayerIndex } from '../engine/trick'
import type { AuctionResult } from './auctionTypes'
import { gameFlowReducer, initGameFlowState, type GameFlowState } from './gameFlowReducer'
import type { TrickPlayResult } from './trickPlayTypes'

function emptyHands(): Hands {
  return [[], [], [], []]
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
    it('stores the auction result and moves to trick-play', () => {
      const state = { ...initGameFlowState(3), phase: 'auction' as const }
      const result: AuctionResult = { hands: emptyHands(), trumpSuit: Suit.Hearts, bidWinner: 0, bid: 300 }
      const next = gameFlowReducer(state, { type: 'AUCTION_COMPLETE', result })
      expect(next.phase).toBe('trick-play')
      expect(next.auctionResult).toBe(result)
    })

    it('is ignored outside the auction phase', () => {
      const state = initGameFlowState(3)
      const result: AuctionResult = { hands: emptyHands(), trumpSuit: Suit.Hearts, bidWinner: 0, bid: 300 }
      expect(gameFlowReducer(state, { type: 'AUCTION_COMPLETE', result })).toBe(state)
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
      const result: AuctionResult = { hands, trumpSuit: Suit.Hearts, bidWinner: 0, bid: 300, ...overrides }
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
      expect(next.gameOverData).toEqual({ winningTeam: 0, finalScoresByTeam: { 0: GAME_WIN_SCORE, 1: 400 } })
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
  })

  describe('NEW_GAME', () => {
    it('resets scores to 0-0, sets the dealer, and moves to dealing', () => {
      const state: GameFlowState = {
        ...initGameFlowState(1),
        phase: 'game-over',
        scoresByTeam: { 0: 1000, 1: -400 },
        gameOverData: { winningTeam: 0, finalScoresByTeam: { 0: 1000, 1: -400 } },
      }
      const next = gameFlowReducer(state, { type: 'NEW_GAME', dealer: 3 })
      expect(next.phase).toBe('dealing')
      expect(next.dealer).toBe(3)
      expect(next.scoresByTeam).toEqual({ 0: 0, 1: 0 })
      expect(next.gameOverData).toBeNull()
    })
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { Card, Suit } from '../engine/card'
import type { GameFlowState } from '../components/gameFlowReducer'
import { initGameFlowState } from '../components/gameFlowReducer'
import { initTrickPlayState, trickPlayReducer } from '../components/trickPlayReducer'
import type { AuctionResult } from '../components/auctionTypes'
import { clearSave, hasSavedGame, loadGame, saveGame } from './gameSave'

const SEAT_NAMES = { 0: 'You', 1: 'West', 2: 'Partner', 3: 'East' } as const

afterEach(() => {
  window.localStorage.clear()
})

describe('game save persistence', () => {
  it('reports no save and loads null when nothing has been saved yet', () => {
    expect(hasSavedGame()).toBe(false)
    expect(loadGame()).toBeNull()
  })

  it('round-trips a simple in-auction state, reviving real Card instances', () => {
    const state: GameFlowState = {
      ...initGameFlowState(3),
      phase: 'auction',
      hands: [
        [new Card(Suit.Hearts, 'A', 1), new Card(Suit.Spades, '9', 1)],
        [],
        [],
        [],
      ],
    }
    saveGame(state)

    expect(hasSavedGame()).toBe(true)
    const loaded = loadGame()
    expect(loaded).not.toBeNull()
    expect(loaded!.phase).toBe('auction')
    expect(loaded!.dealer).toBe(3)

    // The revived card is a real Card instance — its class methods work,
    // not just its plain suit/rank/copyId data.
    const revivedCard = loaded!.hands[0][0]
    expect(revivedCard).toBeInstanceOf(Card)
    expect(revivedCard.rankValue).toBe(new Card(Suit.Hearts, 'A', 1).rankValue)
    expect(revivedCard.equals(new Card(Suit.Hearts, 'A', 1))).toBe(true)
    expect(revivedCard.toString()).toBe('AH_1')
  })

  it('round-trips an auctionResult, reviving its hands too', () => {
    const auctionResult: AuctionResult = {
      hands: [
        [new Card(Suit.Diamonds, 'K', 2)],
        [],
        [],
        [],
      ],
      trumpSuit: Suit.Diamonds,
      bidWinner: 0,
      bid: 320,
    }
    const state: GameFlowState = { ...initGameFlowState(3), phase: 'trick-play', auctionResult }
    saveGame(state)

    const loaded = loadGame()
    expect(loaded!.auctionResult).not.toBeNull()
    expect(loaded!.auctionResult!.trumpSuit).toBe(Suit.Diamonds)
    const revived = loaded!.auctionResult!.hands[0][0]
    expect(revived).toBeInstanceOf(Card)
    expect(revived.beats(new Card(Suit.Diamonds, 'Q', 1), Suit.Diamonds)).toBe(true)
  })

  it('round-trips a trick-play checkpoint (trick-in-progress state), reviving cards in hands, currentTrick, and the log', () => {
    // Drive a real trick to completion via trickPlayReducer, the same way
    // TrickPlayFlow.tsx's onCheckpoint would capture state after the
    // trick clears — this is exactly the shape GameFlowState.trickPlayCheckpoint holds.
    const hands = [
      [new Card(Suit.Hearts, 'A', 1)],
      [new Card(Suit.Hearts, '9', 1)],
      [new Card(Suit.Clubs, '9', 1)],
      [new Card(Suit.Diamonds, '9', 1)],
    ] as [Card[], Card[], Card[], Card[]]
    let trickState = initTrickPlayState(hands, Suit.Spades, 1, SEAT_NAMES)
    trickState = trickPlayReducer(trickState, { type: 'PLAY_CARD', player: 1, card: hands[1][0] })
    trickState = trickPlayReducer(trickState, { type: 'PLAY_CARD', player: 2, card: hands[2][0] })
    trickState = trickPlayReducer(trickState, { type: 'PLAY_CARD', player: 3, card: hands[3][0] })
    trickState = trickPlayReducer(trickState, { type: 'PLAY_CARD', player: 0, card: hands[0][0] })
    expect(trickState.phase).toBe('trick-complete')
    trickState = trickPlayReducer(trickState, { type: 'CLEAR_TRICK' })
    // A round is 12 tricks; only one was played above, so this just moves
    // on to trick 2 rather than completing the whole round.
    expect(trickState.phase).toBe('playing')
    expect(trickState.trickNumber).toBe(1)

    const state: GameFlowState = {
      ...initGameFlowState(3),
      phase: 'trick-play',
      auctionResult: { hands, trumpSuit: Suit.Spades, bidWinner: 1, bid: 300 },
      trickPlayCheckpoint: trickState,
    }
    saveGame(state)

    const loaded = loadGame()!
    const checkpoint = loaded.trickPlayCheckpoint!
    expect(checkpoint).not.toBeNull()
    expect(checkpoint.trickWinners).toEqual([0]) // human's Ace of Hearts wins
    expect(checkpoint.log.length).toBeGreaterThan(0)

    const cardPlayEntry = checkpoint.log.find((e) => e.kind === 'card-play')!
    expect(cardPlayEntry.card).toBeInstanceOf(Card)
    // All hands are now empty (the single card in each was played), but the
    // reviver still runs over an empty array without error.
    expect(checkpoint.hands.every((h) => h.length === 0)).toBe(true)
  })

  it('clearSave removes the save', () => {
    saveGame(initGameFlowState(3))
    expect(hasSavedGame()).toBe(true)
    clearSave()
    expect(hasSavedGame()).toBe(false)
  })

  it('treats corrupt JSON as no save', () => {
    window.localStorage.setItem('pinochle:save:v1', '{not json')
    expect(loadGame()).toBeNull()
  })

  it('treats a save from an unrecognized version as no save', () => {
    window.localStorage.setItem(
      'pinochle:save:v1',
      JSON.stringify({ version: 999, state: initGameFlowState(3) }),
    )
    expect(loadGame()).toBeNull()
  })
})

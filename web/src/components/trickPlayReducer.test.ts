import { describe, expect, it } from 'vitest'
import { Card, Suit } from '../engine/card'
import type { PlayerIndex } from '../engine/trick'
import {
  buildTrick,
  initTrickPlayState,
  teammatesOf,
  trickPlayReducer,
  type TrickPlayState,
} from './trickPlayReducer'

const SEAT_NAMES: Record<PlayerIndex, string> = { 0: 'You', 1: 'West', 2: 'Partner', 3: 'East' }

function baseState(bidWinner: PlayerIndex = 0): TrickPlayState {
  const hands = [[], [], [], []] as [Card[], Card[], Card[], Card[]]
  return initTrickPlayState(hands, Suit.Hearts, bidWinner, SEAT_NAMES)
}

/** Plays a full 4-card trick (all Hearts = trump) so tests don't have to
 * repeat the same 4 PLAY_CARD dispatches to reach 'trick-complete'. */
function playFullTrick(state: TrickPlayState): TrickPlayState {
  let next = state
  const cards: [PlayerIndex, Card][] = [
    [0, new Card(Suit.Hearts, 'A', 1)], // 10 points, highest trump — wins
    [1, new Card(Suit.Hearts, '9', 1)],
    [2, new Card(Suit.Hearts, 'J', 1)],
    [3, new Card(Suit.Hearts, 'Q', 1)],
  ]
  for (const [player, card] of cards) {
    next = trickPlayReducer(next, { type: 'PLAY_CARD', player, card })
  }
  return next
}

describe('trickPlayReducer', () => {
  it('starts with the bid winner leading trick 0', () => {
    const state = baseState(2)
    expect(state.leader).toBe(2)
    expect(state.turn).toBe(2)
    expect(state.trickNumber).toBe(0)
    expect(state.phase).toBe('playing')
  })

  it('advances turn and logs each card played before the trick completes', () => {
    let state = baseState(0)
    const card = new Card(Suit.Hearts, 'A', 1)
    state = trickPlayReducer(state, { type: 'PLAY_CARD', player: 0, card })
    expect(state.turn).toBe(1)
    expect(state.phase).toBe('playing')
    expect(state.currentTrick).toEqual([{ player: 0, card }])
    expect(state.log).toEqual([{ kind: 'card-play', player: 0, name: 'You', card, isLead: true }])
  })

  it('logs a follow (non-lead) play once the trick has started', () => {
    let state = baseState(0)
    state = trickPlayReducer(state, { type: 'PLAY_CARD', player: 0, card: new Card(Suit.Hearts, 'A', 1) })
    const followCard = new Card(Suit.Hearts, '9', 1)
    state = trickPlayReducer(state, { type: 'PLAY_CARD', player: 1, card: followCard })
    expect(state.log.at(-1)).toEqual({ kind: 'card-play', player: 1, name: 'West', card: followCard, isLead: false })
  })

  it('ignores a play from a player whose turn it is not', () => {
    const state = baseState(0)
    const next = trickPlayReducer(state, { type: 'PLAY_CARD', player: 1, card: new Card(Suit.Hearts, 'A', 1) })
    expect(next).toBe(state)
  })

  it('removes the played card from the players hand', () => {
    const card = new Card(Suit.Hearts, 'A', 1)
    let state = baseState(0)
    state = { ...state, hands: [[card], [], [], []] }
    state = trickPlayReducer(state, { type: 'PLAY_CARD', player: 0, card })
    expect(state.hands[0]).toEqual([])
  })

  it('resolves the trick winner/points and settles once the 4th card is played', () => {
    const state = playFullTrick(baseState(0))
    expect(state.phase).toBe('trick-complete')
    expect(state.trickWinners).toEqual([0])
    expect(state.trickPointsByTeam).toEqual({ 0: 10, 1: 0 })
    expect(state.log.at(-1)).toEqual({ kind: 'trick-won', player: 0, name: 'You', points: 10, trickNumber: 0 })
  })

  it('ignores PLAY_CARD once the trick has settled (waiting for CLEAR_TRICK)', () => {
    const settled = playFullTrick(baseState(0))
    const unchanged = trickPlayReducer(settled, {
      type: 'PLAY_CARD',
      player: 0,
      card: new Card(Suit.Spades, '9', 1),
    })
    expect(unchanged).toBe(settled)
  })

  it('CLEAR_TRICK advances to the next trick, led by the previous winner', () => {
    let state = playFullTrick(baseState(0))
    state = trickPlayReducer(state, { type: 'CLEAR_TRICK' })
    expect(state.phase).toBe('playing')
    expect(state.currentTrick).toEqual([])
    expect(state.leader).toBe(0)
    expect(state.turn).toBe(0)
    expect(state.trickNumber).toBe(1)
  })

  it('ignores CLEAR_TRICK while a trick is still in progress', () => {
    const state = baseState(0)
    const unchanged = trickPlayReducer(state, { type: 'CLEAR_TRICK' })
    expect(unchanged).toBe(state)
  })

  it('adds the last-trick bonus to whichever team wins trick 12, then completes on CLEAR_TRICK', () => {
    let state = baseState(0)
    state = { ...state, trickNumber: 11 }
    state = playFullTrick(state)
    // 10 (the Ace) + 10 (last-trick bonus) = 20
    expect(state.trickPointsByTeam).toEqual({ 0: 20, 1: 0 })
    state = trickPlayReducer(state, { type: 'CLEAR_TRICK' })
    expect(state.phase).toBe('complete')
  })
})

describe('teammatesOf', () => {
  it('pairs a player with their partner, matching round.ts teamOf', () => {
    expect(teammatesOf(0)).toEqual([0, 2])
    expect(teammatesOf(1)).toEqual([1, 3])
    expect(teammatesOf(2)).toEqual([2, 0])
    expect(teammatesOf(3)).toEqual([3, 1])
  })
})

describe('buildTrick', () => {
  it('replays plain TrickPlay data into a live Trick with the right winner', () => {
    const trick = buildTrick(Suit.Hearts, [
      { player: 0, card: new Card(Suit.Spades, 'K', 1) },
      { player: 1, card: new Card(Suit.Spades, '10', 1) },
    ])
    expect(trick.winner()).toBe(1)
  })
})

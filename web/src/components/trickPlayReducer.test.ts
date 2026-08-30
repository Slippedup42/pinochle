import { describe, expect, it } from 'vitest'
import { Card, type Rank, Suit } from '../engine/card'
import type { PlayerIndex } from '../engine/trick'
import { CLAIMABLE_TRUMP, claimableHands } from './claimablePosition.fixture'
import { formatTrickPlayLogEntry } from './trickPlayTypes'
import {
  applyClaimIfAvailable,
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

describe('"the rest are mine" (#208)', () => {
  const c = (suit: Suit, rank: Rank, copy: 1 | 2 = 1) => new Card(suit, rank, copy)

  /** The claimable position, from the fixture `TrickPlayFlow.test.tsx` reads
   *  too (#217) — one definition of what "seat 0 cannot be beaten" looks like,
   *  rather than one per suite. */
  const claimableState = (): TrickPlayState =>
    initTrickPlayState(claimableHands(), CLAIMABLE_TRUMP, 0, SEAT_NAMES)

  it('ends the hand and awards every remaining trick point', () => {
    const state = applyClaimIfAvailable(claimableState())
    expect(state.phase).toBe('complete')
    expect(state.claim?.player).toBe(0)
    expect(state.claim?.tricks).toBe(2)
    // 8 counters at 10, plus the last-trick bonus, to seat 0's team.
    expect(state.trickPointsByTeam[0]).toBe(90)
    expect(state.trickPointsByTeam[1]).toBe(0)
  })

  it('records the claimer as the winner of every skipped trick', () => {
    const state = applyClaimIfAvailable(claimableState())
    expect(state.trickWinners).toEqual([0, 0])
  })

  it('carries the claimer\'s hand on the state, for the message to show', () => {
    const state = applyClaimIfAvailable(claimableState())
    expect(state.claim?.cards).toHaveLength(2)
    expect(state.claim?.cards.every((card) => card.suit === Suit.Hearts)).toBe(true)
    expect(state.claim?.name).toBe('You')
  })

  it('logs the claim so the trick log does not just stop', () => {
    const state = applyClaimIfAvailable(claimableState())
    const entry = state.log.at(-1)
    expect(entry?.kind).toBe('claim')
    expect(formatTrickPlayLogEntry(state.log.at(-1)!)).toContain('The rest are mine')
  })

  it('leaves an unclaimable position completely alone', () => {
    // Seat 1 holds a trump, so seat 0 cannot claim.
    const hands = [
      [c(Suit.Hearts, 'A'), c(Suit.Hearts, 'K')],
      [c(Suit.Hearts, 'Q'), c(Suit.Spades, 'K')],
      [c(Suit.Clubs, 'A'), c(Suit.Clubs, 'K')],
      [c(Suit.Diamonds, 'A'), c(Suit.Diamonds, 'K')],
    ] as [Card[], Card[], Card[], Card[]]
    const before = initTrickPlayState(hands, Suit.Hearts, 0, SEAT_NAMES)
    expect(applyClaimIfAvailable(before)).toBe(before)
  })

  it('does not fire mid-trick', () => {
    const state = claimableState()
    const midTrick = trickPlayReducer(state, {
      type: 'PLAY_CARD',
      player: 0,
      card: c(Suit.Hearts, 'A'),
    })
    expect(applyClaimIfAvailable(midTrick)).toBe(midTrick)
  })

  it('fires from CLEAR_TRICK, which is where a real hand reaches it', () => {
    // Three cards each. Seat 0 holds nothing but trump, but seat 1 is on lead,
    // so there is no claim yet — the rule is about the seat with the lead, and
    // seat 1's spades are all trumpable. Seat 1 leads, seat 0 trumps in, and
    // the claim becomes available the moment the lead changes hands.
    const hands = [
      [c(Suit.Hearts, 'A'), c(Suit.Hearts, 'K'), c(Suit.Hearts, 'Q')],
      [c(Suit.Spades, 'A'), c(Suit.Spades, 'K'), c(Suit.Spades, 'Q')],
      [c(Suit.Clubs, 'A'), c(Suit.Clubs, 'K'), c(Suit.Clubs, 'Q')],
      [c(Suit.Diamonds, 'A'), c(Suit.Diamonds, 'K'), c(Suit.Diamonds, 'Q')],
    ] as [Card[], Card[], Card[], Card[]]
    let state = applyClaimIfAvailable(initTrickPlayState(hands, Suit.Hearts, 1, SEAT_NAMES))
    expect(state.phase).toBe('playing')
    expect(state.claim).toBeNull()

    // The reducer removes a played card by identity, so a trick has to be
    // dispatched with the very objects sitting in the hands — not equal copies.
    for (const [player, card] of [
      [1, hands[1][0]],
      [2, hands[2][0]],
      [3, hands[3][0]],
      [0, hands[0][2]],
    ] as [PlayerIndex, Card][]) {
      state = trickPlayReducer(state, { type: 'PLAY_CARD', player, card })
    }
    expect(state.phase).toBe('trick-complete')
    expect(state.trickWinners.at(-1)).toBe(0)

    state = trickPlayReducer(state, { type: 'CLEAR_TRICK' })
    // CLEAR_TRICK hands the lead to seat 0, and the claim fires there.
    expect(state.phase).toBe('complete')
    expect(state.claim?.player).toBe(0)
    expect(state.claim?.tricks).toBe(2)
    // The trick actually played still counts, and the claim adds the rest.
    expect(state.trickPointsByTeam[0]).toBe(30 + 60)
    expect(state.trickWinners).toEqual([0, 0, 0])
  })
})

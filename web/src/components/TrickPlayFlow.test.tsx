import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Card, Deck, Suit } from '../engine/card'
import type { Hands } from '../engine/round'
import type { PlayerIndex } from '../engine/trick'
import { AI_PLAY_DELAY_MS, TrickPlayFlow } from './TrickPlayFlow'
import type { TrickPlayResult } from './trickPlayTypes'

const SEAT_NAMES: Record<PlayerIndex, string> = { 0: 'You', 1: 'West', 2: 'Partner', 3: 'East' }
const SCORES = { 0: 0, 1: 0 }

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('TrickPlayFlow (component)', () => {
  it('highlights only legal cards for the human, forcing a follow of the lead suit', () => {
    vi.useFakeTimers()

    const humanHand = [new Card(Suit.Hearts, 'A', 1), new Card(Suit.Spades, '9', 1)]
    const hands: Hands = [
      humanHand,
      [new Card(Suit.Hearts, '9', 1)], // West — leads, single card, forced
      [new Card(Suit.Clubs, '9', 1)], // Partner — sluffs, single card, forced
      [new Card(Suit.Diamonds, '9', 1)], // East — sluffs, single card, forced
    ]
    const onComplete = vi.fn()

    render(
      <TrickPlayFlow
        hands={hands}
        trumpSuit={Suit.Spades}
        bidWinner={1}
        bid={300}
        seatNames={SEAT_NAMES}
        humanPlayer={0}
        scoresByTeam={SCORES}
        onComplete={onComplete}
      />,
    )

    // West leads, then Partner and East follow — each is an AI turn with a
    // brief delay before it resolves.
    act(() => vi.advanceTimersByTime(AI_PLAY_DELAY_MS))
    act(() => vi.advanceTimersByTime(AI_PLAY_DELAY_MS))
    act(() => vi.advanceTimersByTime(AI_PLAY_DELAY_MS))

    expect(screen.getByText('West led the 9 of Hearts')).not.toBeNull()
    expect(screen.getByText('Partner played the 9 of Clubs')).not.toBeNull()
    expect(screen.getByText('East played the 9 of Diamonds')).not.toBeNull()

    // Now it's the human's turn: holding the lead suit (Hearts), they must
    // follow it — the Ace is legal/clickable, the Spades 9 is not.
    const aceButton = screen.getByRole('button', { name: 'Play A of H' })
    const nineButton = screen.getByRole('button', { name: 'Play 9 of S' })
    expect(aceButton.hasAttribute('disabled')).toBe(false)
    expect(nineButton.hasAttribute('disabled')).toBe(true)

    fireEvent.click(aceButton)

    expect(screen.getByText('You played the A of Hearts')).not.toBeNull()
    // The human's Ace beats West's 9 of Hearts, and nobody played trump —
    // the human's team (0, since human is player 0) wins the trick.
    expect(screen.getByText('You won the trick (10 points)')).not.toBeNull()
  })

  it('never lets the human play an illegal card by clicking a disabled button', () => {
    vi.useFakeTimers()

    const humanHand = [new Card(Suit.Hearts, 'A', 1), new Card(Suit.Spades, '9', 1)]
    const hands: Hands = [
      humanHand,
      [new Card(Suit.Hearts, '9', 1)],
      [new Card(Suit.Clubs, '9', 1)],
      [new Card(Suit.Diamonds, '9', 1)],
    ]

    render(
      <TrickPlayFlow
        hands={hands}
        trumpSuit={Suit.Spades}
        bidWinner={1}
        bid={300}
        seatNames={SEAT_NAMES}
        humanPlayer={0}
        scoresByTeam={SCORES}
      />,
    )

    act(() => vi.advanceTimersByTime(AI_PLAY_DELAY_MS))
    act(() => vi.advanceTimersByTime(AI_PLAY_DELAY_MS))
    act(() => vi.advanceTimersByTime(AI_PLAY_DELAY_MS))

    const nineButton = screen.getByRole('button', { name: 'Play 9 of S' })
    fireEvent.click(nineButton)

    // The illegal Spades 9 is untouched — the trick still only has 3 plays,
    // no card-play entry was logged for it.
    expect(screen.queryByText('You played the 9 of Spades')).toBeNull()
    expect(screen.getByRole('button', { name: 'Play 9 of S' })).not.toBeNull()
  })

  it('plays a full round end-to-end, alternating human clicks with delayed AI auto-play, and reports the trick result', () => {
    vi.useFakeTimers()

    // Full, real 48-card deck (unshuffled — order doesn't matter, only
    // that it's a legitimate deal) so the round can run all 12 tricks to
    // completion without either engine (real Trick.legalMoves) or AI
    // (real chooseLeadCard/chooseFollowCard) ever seeing an empty hand
    // mid-round.
    const hands = new Deck().deal()
    const onComplete = vi.fn()

    render(
      <TrickPlayFlow
        hands={hands}
        trumpSuit={Suit.Hearts}
        bidWinner={0}
        bid={300}
        seatNames={SEAT_NAMES}
        humanPlayer={0}
        scoresByTeam={SCORES}
        onComplete={onComplete}
      />,
    )

    let guard = 0
    while (onComplete.mock.calls.length === 0 && guard < 500) {
      guard++
      const playable = screen
        .queryAllByRole('button', { name: /^Play / })
        .find((button) => !button.hasAttribute('disabled'))
      if (playable) {
        fireEvent.click(playable)
      } else {
        // Either an AI turn or the post-trick settle pause is in flight —
        // advancing past the longer of the two delays flushes whichever
        // is pending.
        act(() => vi.advanceTimersByTime(1200))
      }
    }

    expect(guard).toBeLessThan(500) // sanity: the loop actually terminated, not just gave up
    expect(onComplete).toHaveBeenCalledOnce()

    const result = onComplete.mock.calls[0][0] as TrickPlayResult
    expect(result.trickWinners).toHaveLength(12)
    // 24 point-cards (A/10/K x 4 suits x 2 copies) worth 10 each, plus the
    // +10 last-trick bonus — the full round's points always sum to this,
    // regardless of who won which trick.
    expect(result.trickPointsByTeam[0] + result.trickPointsByTeam[1]).toBe(250)
  })
})

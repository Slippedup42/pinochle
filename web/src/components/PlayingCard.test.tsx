import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Suit } from '../engine/card'
import { PlayingCard } from './PlayingCard'

describe('PlayingCard', () => {
  it('renders rank and suit glyph for a face-up card', () => {
    render(<PlayingCard suit={Suit.Spades} rank="A" />)
    const card = screen.getByRole('img', { name: 'A of S' })
    expect(card.textContent).toContain('A')
    expect(card.textContent).toContain('♠')
  })

  it('colors hearts and diamonds red, spades and clubs black', () => {
    const { container: hearts } = render(<PlayingCard suit={Suit.Hearts} rank="K" />)
    const { container: spades } = render(<PlayingCard suit={Suit.Spades} rank="K" />)
    expect(hearts.firstElementChild?.className).toContain('text-red-600')
    expect(spades.firstElementChild?.className).toContain('text-neutral-900')
  })

  it('renders a face-down card with no rank/suit text', () => {
    render(<PlayingCard suit={Suit.Diamonds} rank="Q" faceDown />)
    const back = screen.getByRole('img', { name: 'face-down card' })
    expect(back.textContent).toBe('')
    expect(screen.queryByText('Q')).toBeNull()
  })

  it('renders every suit and rank without throwing', () => {
    const suits = [Suit.Spades, Suit.Hearts, Suit.Diamonds, Suit.Clubs]
    const ranks = ['9', 'J', 'Q', 'K', '10', 'A'] as const
    for (const suit of suits) {
      for (const rank of ranks) {
        const { unmount } = render(<PlayingCard suit={suit} rank={rank} />)
        unmount()
      }
    }
  })
})

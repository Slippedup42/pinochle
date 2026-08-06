import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Suit } from '../engine/card'
import { PlayingCard } from './PlayingCard'

// #170: raised from the 5 s default — these assertions are trivial, but this is
// the file's first `render()`, so it absorbs jsdom/React/RTL first-render
// warmup inside its own wall-clock budget, which balloons under parallel load.
// See TrickPlayFlow.test.tsx.
describe('PlayingCard', { timeout: 20_000 }, () => {
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

  // #94: width used to be passed via className, where Tailwind resolved the
  // conflict with the base width by stylesheet order — so `w-6` lost and meld
  // cards silently rendered full size. Width now comes from `size` alone, so
  // exactly one width utility is ever emitted.
  //
  // `lg` is back at 80 after #161 took it to 64: that reduction existed to fit
  // twelve cards in one row, and #187's two rows only have to fit six. They are
  // pinned here rather than left to inspection because the fan overlaps in
  // Seat.tsx are tuned against these exact widths — changing one without the
  // other either overflows the viewport or buries the index.
  //
  // Matched against the root only. The face now has inner elements that carry
  // their own width (the edge stripe), and #94's rule is about the *card's*
  // width having no competitor, not about the string `w-` appearing once.
  it('emits exactly one width utility, chosen by size', () => {
    const widthsFor = (el: Element) => (el.className.match(/(^|\s)w-\S+/g) ?? []).map((s) => s.trim())

    const { container: sm } = render(<PlayingCard suit={Suit.Spades} rank="A" size="sm" />)
    const { container: md } = render(<PlayingCard suit={Suit.Spades} rank="A" size="md" />)
    const { container: lg } = render(<PlayingCard suit={Suit.Spades} rank="A" />)

    expect(widthsFor(sm.firstElementChild!)).toEqual(['w-10.5'])
    expect(widthsFor(md.firstElementChild!)).toEqual(['w-12'])
    expect(widthsFor(lg.firstElementChild!)).toEqual(['w-20'])
  })

  // The fan in Seat.tsx covers all but a 0.6875w strip of every card except the
  // last, so a face whose index outgrows that strip is a face you cannot read in
  // a hand — which is the whole complaint this design answers. Guarding the
  // ratio rather than the pixel value keeps it true if the widths move again.
  it('keeps the index inside the strip the fan leaves visible', () => {
    const px = (cls: string, re: RegExp) => Number(cls.match(re)![1])
    // sm is 42 since #202 (`w-10.5` — Tailwind v4's spacing scale takes halves).
    const WIDTH_PX = { sm: 42, md: 48, lg: 80 } as const

    for (const size of ['sm', 'md', 'lg'] as const) {
      const { container } = render(<PlayingCard suit={Suit.Spades} rank="A" size={size} />)
      const index = container.querySelector('.font-extrabold')!
      const suitSpan = index.lastElementChild!
      const suitPx = px(suitSpan.className, /text-\[(\d+)px\]/)
      expect(suitPx / WIDTH_PX[size]).toBeLessThan(0.6875)
    }
  })

  // A card is a width plus a ratio — nothing sets a height — so `aspect-5/7`
  // is what makes it card-shaped at all. #161 changed every width; this is the
  // guard that a future size pass doesn't quietly drop the ratio with them.
  it('keeps the 5/7 aspect ratio at every size', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { container } = render(<PlayingCard suit={Suit.Spades} rank="A" size={size} />)
      expect(container.firstElementChild!.className).toContain('aspect-5/7')
    }
    const { container: back } = render(<PlayingCard suit={Suit.Spades} rank="A" faceDown />)
    expect(back.firstElementChild!.className).toContain('aspect-5/7')
  })

  it('keeps a caller className from introducing a competing width', () => {
    const { container } = render(<PlayingCard suit={Suit.Spades} rank="A" size="sm" className="-ml-2" />)
    const cls = container.firstElementChild!.className
    expect(cls).toContain('w-10.5')
    expect(cls).toContain('-ml-2')
    expect(cls.match(/(^|\s)w-\S+/g)!.map((s) => s.trim())).toEqual(['w-10.5'])
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

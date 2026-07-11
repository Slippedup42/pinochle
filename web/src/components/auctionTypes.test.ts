import { describe, expect, it } from 'vitest'
import { Suit } from '../engine/card'
import { formatAuctionLogEntry, partnerOf } from './auctionTypes'

describe('formatAuctionLogEntry', () => {
  it('formats a bid entry', () => {
    expect(formatAuctionLogEntry({ kind: 'bid', player: 1, name: 'West', amount: 320 })).toBe('West bid 320')
  })

  it('formats a pass entry', () => {
    expect(formatAuctionLogEntry({ kind: 'pass-bid', player: 2, name: 'Partner' })).toBe('Partner passed')
  })

  it('formats a forced-bid entry', () => {
    expect(
      formatAuctionLogEntry({ kind: 'forced-bid', player: 3, name: 'East', amount: 250 }),
    ).toBe('East is stuck with the forced bid of 250 (everyone passed)')
  })

  it('formats a trump entry with the full suit name', () => {
    expect(formatAuctionLogEntry({ kind: 'trump', player: 0, name: 'You', suit: Suit.Hearts })).toBe(
      'You named Hearts trump',
    )
  })

  it('formats a card-pass entry without naming the cards', () => {
    const text = formatAuctionLogEntry({
      kind: 'card-pass',
      fromPlayer: 2,
      fromName: 'Partner',
      toPlayer: 0,
      toName: 'You',
      count: 3,
    })
    expect(text).toBe('Partner passed 3 cards to You')
  })

  it('singularizes a 1-card pass', () => {
    const text = formatAuctionLogEntry({
      kind: 'card-pass',
      fromPlayer: 2,
      fromName: 'Partner',
      toPlayer: 0,
      toName: 'You',
      count: 1,
    })
    expect(text).toBe('Partner passed 1 card to You')
  })
})

describe('partnerOf', () => {
  it('pairs seats two apart, matching round.ts teamOf', () => {
    expect(partnerOf(0)).toBe(2)
    expect(partnerOf(1)).toBe(3)
    expect(partnerOf(2)).toBe(0)
    expect(partnerOf(3)).toBe(1)
  })
})

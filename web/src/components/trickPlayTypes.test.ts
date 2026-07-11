import { describe, expect, it } from 'vitest'
import { Card, Suit } from '../engine/card'
import { formatTrickPlayLogEntry } from './trickPlayTypes'

describe('formatTrickPlayLogEntry', () => {
  it('formats a lead card-play entry', () => {
    const text = formatTrickPlayLogEntry({
      kind: 'card-play',
      player: 0,
      name: 'You',
      card: new Card(Suit.Hearts, 'A', 1),
      isLead: true,
    })
    expect(text).toBe('You led the A of Hearts')
  })

  it('formats a follow card-play entry', () => {
    const text = formatTrickPlayLogEntry({
      kind: 'card-play',
      player: 1,
      name: 'West',
      card: new Card(Suit.Spades, '9', 1),
      isLead: false,
    })
    expect(text).toBe('West played the 9 of Spades')
  })

  it('formats a trick-won entry', () => {
    const text = formatTrickPlayLogEntry({ kind: 'trick-won', player: 2, name: 'Partner', points: 20, trickNumber: 3 })
    expect(text).toBe('Partner won the trick (20 points)')
  })

  it('singularizes a 1-point trick', () => {
    // Not a real scoring outcome (only 0/10-point cards exist) but the
    // singular/plural branch should still be correct if it ever happens.
    const text = formatTrickPlayLogEntry({ kind: 'trick-won', player: 3, name: 'East', points: 1, trickNumber: 11 })
    expect(text).toBe('East won the trick (1 point)')
  })
})

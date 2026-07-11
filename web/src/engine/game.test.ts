import { describe, expect, it } from 'vitest'
import { checkGameOutcome } from './game'

describe('checkGameOutcome', () => {
  it('returns null when neither team has crossed a threshold', () => {
    expect(checkGameOutcome({ 0: 400, 1: -200 }, 0)).toBeNull()
  })

  it('a team at or below -1000 loses immediately; the other team wins regardless of their own score', () => {
    expect(checkGameOutcome({ 0: -1000, 1: 50 }, 1)).toBe(1)
    expect(checkGameOutcome({ 0: -1200, 1: -900 }, 0)).toBe(1)
  })

  it('a single team crossing +1000 wins, even if they are not the bidding team', () => {
    expect(checkGameOutcome({ 0: 1050, 1: 600 }, 1)).toBe(0)
  })

  it('the bidding team wins the tie-break if both teams cross +1000 in the same round', () => {
    expect(checkGameOutcome({ 0: 1010, 1: 1200 }, 1)).toBe(1)
    expect(checkGameOutcome({ 0: 1010, 1: 1200 }, 0)).toBe(0)
  })

  it('the -1000 bust check takes priority over the +1000 win check', () => {
    // Contrived, but confirms bust is evaluated first per the Python reference.
    expect(checkGameOutcome({ 0: -1000, 1: 1200 }, 0)).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import { sampleTeamNames, TEAM_NAME_POOL } from './teamNames'

describe('TEAM_NAME_POOL', () => {
  it('has exactly 50 entries', () => {
    expect(TEAM_NAME_POOL.length).toBe(50)
  })

  it('has no duplicate entries', () => {
    expect(new Set(TEAM_NAME_POOL).size).toBe(50)
  })
})

describe('sampleTeamNames', () => {
  it('draws the requested count of unique names, all from the pool', () => {
    const names = sampleTeamNames(2)
    expect(names.length).toBe(2)
    expect(new Set(names).size).toBe(2)
    for (const name of names) expect(TEAM_NAME_POOL).toContain(name)
  })

  it('caps at the pool size when count exceeds it', () => {
    const names = sampleTeamNames(TEAM_NAME_POOL.length + 10)
    expect(names.length).toBe(TEAM_NAME_POOL.length)
    expect(new Set(names).size).toBe(TEAM_NAME_POOL.length)
  })

  it('draws different results across calls (probabilistically)', () => {
    const draws = Array.from({ length: 20 }, () => sampleTeamNames(2).join(','))
    expect(new Set(draws).size).toBeGreaterThan(1)
  })
})

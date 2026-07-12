import { describe, expect, it } from 'vitest'
import { NAME_POOL, sampleNames } from './names'

describe('NAME_POOL', () => {
  it('has exactly 200 entries', () => {
    expect(NAME_POOL.length).toBe(200)
  })

  it('has no duplicate entries', () => {
    expect(new Set(NAME_POOL).size).toBe(200)
  })
})

describe('sampleNames', () => {
  it('draws the requested count of unique names, all from the pool', () => {
    const names = sampleNames(3)
    expect(names.length).toBe(3)
    expect(new Set(names).size).toBe(3)
    for (const name of names) expect(NAME_POOL).toContain(name)
  })

  it('caps at the pool size when count exceeds it', () => {
    const names = sampleNames(NAME_POOL.length + 50)
    expect(names.length).toBe(NAME_POOL.length)
    expect(new Set(names).size).toBe(NAME_POOL.length)
  })

  it('draws different results across calls (probabilistically)', () => {
    // Not strictly guaranteed, but astronomically likely across 20 draws of
    // 3-of-200 — a flake here would indicate a real determinism bug.
    const draws = Array.from({ length: 20 }, () => sampleNames(3).join(','))
    expect(new Set(draws).size).toBeGreaterThan(1)
  })
})

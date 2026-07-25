import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_OPTIONS, loadOptions, saveOptions } from './options'

afterEach(() => {
  window.localStorage.clear()
})

describe('options persistence', () => {
  it('falls back to DEFAULT_OPTIONS when nothing has been saved yet', () => {
    expect(loadOptions()).toEqual(DEFAULT_OPTIONS)
  })

  it('round-trips a saved options value', () => {
    saveOptions({ hideOpponentCards: true, showBaseBidHint: false, opponentSkill: 'easy', teammateSkill: 'expert', showMeldHint: false, hideTrickLog: true })
    expect(loadOptions()).toEqual({ hideOpponentCards: true, showBaseBidHint: false, opponentSkill: 'easy', teammateSkill: 'expert', showMeldHint: false, hideTrickLog: true })
  })

  it('falls back to DEFAULT_OPTIONS on corrupt JSON', () => {
    window.localStorage.setItem('pinochle:options:v1', '{not json')
    expect(loadOptions()).toEqual(DEFAULT_OPTIONS)
  })

  it('fills in missing/malformed fields from DEFAULT_OPTIONS rather than failing outright', () => {
    window.localStorage.setItem('pinochle:options:v1', JSON.stringify({ hideOpponentCards: true }))
    const loaded = loadOptions()
    expect(loaded.hideOpponentCards).toBe(true)
    expect(loaded.showBaseBidHint).toBe(true)
    expect(loaded.opponentSkill).toBe('hard')
    expect(loaded.teammateSkill).toBe('hard')
    expect(loaded.showMeldHint).toBe(false)

    window.localStorage.setItem('pinochle:options:v1', JSON.stringify({ opponentSkill: 42 }))
    const loaded2 = loadOptions()
    expect(loaded2.opponentSkill).toBe('hard')

    window.localStorage.setItem('pinochle:options:v1', JSON.stringify({ showBaseBidHint: 'nope' }))
    expect(loadOptions()).toEqual(DEFAULT_OPTIONS)
  })
})

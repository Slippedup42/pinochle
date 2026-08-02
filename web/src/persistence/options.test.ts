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
    saveOptions({ showBaseBidHint: false, opponentSkill: 'easy', teammateSkill: 'expert', hideTrickLog: true })
    expect(loadOptions()).toEqual({ showBaseBidHint: false, opponentSkill: 'easy', teammateSkill: 'expert', hideTrickLog: true })
  })

  it('falls back to DEFAULT_OPTIONS on corrupt JSON', () => {
    window.localStorage.setItem('pinochle:options:v1', '{not json')
    expect(loadOptions()).toEqual(DEFAULT_OPTIONS)
  })

  it('fills in missing/malformed fields from DEFAULT_OPTIONS rather than failing outright', () => {
    window.localStorage.setItem('pinochle:options:v1', JSON.stringify({ hideTrickLog: false }))
    const loaded = loadOptions()
    expect(loaded.hideTrickLog).toBe(false)
    expect(loaded.showBaseBidHint).toBe(true)
    expect(loaded.opponentSkill).toBe('hard')
    expect(loaded.teammateSkill).toBe('hard')

    window.localStorage.setItem('pinochle:options:v1', JSON.stringify({ opponentSkill: 42 }))
    const loaded2 = loadOptions()
    expect(loaded2.opponentSkill).toBe('hard')

    window.localStorage.setItem('pinochle:options:v1', JSON.stringify({ showBaseBidHint: 'nope' }))
    expect(loadOptions()).toEqual(DEFAULT_OPTIONS)
  })

  // #142 removed `hideOpponentCards` and #148 removed `showMeldHint`, but the
  // storage key is deliberately NOT bumped: a new key would reset everyone's
  // surviving preferences (the skill levels especially). Leftover keys from
  // both removals must simply be ignored, including in the same payload — a
  // save written before either removal carries both.
  it('ignores leftover keys from removed options without disturbing the other saved preferences', () => {
    window.localStorage.setItem(
      'pinochle:options:v1',
      JSON.stringify({
        hideOpponentCards: true,
        showMeldHint: true,
        opponentSkill: 'expert',
        teammateSkill: 'easy',
        showBaseBidHint: false,
      }),
    )
    const loaded = loadOptions()
    expect(loaded).toEqual({
      ...DEFAULT_OPTIONS,
      opponentSkill: 'expert',
      teammateSkill: 'easy',
      showBaseBidHint: false,
    })
    expect('hideOpponentCards' in loaded).toBe(false)
    expect('showMeldHint' in loaded).toBe(false)
  })
})

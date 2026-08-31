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
    saveOptions({ showBaseBidHint: false, hideTrickLog: true })
    expect(loadOptions()).toEqual({ showBaseBidHint: false, hideTrickLog: true })
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

    window.localStorage.setItem('pinochle:options:v1', JSON.stringify({ showBaseBidHint: 'nope' }))
    expect(loadOptions()).toEqual(DEFAULT_OPTIONS)
  })

  // #142 removed `hideOpponentCards`, #148 removed `showMeldHint`, and #222
  // removed `opponentSkill`/`teammateSkill` with the difficulty setting. The
  // storage key is deliberately NOT bumped for any of them: a new key would
  // reset everyone's surviving preferences to buy nothing. Leftover keys from
  // every removal must simply be ignored, including in the same payload.
  it('ignores leftover keys from removed options without disturbing the other saved preferences', () => {
    window.localStorage.setItem(
      'pinochle:options:v1',
      JSON.stringify({
        hideOpponentCards: true,
        showMeldHint: true,
        opponentSkill: 'expert',
        teammateSkill: 'proficient',
        showBaseBidHint: false,
      }),
    )
    const loaded = loadOptions()
    expect(loaded).toEqual({ ...DEFAULT_OPTIONS, showBaseBidHint: false })
    expect('hideOpponentCards' in loaded).toBe(false)
    expect('showMeldHint' in loaded).toBe(false)
  })

  // The specific blob a returning player has (#222). Every level name the panel
  // could ever have written — including `easy` and `medium`, which #194 had
  // already retired and mapped to a floor — must load to the same options and
  // must not leak a skill field back into the game.
  it('loads any pre-#222 saved difficulty without carrying it forward', () => {
    for (const skill of ['easy', 'medium', 'hard', 'proficient', 'expert']) {
      window.localStorage.setItem(
        'pinochle:options:v1',
        JSON.stringify({ showBaseBidHint: true, opponentSkill: skill, teammateSkill: skill, hideTrickLog: false }),
      )
      const loaded = loadOptions()
      expect(loaded).toEqual({ showBaseBidHint: true, hideTrickLog: false })
      expect('opponentSkill' in loaded).toBe(false)
      expect('teammateSkill' in loaded).toBe(false)
    }
  })
})

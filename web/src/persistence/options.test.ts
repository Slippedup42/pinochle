import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_OPTIONS, SELECTABLE_SKILLS, loadOptions, saveOptions } from './options'

afterEach(() => {
  window.localStorage.clear()
})

describe('options persistence', () => {
  it('falls back to DEFAULT_OPTIONS when nothing has been saved yet', () => {
    expect(loadOptions()).toEqual(DEFAULT_OPTIONS)
  })

  it('round-trips a saved options value', () => {
    saveOptions({ showBaseBidHint: false, opponentSkill: 'hard', teammateSkill: 'expert', hideTrickLog: true })
    expect(loadOptions()).toEqual({ showBaseBidHint: false, opponentSkill: 'hard', teammateSkill: 'expert', hideTrickLog: true })
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
    expect(loaded.opponentSkill).toBe(DEFAULT_OPTIONS.opponentSkill)
    expect(loaded.teammateSkill).toBe(DEFAULT_OPTIONS.teammateSkill)

    window.localStorage.setItem('pinochle:options:v1', JSON.stringify({ opponentSkill: 42 }))
    const loaded2 = loadOptions()
    expect(loaded2.opponentSkill).toBe(DEFAULT_OPTIONS.opponentSkill)

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
        teammateSkill: 'proficient',
        showBaseBidHint: false,
      }),
    )
    const loaded = loadOptions()
    expect(loaded).toEqual({
      ...DEFAULT_OPTIONS,
      opponentSkill: 'expert',
      teammateSkill: 'proficient',
      showBaseBidHint: false,
    })
    expect('hideOpponentCards' in loaded).toBe(false)
    expect('showMeldHint' in loaded).toBe(false)
  })

  // #194 retired engine levels 1-2 from the panel. A save written before that
  // still names one, and the player who wrote it chose "as weak as possible" —
  // so it lands on the weakest tier still offered, not on the (stronger)
  // default, which would be a bigger change than the setting going away.
  it('redirects a saved skill level that is no longer selectable to the new floor', () => {
    window.localStorage.setItem(
      'pinochle:options:v1',
      JSON.stringify({ opponentSkill: 'easy', teammateSkill: 'medium' }),
    )
    const loaded = loadOptions()
    expect(loaded.opponentSkill).toBe('hard')
    expect(loaded.teammateSkill).toBe('hard')
    expect(loaded.opponentSkill).not.toBe(DEFAULT_OPTIONS.opponentSkill)
  })

  // The three offered tiers keep the identifiers Python and every measurement in
  // skills.ts use, which is the whole reason the storage key did not need
  // bumping: a stored 'hard' means the same AI it always did.
  it('keeps every selectable level loadable unchanged', () => {
    for (const skill of SELECTABLE_SKILLS) {
      window.localStorage.setItem('pinochle:options:v1', JSON.stringify({ opponentSkill: skill }))
      expect(loadOptions().opponentSkill).toBe(skill)
    }
  })
})

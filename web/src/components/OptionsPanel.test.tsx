import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_OPTIONS } from '../persistence/options'
import { OptionsPanel } from './OptionsPanel'

afterEach(cleanup)

describe('OptionsPanel', () => {
  it('reflects the current options in the two checkboxes', () => {
    render(
      <OptionsPanel
        options={{ hideOpponentCards: true, showBaseBidHint: false, opponentSkill: 'proficient', teammateSkill: 'hard', showMeldHint: false, hideTrickLog: true }}
        onChange={() => {}}
        onClose={() => {}}
      />,
    )
    expect((screen.getByLabelText('Hide opponent cards') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Show base-bid hint') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText('Opponents') as HTMLSelectElement).value).toBe('proficient')
    expect((screen.getByLabelText('Teammate') as HTMLSelectElement).value).toBe('hard')
  })

  it('calls onChange with the hideOpponentCards toggle flipped, leaving the other field alone', () => {
    const onChange = vi.fn()
    render(<OptionsPanel options={DEFAULT_OPTIONS} onChange={onChange} onClose={() => {}} />)
    fireEvent.click(screen.getByLabelText('Hide opponent cards'))
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_OPTIONS, hideOpponentCards: true, showBaseBidHint: true })
  })

  it('calls onChange with the showBaseBidHint toggle flipped', () => {
    const onChange = vi.fn()
    render(<OptionsPanel options={DEFAULT_OPTIONS} onChange={onChange} onClose={() => {}} />)
    fireEvent.click(screen.getByLabelText('Show base-bid hint'))
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_OPTIONS, hideOpponentCards: false, showBaseBidHint: false })
  })

  it('calls onClose from the Done button', () => {
    const onClose = vi.fn()
    render(<OptionsPanel options={DEFAULT_OPTIONS} onChange={() => {}} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('has skill-level controls for Opponent and Teammate (#79)', () => {
    render(<OptionsPanel options={DEFAULT_OPTIONS} onChange={() => {}} onClose={() => {}} />)
    expect(screen.getByLabelText('Opponents')).toBeTruthy()
    expect(screen.getByLabelText('Teammate')).toBeTruthy()
  })


  it('has no bid-window controls yet (explicitly out of scope for #54)', () => {
    render(<OptionsPanel options={DEFAULT_OPTIONS} onChange={() => {}} onClose={() => {}} />)
    expect(screen.queryByText(/bid window/i)).toBeNull()
  })
})

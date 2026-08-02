import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_OPTIONS } from '../persistence/options'
import { OptionsPanel } from './OptionsPanel'

afterEach(cleanup)

describe('OptionsPanel', () => {
  it('reflects the current options in the checkboxes and selects', () => {
    render(
      <OptionsPanel
        options={{ showBaseBidHint: false, opponentSkill: 'proficient', teammateSkill: 'hard', hideTrickLog: false }}
        onChange={() => {}}
        onClose={() => {}}
      />,
    )
    expect((screen.getByLabelText('Show base-bid hint') as HTMLInputElement).checked).toBe(false)
    // The trick-log checkbox is phrased positively, so it reads the inverse of the field.
    expect((screen.getByLabelText('Show trick-play log') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Opponents') as HTMLSelectElement).value).toBe('proficient')
    expect((screen.getByLabelText('Teammate') as HTMLSelectElement).value).toBe('hard')
  })

  // #142 removed the "Hide opponent cards" toggle — opponents' fans are now
  // hidden unconditionally, so the panel must not offer a way back.
  it('has no "Hide opponent cards" toggle', () => {
    render(<OptionsPanel options={DEFAULT_OPTIONS} onChange={() => {}} onClose={() => {}} />)
    expect(screen.queryByLabelText('Hide opponent cards')).toBeNull()
    expect(screen.queryByText(/hide opponent/i)).toBeNull()
  })

  // #148 removed the "Show meld breakdown" toggle. It gated nothing: MeldFlow
  // renders the per-meld breakdown unconditionally (see MeldFlow.test.tsx), so
  // honouring the off-by-default option would have *hidden* what players
  // already see. The panel must not offer the dead control again.
  it('has no "Show meld breakdown" toggle', () => {
    render(<OptionsPanel options={DEFAULT_OPTIONS} onChange={() => {}} onClose={() => {}} />)
    expect(screen.queryByLabelText('Show meld breakdown')).toBeNull()
    expect(screen.queryByText(/meld/i)).toBeNull()
  })

  it('calls onChange with the trick-log toggle flipped, leaving the other fields alone', () => {
    const onChange = vi.fn()
    render(<OptionsPanel options={DEFAULT_OPTIONS} onChange={onChange} onClose={() => {}} />)
    fireEvent.click(screen.getByLabelText('Show trick-play log'))
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_OPTIONS, hideTrickLog: false, showBaseBidHint: true })
  })

  it('calls onChange with the showBaseBidHint toggle flipped', () => {
    const onChange = vi.fn()
    render(<OptionsPanel options={DEFAULT_OPTIONS} onChange={onChange} onClose={() => {}} />)
    fireEvent.click(screen.getByLabelText('Show base-bid hint'))
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_OPTIONS, showBaseBidHint: false })
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

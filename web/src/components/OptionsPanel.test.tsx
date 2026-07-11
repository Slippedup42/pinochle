import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_OPTIONS } from '../persistence/options'
import { OptionsPanel } from './OptionsPanel'

afterEach(cleanup)

describe('OptionsPanel', () => {
  it('reflects the current options in the two checkboxes', () => {
    render(
      <OptionsPanel
        options={{ hideOpponentCards: true, showBaseBidHint: false }}
        onChange={() => {}}
        onClose={() => {}}
      />,
    )
    expect((screen.getByLabelText('Hide opponent cards') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Show base-bid hint') as HTMLInputElement).checked).toBe(false)
  })

  it('calls onChange with the hideOpponentCards toggle flipped, leaving the other field alone', () => {
    const onChange = vi.fn()
    render(<OptionsPanel options={DEFAULT_OPTIONS} onChange={onChange} onClose={() => {}} />)
    fireEvent.click(screen.getByLabelText('Hide opponent cards'))
    expect(onChange).toHaveBeenCalledWith({ hideOpponentCards: true, showBaseBidHint: true })
  })

  it('calls onChange with the showBaseBidHint toggle flipped', () => {
    const onChange = vi.fn()
    render(<OptionsPanel options={DEFAULT_OPTIONS} onChange={onChange} onClose={() => {}} />)
    fireEvent.click(screen.getByLabelText('Show base-bid hint'))
    expect(onChange).toHaveBeenCalledWith({ hideOpponentCards: false, showBaseBidHint: false })
  })

  it('calls onClose from the Done button', () => {
    const onClose = vi.fn()
    render(<OptionsPanel options={DEFAULT_OPTIONS} onChange={() => {}} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('has no AI-difficulty or bid-window controls yet (explicitly out of scope for #54)', () => {
    render(<OptionsPanel options={DEFAULT_OPTIONS} onChange={() => {}} onClose={() => {}} />)
    expect(screen.queryByText(/difficulty/i)).toBeNull()
    expect(screen.queryByText(/bid window/i)).toBeNull()
  })
})

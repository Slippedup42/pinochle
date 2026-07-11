import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MainMenu } from './MainMenu'

afterEach(cleanup)

describe('MainMenu', () => {
  it('disables Continue when there is no save', () => {
    render(<MainMenu hasSave={false} onNewGame={() => {}} onContinue={() => {}} onOptions={() => {}} />)
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true)
  })

  it('enables Continue when a save exists, and calls onContinue when clicked', () => {
    const onContinue = vi.fn()
    render(<MainMenu hasSave onNewGame={() => {}} onContinue={onContinue} onOptions={() => {}} />)
    const button = screen.getByRole('button', { name: 'Continue' })
    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button)
    expect(onContinue).toHaveBeenCalledOnce()
  })

  it('calls onNewGame and onOptions from their respective buttons', () => {
    const onNewGame = vi.fn()
    const onOptions = vi.fn()
    render(<MainMenu hasSave={false} onNewGame={onNewGame} onContinue={() => {}} onOptions={onOptions} />)
    fireEvent.click(screen.getByRole('button', { name: 'New Game' }))
    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    expect(onNewGame).toHaveBeenCalledOnce()
    expect(onOptions).toHaveBeenCalledOnce()
  })

  it('has no Exit item', () => {
    render(<MainMenu hasSave onNewGame={() => {}} onContinue={() => {}} onOptions={() => {}} />)
    expect(screen.queryByText(/exit/i)).toBeNull()
  })

  it('renders no "back to game" control when onClose is omitted (the full-screen start menu)', () => {
    render(<MainMenu hasSave={false} onNewGame={() => {}} onContinue={() => {}} onOptions={() => {}} />)
    expect(screen.queryByText('Back to game')).toBeNull()
  })

  it('renders a "back to game" control when onClose is provided (the mid-game overlay)', () => {
    const onClose = vi.fn()
    render(<MainMenu hasSave={false} onNewGame={() => {}} onContinue={() => {}} onOptions={() => {}} onClose={onClose} />)
    fireEvent.click(screen.getByText('Back to game'))
    expect(onClose).toHaveBeenCalledOnce()
  })
})

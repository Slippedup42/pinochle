import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BiddingControls } from './BiddingControls'

afterEach(cleanup)

describe('BiddingControls', () => {
  it('shows the minimum bid and the hand-strength hint', () => {
    render(<BiddingControls minBid={300} currentBid={0} suggestedCeiling={350} onBid={() => {}} onPass={() => {}} />)
    expect(screen.getByText(/Minimum: 300/)).not.toBeNull()
    expect(screen.getByText(/up to 350/)).not.toBeNull()
  })

  it('shows the current bid once someone has bid', () => {
    render(<BiddingControls minBid={320} currentBid={310} suggestedCeiling={350} onBid={() => {}} onPass={() => {}} />)
    expect(screen.getByText(/Current bid: 310/)).not.toBeNull()
  })

  it('defaults the bid amount input to the minimum bid', () => {
    render(<BiddingControls minBid={300} currentBid={0} suggestedCeiling={350} onBid={() => {}} onPass={() => {}} />)
    const input = screen.getByLabelText('Bid amount') as HTMLInputElement
    expect(input.value).toBe('300')
  })

  it('calls onBid with the entered amount', () => {
    const onBid = vi.fn()
    render(<BiddingControls minBid={300} currentBid={0} suggestedCeiling={350} onBid={onBid} onPass={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Bid' }))
    expect(onBid).toHaveBeenCalledWith(300)
  })

  it('raises the amount in steps of 10 via the increment button', () => {
    const onBid = vi.fn()
    render(<BiddingControls minBid={300} currentBid={0} suggestedCeiling={350} onBid={onBid} onPass={() => {}} />)
    fireEvent.click(screen.getByLabelText('Increase bid by 10'))
    fireEvent.click(screen.getByRole('button', { name: 'Bid' }))
    expect(onBid).toHaveBeenCalledWith(310)
  })

  it('disables the Bid button when the entered amount is below the minimum', () => {
    render(<BiddingControls minBid={300} currentBid={0} suggestedCeiling={350} onBid={() => {}} onPass={() => {}} />)
    const input = screen.getByLabelText('Bid amount') as HTMLInputElement
    fireEvent.change(input, { target: { value: '280' } })
    expect(screen.getByRole('button', { name: 'Bid' }).hasAttribute('disabled')).toBe(true)
  })

  it('calls onPass when the Pass button is clicked', () => {
    const onPass = vi.fn()
    render(<BiddingControls minBid={300} currentBid={0} suggestedCeiling={350} onBid={() => {}} onPass={onPass} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pass' }))
    expect(onPass).toHaveBeenCalledOnce()
  })

  it('hides the base-bid hint when showBaseBidHint is false (Options toggle, #54)', () => {
    render(
      <BiddingControls
        minBid={300}
        currentBid={0}
        suggestedCeiling={350}
        showBaseBidHint={false}
        onBid={() => {}}
        onPass={() => {}}
      />,
    )
    expect(screen.getByText(/Minimum: 300/)).not.toBeNull()
    expect(screen.queryByText(/suggests up to/)).toBeNull()
  })
})

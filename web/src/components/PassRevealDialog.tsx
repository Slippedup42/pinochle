import { type Card, sortHandForDisplay } from '../engine/card'
import { useMemo } from 'react'
import { PlayingCard } from './PlayingCard'

export interface PassRevealDialogProps {
  readonly cards: readonly Card[] | null
  readonly partnerName: string
  readonly onContinue: () => void
}

export function PassRevealDialog({ cards, partnerName, onContinue }: PassRevealDialogProps) {
  const sorted = useMemo(() => (cards ? sortHandForDisplay(cards) : []), [cards])

  return (
    <div className="rounded-lg bg-slate-800 p-6 shadow-xl">
      <h2 className="mb-4 text-center text-lg font-semibold text-white">
        {cards && cards.length > 0 ? `${partnerName} passed you ${cards.length} card${cards.length !== 1 ? 's' : ''}` : 'No cards passed'}
      </h2>
      {cards && cards.length > 0 && (
        <div className="mb-6 flex justify-center gap-0">
          {sorted.map((card, i) => (
            <div key={i} className="-ml-10 first:ml-0">
              <PlayingCard suit={card.suit} rank={card.rank} />
            </div>
          ))}
        </div>
      )}
      <div className="flex justify-center">
        <button
          className="rounded bg-blue-600 px-6 py-2 text-white hover:bg-blue-500"
          onClick={onContinue}
        >
          Continue
        </button>
      </div>
    </div>
  )
}

import type { Card } from '../engine/card'

export interface PassRevealDialogProps {
  readonly cards: readonly Card[] | null
  readonly partnerName: string
  readonly onContinue: () => void
}

/**
 * The step between the pass and the meld. It says how many cards arrived and
 * that they are marked in the hand — the cards themselves are not repeated
 * here. This is docked under the call circle and above the hand (see `Table`'s
 * `dock`), so the hand it points at is on screen, unobscured, while it is read.
 */
export function PassRevealDialog({ cards, partnerName, onContinue }: PassRevealDialogProps) {
  const count = cards?.length ?? 0

  return (
    <div className="w-full max-w-xs rounded-lg bg-slate-800 p-4 text-center shadow-xl">
      <h2 className="text-lg font-semibold text-white">
        {count > 0 ? `${partnerName} passed you ${count} card${count !== 1 ? 's' : ''}` : 'No cards passed'}
      </h2>
      {count > 0 && (
        <p className="mt-1 text-sm text-amber-300">They are marked NEW in your hand below.</p>
      )}
      <button
        className="mt-4 w-full rounded bg-blue-600 px-6 py-2 text-white hover:bg-blue-500"
        onClick={onContinue}
      >
        Continue
      </button>
    </div>
  )
}

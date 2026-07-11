export interface MisdealPromptProps {
  nineCount: number
  onReshuffle: () => void
  onDecline: () => void
}

/**
 * Human confirm dialog for the misdeal/reshuffle house rule
 * (pinochle_rules.md "Misdeal / Reshuffle"): shown when the human holds 5+
 * nines, at what would be their first bid turn — before GameFlow (#47)
 * lets the auction start. AI seats never see this; they always take the
 * reshuffle automatically when eligible (gameFlowReducer.ts) since a hand
 * that heavy in the lowest-value rank is close to strictly bad. Only the
 * human gets a real choice.
 */
export function MisdealPrompt({ nineCount, onReshuffle, onDecline }: MisdealPromptProps) {
  return (
    <div className="w-full max-w-xs rounded-lg bg-white p-4 text-neutral-900 shadow-xl">
      <h3 className="text-sm font-semibold">Misdeal?</h3>
      <p className="mt-1 text-xs text-neutral-600">
        You have {nineCount} nines — house rule lets you request a reshuffle.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onReshuffle}
          className="flex-1 rounded bg-green-800 px-4 py-2 font-semibold text-white hover:bg-green-900"
        >
          Reshuffle
        </button>
        <button
          type="button"
          onClick={onDecline}
          className="flex-1 rounded bg-neutral-200 px-4 py-2 font-semibold text-neutral-900 hover:bg-neutral-300"
        >
          Keep hand
        </button>
      </div>
    </div>
  )
}

// Options panel (#54): exactly two toggles for this issue — hiding
// opponents' face-down card fans (Seat.tsx) and the base-bid hint
// (BiddingControls.tsx). Deliberately not here yet: an AI-difficulty picker
// and a "bid window" hint based on assumed opponent skill, both out of
// scope for #54 since they depend on AI difficulty tiers that don't exist
// in the TS engine yet (bidding.ts only has the one Proficient strategy).
// The layout below leaves room for those as a later addition rather than
// stubbing UI for them now.

import type { GameOptions } from '../persistence/options'

export interface OptionsPanelProps {
  options: GameOptions
  onChange: (options: GameOptions) => void
  onClose: () => void
}

export function OptionsPanel({ options, onChange, onClose }: OptionsPanelProps) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-xs rounded-lg bg-white p-6 text-neutral-900 shadow-xl">
        <h2 className="text-lg font-bold">Options</h2>

        <div className="mt-4 flex flex-col gap-3 text-left text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={options.hideOpponentCards}
              onChange={(e) => onChange({ ...options, hideOpponentCards: e.target.checked })}
            />
            Hide opponent cards
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={options.showBaseBidHint}
              onChange={(e) => onChange({ ...options, showBaseBidHint: e.target.checked })}
            />
            Show base-bid hint
          </label>
        </div>

        {/* Room for an AI-difficulty picker and a bid-window hint once AI
            difficulty tiers exist — see the comment at the top of this
            file. Deliberately left blank, not stubbed. */}

        <button
          type="button"
          onClick={onClose}
          className="mt-6 w-full rounded bg-green-800 px-4 py-2 font-semibold text-white hover:bg-green-900"
        >
          Done
        </button>
      </div>
    </div>
  )
}

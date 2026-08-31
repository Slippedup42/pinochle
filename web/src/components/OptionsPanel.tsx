import type { GameOptions } from '../persistence/options'

export interface OptionsPanelProps {
  options: GameOptions
  onChange: (options: GameOptions) => void
  onClose: () => void
}

/**
 * Two display toggles, and no difficulty control (#222).
 *
 * The panel offered Easy/Medium/Hard for opponents and teammate separately
 * (#79, renamed by #194). Those three rows selected engine levels that were
 * byte-identical apart from how much trump each seat could remember, which
 * epic #215 measured at roughly four points a deal — a setting a player cannot
 * feel is worse than no setting, because it invites them to blame it. So the
 * control is gone rather than defaulted or hidden, and every seat plays
 * `SHIPPED_SKILL` (`engine/skills.ts`).
 *
 * Nothing replaces it here. If a difficulty setting comes back it should be a
 * span someone has measured first, not three names over one configuration.
 */
export function OptionsPanel({ options, onChange, onClose }: OptionsPanelProps) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-xs rounded-lg bg-white p-6 text-neutral-900 shadow-xl">
        <h2 className="text-lg font-bold">Options</h2>

        <div className="mt-4 flex flex-col gap-3 text-left text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={options.showBaseBidHint}
              onChange={(e) => onChange({ ...options, showBaseBidHint: e.target.checked })}
            />
            Show base-bid hint
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={!options.hideTrickLog}
              onChange={(e) => onChange({ ...options, hideTrickLog: !e.target.checked })}
            />
            Show trick-play log
          </label>
        </div>

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

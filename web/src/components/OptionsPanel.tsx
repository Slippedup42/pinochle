import { SELECTABLE_SKILLS, type GameOptions, type SelectableSkill } from '../persistence/options'

export interface OptionsPanelProps {
  options: GameOptions
  onChange: (options: GameOptions) => void
  onClose: () => void
}

/**
 * Plain Easy/Medium/Hard (#194), replacing the five-rung Novice ... Master
 * ladder. Paul's dad tried the old settings and could not tell what they meant,
 * which is fair: "Journeyman" against "Expert" is not a difficulty, it is a
 * guild rank, and two of the five rungs are gone now anyway.
 *
 * The keys are engine tier names and the values are what a player reads. That
 * split is not new — this panel already showed `proficient` as "Expert" and
 * `expert` as "Master". `SELECTABLE_SKILLS` is the single source of truth for
 * which tiers are offered and in what order; see `options.ts` for why the engine
 * still defines five while only three are reachable.
 */
const SKILL_LABELS: Record<SelectableSkill, string> = {
  hard: 'Easy',
  proficient: 'Medium',
  expert: 'Hard',
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

          <hr className="my-1 border-neutral-200" />
          <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Skill Level</h3>

          <label className="flex items-center justify-between gap-2">
            <span>Opponents</span>
            <select
              className="rounded border border-neutral-300 px-2 py-1 text-sm"
              value={options.opponentSkill}
              onChange={(e) => onChange({ ...options, opponentSkill: e.target.value as SelectableSkill })}
            >
              {SELECTABLE_SKILLS.map((s) => (
                <option key={s} value={s}>{SKILL_LABELS[s]}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center justify-between gap-2">
            <span>Teammate</span>
            <select
              className="rounded border border-neutral-300 px-2 py-1 text-sm"
              value={options.teammateSkill}
              onChange={(e) => onChange({ ...options, teammateSkill: e.target.value as SelectableSkill })}
            >
              {SELECTABLE_SKILLS.map((s) => (
                <option key={s} value={s}>{SKILL_LABELS[s]}</option>
              ))}
            </select>
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
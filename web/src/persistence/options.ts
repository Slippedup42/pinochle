// Options toggles (#54), persisted separately from the game-state save
// (gameSave.ts) since they're a standing preference rather than part of
// any one game's progress — New Game/Continue never touch these, only the
// Options panel does.

const OPTIONS_KEY = 'pinochle:options:v1'

/** Every AI tier the *engine* defines — `skills.ts`'s `SKILL_PARAMS`, and
 * `trumpMemory.ts`'s `TRUMP_MEMORY_CAPACITY` (`2 x level`), keyed 1-5 in that
 * order. Not the same set as what a player can choose: see `SELECTABLE_SKILLS`. */
export type SkillLevel = 'easy' | 'medium' | 'hard' | 'proficient' | 'expert'

/**
 * The three tiers the Options panel offers, and the only values `GameOptions`
 * can hold (#194).
 *
 * Paul's ask was "eliminate skill levels 1 and 2, rename 3/4/5 to Easy/Medium/
 * Hard, default to Medium". This is that ask, implemented where it can actually
 * be implemented. **The engine keeps all five levels**, because levels 1-2 are
 * not only player-facing settings:
 *
 *   - `engineParity.fixture.ts` is *generated from Python* and pins seats to
 *     `'easy'`. Deleting the value breaks the parity contract that
 *     `export_parity_scenarios.py` exists to guard — Python is authoritative for
 *     ported constants (CLAUDE.md), so the TS side cannot unilaterally drop one.
 *   - `abRun.ts`'s `SAFE_COUNTER_CONTROL` uses `'easy'` and `'medium'` as the
 *     capacity controls for #158's measurement, on the same reasoning `skills.ts`
 *     gives for keeping the `'simple'` and `'never'` policy arms: an A/B needs
 *     two levels differing in one field, so removing a level removes a ruler.
 *
 * So levels 1-2 stop being *reachable*, which is what a player experiences, and
 * stay *defined*, which is what the harness needs.
 *
 * The display names live in `OptionsPanel`, which has always relabelled these
 * (it showed `proficient` as "Expert" and `expert` as "Master"). Mapping is:
 * `hard` -> Easy, `proficient` -> Medium, `expert` -> Hard. Note that the
 * identifiers deliberately still mean what they meant to Python and to every
 * measurement in `skills.ts` — a stored `'hard'` is the same AI it always was,
 * which is why no storage-key bump is needed here.
 */
export const SELECTABLE_SKILLS = ['hard', 'proficient', 'expert'] as const satisfies readonly SkillLevel[]
export type SelectableSkill = (typeof SELECTABLE_SKILLS)[number]

/** Where a stored level that is no longer selectable lands: the new floor. A
 *  player who had chosen 1 or 2 gets the weakest tier still on offer rather than
 *  being silently jumped to the default, which would be a bigger change than
 *  their setting going away. */
const RETIRED_SKILLS: Readonly<Record<string, SelectableSkill>> = {
  easy: 'hard',
  medium: 'hard',
}

export interface GameOptions {
  /** Show BiddingControls' "Your hand suggests up to N" hint during the
   * human's bidding turn. On by default, matching current behavior. */
  readonly showBaseBidHint: boolean
  /** AI skill level for the two opponents (#79). */
  readonly opponentSkill: SelectableSkill
  /** AI skill level for the human's teammate (#79). */
  readonly teammateSkill: SelectableSkill
  /** Hide the trick-play event log (card plays, trick winners). Default on
   * (#81) so the table is less cluttered; turn off to see every play logged
   * in the right-hand panel. The bid/auction history is always shown. */
  readonly hideTrickLog: boolean
}

/** Default skill is **Medium** (#194), i.e. engine level 4. It was `'hard'`
 *  (level 3) before, so a fresh install now gets a slightly stronger table:
 *  same rules and same card play — every level has shared those since #156 —
 *  with 8 trump remembered instead of 6. */
export const DEFAULT_OPTIONS: GameOptions = {
  showBaseBidHint: true,
  opponentSkill: 'proficient',
  teammateSkill: 'proficient',
  hideTrickLog: true,
}

const SELECTABLE = new Set<string>(SELECTABLE_SKILLS)

/**
 * Resolves a stored skill value: a selectable level is kept as-is, a retired one
 * (1-2) maps to the new floor, and anything else — a corrupt value, a number, a
 * level name that never existed — falls back.
 */
function parseSkill(raw: unknown, fallback: SelectableSkill): SelectableSkill {
  if (typeof raw !== 'string') return fallback
  if (SELECTABLE.has(raw)) return raw as SelectableSkill
  return RETIRED_SKILLS[raw] ?? fallback
}

/** Reads saved options from localStorage, falling back to DEFAULT_OPTIONS
 * (whole-object or per-field) if nothing's saved yet or the saved value is
 * corrupt/unrecognized — never throws. */
export function loadOptions(): GameOptions {
  try {
    const raw = window.localStorage.getItem(OPTIONS_KEY)
    if (!raw) return DEFAULT_OPTIONS
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_OPTIONS
    // Destructures only the fields it knows about, so keys left behind by
    // removed options (`hideOpponentCards`, dropped in #142; `showMeldHint`,
    // dropped in #148) are ignored rather than migrated. That is why
    // OPTIONS_KEY is *not* bumped when an option goes away: a new key would
    // silently reset every player's surviving preferences — the skill levels
    // especially.
    //
    // #194 retired two skill levels without bumping it either, and that is safe
    // for a stronger reason than habit: the level *identifiers* did not change
    // meaning, only which of them the panel offers. A stored `'hard'` is the
    // same tier it was before, so there is no version of this value that needs
    // disambiguating — `parseSkill` only has to redirect the two that are no
    // longer reachable.
    const { showBaseBidHint, opponentSkill, teammateSkill, hideTrickLog } = parsed as Partial<GameOptions>
    return {
      showBaseBidHint: typeof showBaseBidHint === 'boolean' ? showBaseBidHint : DEFAULT_OPTIONS.showBaseBidHint,
      opponentSkill: parseSkill(opponentSkill, DEFAULT_OPTIONS.opponentSkill),
      teammateSkill: parseSkill(teammateSkill, DEFAULT_OPTIONS.teammateSkill),
      hideTrickLog: typeof hideTrickLog === 'boolean' ? hideTrickLog : DEFAULT_OPTIONS.hideTrickLog,
    }
  } catch {
    return DEFAULT_OPTIONS
  }
}

/** Persists options to localStorage. Swallows write failures (quota,
 * private-browsing restrictions) — an unsaved preference toggle is never
 * worth crashing the game over. */
export function saveOptions(options: GameOptions): void {
  try {
    window.localStorage.setItem(OPTIONS_KEY, JSON.stringify(options))
  } catch {
    // see above
  }
}

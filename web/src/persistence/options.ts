// Options toggles (#54), persisted separately from the game-state save
// (gameSave.ts) since they're a standing preference rather than part of
// any one game's progress — New Game/Continue never touch these, only the
// Options panel does.

const OPTIONS_KEY = 'pinochle:options:v1'

/** AI difficulty tiers. `'proficient'` is the current heuristic-based AI.
 * The other levels will map to GeneralStrategy (Monte Carlo) parameters
 * once ported from the Python engine (see issue #79). */
export type SkillLevel = 'easy' | 'medium' | 'hard' | 'proficient' | 'expert'

export interface GameOptions {
  /** Show BiddingControls' "Your hand suggests up to N" hint during the
   * human's bidding turn. On by default, matching current behavior. */
  readonly showBaseBidHint: boolean
  /** AI skill level for the two opponents (#79). */
  readonly opponentSkill: SkillLevel
  /** AI skill level for the human's teammate (#79). */
  readonly teammateSkill: SkillLevel
  /** Show the per-card meld breakdown list in MeldFlow. Off by default
   * (just shows total points) — players who want to verify the AI's meld
   * detection can turn it on. */
  readonly showMeldHint: boolean
  /** Hide the trick-play event log (card plays, trick winners). Default on
   * (#81) so the table is less cluttered; turn off to see every play logged
   * in the right-hand panel. The bid/auction history is always shown. */
  readonly hideTrickLog: boolean
}

export const DEFAULT_OPTIONS: GameOptions = {
  showBaseBidHint: true,
  opponentSkill: 'hard',
  teammateSkill: 'hard',
  showMeldHint: false,
  hideTrickLog: true,
}

/** Reads saved options from localStorage, falling back to DEFAULT_OPTIONS
 * (whole-object or per-field) if nothing's saved yet or the saved value is
 * corrupt/unrecognized — never throws. */
const VALID_SKILLS = new Set<SkillLevel>(['easy', 'medium', 'hard', 'proficient', 'expert'])

function parseSkill(raw: unknown, fallback: SkillLevel): SkillLevel {
  return VALID_SKILLS.has(raw as SkillLevel) ? (raw as SkillLevel) : fallback
}

export function loadOptions(): GameOptions {
  try {
    const raw = window.localStorage.getItem(OPTIONS_KEY)
    if (!raw) return DEFAULT_OPTIONS
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_OPTIONS
    // Destructures only the fields it knows about, so keys left behind by
    // removed options (`hideOpponentCards`, dropped in #142) are ignored
    // rather than migrated. That is why OPTIONS_KEY is *not* bumped when an
    // option goes away: a new key would silently reset every player's
    // surviving preferences — the skill levels especially.
    const { showBaseBidHint, opponentSkill, teammateSkill, showMeldHint, hideTrickLog } = parsed as Partial<GameOptions>
    return {
      showBaseBidHint: typeof showBaseBidHint === 'boolean' ? showBaseBidHint : DEFAULT_OPTIONS.showBaseBidHint,
      opponentSkill: parseSkill(opponentSkill, DEFAULT_OPTIONS.opponentSkill),
      teammateSkill: parseSkill(teammateSkill, DEFAULT_OPTIONS.teammateSkill),
      showMeldHint: typeof showMeldHint === 'boolean' ? showMeldHint : DEFAULT_OPTIONS.showMeldHint,
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

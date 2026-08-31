// Options toggles (#54), persisted separately from the game-state save
// (gameSave.ts) since they're a standing preference rather than part of
// any one game's progress — New Game/Continue never touch these, only the
// Options panel does.

const OPTIONS_KEY = 'pinochle:options:v1'

export interface GameOptions {
  /** Show BiddingControls' "Your hand suggests up to N" hint during the
   * human's bidding turn. On by default, matching current behavior. */
  readonly showBaseBidHint: boolean
  /** Hide the trick-play event log (card plays, trick winners). Default on
   * (#81) so the table is less cluttered; turn off to see every play logged
   * in the right-hand panel. The bid/auction history is always shown. */
  readonly hideTrickLog: boolean
}

export const DEFAULT_OPTIONS: GameOptions = {
  showBaseBidHint: true,
  hideTrickLog: true,
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
    // removed options are ignored rather than migrated — `hideOpponentCards`
    // (dropped in #142), `showMeldHint` (#148), and now `opponentSkill` /
    // `teammateSkill` (#222, the difficulty setting). That is why OPTIONS_KEY
    // is *not* bumped when an option goes away: a new key would silently reset
    // every player's surviving preferences, which is a real cost paid to avoid
    // a field this function never reads.
    //
    // So a returning player who had chosen a difficulty keeps their hint and
    // trick-log toggles, loses the setting, and gets the one shipped AI. The
    // dead keys stay in localStorage until the next `saveOptions` overwrites
    // the blob; nothing reads them in the meantime, and JSON with extra keys
    // is not a broken blob.
    const { showBaseBidHint, hideTrickLog } = parsed as Partial<GameOptions>
    return {
      showBaseBidHint: typeof showBaseBidHint === 'boolean' ? showBaseBidHint : DEFAULT_OPTIONS.showBaseBidHint,
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

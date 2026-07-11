// Options toggles (#54), persisted separately from the game-state save
// (gameSave.ts) since they're a standing preference rather than part of
// any one game's progress — New Game/Continue never touch these, only the
// Options panel does.

const OPTIONS_KEY = 'pinochle:options:v1'

export interface GameOptions {
  /** Hide the West/Partner/East face-down card fans (Seat.tsx) entirely —
   * just player + board, to save screen space. Off (fans shown) by
   * default, matching current behavior before this option existed. */
  readonly hideOpponentCards: boolean
  /** Show BiddingControls' "Your hand suggests up to N" hint during the
   * human's bidding turn. On by default, matching current behavior. */
  readonly showBaseBidHint: boolean
  // Deliberately not here yet (#54 scope): an AI-difficulty picker and a
  // "bid window" hint based on assumed opponent skill. Both depend on AI
  // difficulty tiers that don't exist in the TS engine yet — bidding.ts
  // only has the one Proficient strategy. OptionsPanel.tsx leaves layout
  // room for these; this type just doesn't carry them yet.
}

export const DEFAULT_OPTIONS: GameOptions = {
  hideOpponentCards: false,
  showBaseBidHint: true,
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
    const { hideOpponentCards, showBaseBidHint } = parsed as Partial<GameOptions>
    return {
      hideOpponentCards:
        typeof hideOpponentCards === 'boolean' ? hideOpponentCards : DEFAULT_OPTIONS.hideOpponentCards,
      showBaseBidHint: typeof showBaseBidHint === 'boolean' ? showBaseBidHint : DEFAULT_OPTIONS.showBaseBidHint,
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

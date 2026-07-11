// Main menu (#54): New Game / Continue / Options. Rendered full-screen by
// GameShell.tsx on load (no save, or the player hasn't chosen yet), and
// re-rendered as a mid-game overlay (with onClose set) when the player taps
// Table.tsx's persistent menu button — same three actions either way, so a
// player is never stranded once a round has started. Deliberately has no
// "Exit" item: browsers can't reliably self-close a tab from JS, and the
// primary target (ROADMAP.md) is a home-screen-launched iOS PWA, where
// there's no "close the app" concept at all.

export interface MainMenuProps {
  /** Whether a resumable autosave exists — Continue is disabled without one. */
  hasSave: boolean
  /** Starts a fresh game. GameShell.tsx confirms with the player first if a
   * save would be discarded — this callback fires only once that's settled. */
  onNewGame: () => void
  /** Resumes the saved game (full-screen context) or just dismisses the
   * menu back to the game already in progress (mid-game overlay context) —
   * GameShell.tsx picks the right behavior for each. */
  onContinue: () => void
  onOptions: () => void
  /** Present only for the mid-game overlay — lets the player dismiss the
   * menu without picking an item. Omitted for the full-screen start menu,
   * where there's no game in progress yet to go back to. */
  onClose?: () => void
}

export function MainMenu({ hasSave, onNewGame, onContinue, onOptions, onClose }: MainMenuProps) {
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-xs rounded-lg bg-white p-6 text-center text-neutral-900 shadow-xl">
        <h1 className="text-xl font-bold">Pinochle</h1>

        <div className="mt-6 flex flex-col gap-3">
          <button
            type="button"
            onClick={onNewGame}
            className="w-full rounded bg-green-800 px-4 py-2 font-semibold text-white hover:bg-green-900"
          >
            New Game
          </button>
          <button
            type="button"
            disabled={!hasSave}
            onClick={onContinue}
            className="w-full rounded bg-neutral-200 px-4 py-2 font-semibold text-neutral-900 hover:bg-neutral-300 disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-400"
          >
            Continue
          </button>
          <button
            type="button"
            onClick={onOptions}
            className="w-full rounded bg-neutral-200 px-4 py-2 font-semibold text-neutral-900 hover:bg-neutral-300"
          >
            Options
          </button>
        </div>

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="mt-4 text-sm text-neutral-500 hover:text-neutral-700"
          >
            Back to game
          </button>
        )}
      </div>
    </div>
  )
}

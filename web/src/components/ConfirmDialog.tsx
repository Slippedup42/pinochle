export interface ConfirmDialogProps {
  message: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * In-app confirmation modal, styled to match MainMenu/OptionsPanel rather
 * than a native `window.confirm()` — the native dialog blocks the whole
 * page (and looks like a bare browser alert, not part of the app) rather
 * than rendering as one of this app's own modals.
 */
export function ConfirmDialog({ message, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-xs rounded-lg bg-white p-6 text-center text-neutral-900 shadow-xl">
        <p className="text-sm">{message}</p>
        <div className="mt-6 flex flex-col gap-3">
          <button
            type="button"
            onClick={onConfirm}
            className="w-full rounded bg-green-800 px-4 py-2 font-semibold text-white hover:bg-green-900"
          >
            Start new game
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="w-full rounded bg-neutral-200 px-4 py-2 font-semibold text-neutral-900 hover:bg-neutral-300"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

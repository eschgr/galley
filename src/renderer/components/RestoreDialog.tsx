/**
 * Crash-recovery restore prompt. Shown once on mount
 * after a DIRTY shutdown, when the claimed project has a restorable session. The
 * title marks it as an error so it reads as a recovery, not normal operation; the
 * short question is the body. Two choices only — restore from the last save, or
 * start fresh.
 *
 * An in-app modal (mirroring ConflictDialog / CloseTabDialog), NOT a native OS
 * message box: a native box does not display its `title` on macOS, which would
 * drop the error signal on that platform.
 */
interface RestoreDialogProps {
  /** Reopen the persisted session (loaded from the last save on disk). */
  onRestore: () => void;
  /** Start fresh — keep just the CLI files / welcome screen. */
  onDismiss: () => void;
}

export function RestoreDialog({ onRestore, onDismiss }: RestoreDialogProps) {
  return (
    <div className="modal-overlay">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="restore-title">
        <h2 id="restore-title" className="modal-title">Galley recovered from a crash</h2>
        <p className="modal-body">Restore session from last save?</p>
        <div className="modal-actions modal-actions-row">
          <span className="modal-spacer" />
          <button type="button" onClick={onDismiss}>No</button>
          <button type="button" className="modal-primary" onClick={onRestore}>Yes</button>
        </div>
      </div>
    </div>
  );
}

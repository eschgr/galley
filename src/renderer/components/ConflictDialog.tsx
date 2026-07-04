/**
 * Out-of-sync notice (write-path & read-path conflict guards; v1
 * labeled-choice — no diff view).
 * Pops once, loudly, the first time the open file diverges on disk while the
 * buffer has unsaved edits. There are only two real choices — take theirs or
 * keep yours. Keeping yours quiets later divergence to the passive status-bar
 * flag instead of re-popping this modal.
 */
interface ConflictDialogProps {
  fileName: string;
  /** Overwrite the on-disk change with the in-editor version. */
  onKeepMine: () => void;
  /** Discard the in-editor edits and load the on-disk version. */
  onLoadFromDisk: () => void;
}

export function ConflictDialog({ fileName, onKeepMine, onLoadFromDisk }: ConflictDialogProps) {
  return (
    <div className="modal-overlay">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
        <h2 id="conflict-title" className="modal-title">Files are out of sync</h2>
        <p className="modal-body">
          <strong>{fileName}</strong> changed on disk while you had unsaved edits — something else
          is writing it. Load the disk version, or keep yours?
        </p>
        <div className="modal-actions">
          <button type="button" onClick={onLoadFromDisk}>
            Load from disk
            <span className="modal-hint">discard my edits</span>
          </button>
          <button type="button" className="modal-primary" onClick={onKeepMine}>
            Keep mine
            <span className="modal-hint">overwrite the disk version</span>
          </button>
        </div>
      </div>
    </div>
  );
}

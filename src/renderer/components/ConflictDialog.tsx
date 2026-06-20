/**
 * Out-of-sync notice (PRD R34/R35, v1 labeled-choice — no diff view, see §3).
 * Pops once, loudly, the first time the open file diverges on disk while the
 * buffer has unsaved edits, so the user can respond quickly. Dismissing it
 * ("Keep editing") collapses it to a passive status-bar flag.
 */
interface ConflictDialogProps {
  fileName: string;
  /** Overwrite the on-disk change with the in-editor version. */
  onKeepMine: () => void;
  /** Discard the in-editor edits and load the on-disk version. */
  onLoadFromDisk: () => void;
  /** Dismiss to the passive flag and keep editing (decide later). */
  onCancel: () => void;
}

export function ConflictDialog({ fileName, onKeepMine, onLoadFromDisk, onCancel }: ConflictDialogProps) {
  return (
    <div className="modal-overlay">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
        <h2 id="conflict-title" className="modal-title">Files are out of sync</h2>
        <p className="modal-body">
          <strong>{fileName}</strong> changed on disk while you had unsaved edits — something else
          is writing it. Reload the disk version, keep yours, or decide later?
        </p>
        <div className="modal-actions">
          <button type="button" onClick={onLoadFromDisk}>
            Load from disk
            <span className="modal-hint">discard my edits</span>
          </button>
          <button type="button" onClick={onKeepMine}>
            Keep my changes
            <span className="modal-hint">overwrite the disk version</span>
          </button>
          <button type="button" className="modal-primary" onClick={onCancel}>
            Keep editing
            <span className="modal-hint">decide later — keep the warning</span>
          </button>
        </div>
      </div>
    </div>
  );
}

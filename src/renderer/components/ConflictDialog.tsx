/**
 * Conflict prompt (PRD R35, v1 labeled-choice — no diff view, see §3). Shown
 * when the open file changed on disk while the buffer has unsaved edits. Modal,
 * so the document can't drift further until the user decides.
 */
interface ConflictDialogProps {
  fileName: string;
  /** Overwrite the on-disk change with the in-editor version. */
  onKeepMine: () => void;
  /** Discard the in-editor edits and load the on-disk version. */
  onLoadFromDisk: () => void;
  /** Dismiss and keep editing (decide later). */
  onCancel: () => void;
}

export function ConflictDialog({ fileName, onKeepMine, onLoadFromDisk, onCancel }: ConflictDialogProps) {
  return (
    <div className="modal-overlay">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
        <h2 id="conflict-title" className="modal-title">File changed on disk</h2>
        <p className="modal-body">
          <strong>{fileName}</strong> changed on disk while you were editing it. Keep your version
          or load the one on disk?
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
            <span className="modal-hint">decide later</span>
          </button>
        </div>
      </div>
    </div>
  );
}

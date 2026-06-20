/**
 * Close-with-unsaved-edits prompt (PRD R41). Auto-save means most closes have
 * nothing pending; this covers the un-debounced window — save, discard, or keep
 * the tab open.
 */
interface CloseTabDialogProps {
  fileName: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export function CloseTabDialog({ fileName, onSave, onDiscard, onCancel }: CloseTabDialogProps) {
  return (
    <div className="modal-overlay">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="close-title">
        <h2 id="close-title" className="modal-title">Save before closing?</h2>
        <p className="modal-body">
          <strong>{fileName}</strong> has unsaved changes.
        </p>
        <div className="modal-actions modal-actions-row">
          <button type="button" className="modal-danger" onClick={onDiscard}>
            Discard
          </button>
          <span className="modal-spacer" />
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" className="modal-primary" onClick={onSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

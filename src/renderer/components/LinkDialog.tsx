/**
 * Link dialog (PRD: the link dialog). Cmd/Ctrl+K opens this instead of inserting raw syntax,
 * so the user never has to remember `[text](url)` ordering. Prefilled from the
 * selection or, when the cursor is inside an existing link, from that link —
 * confirming then updates it in place. In edit mode a Remove-link action strips
 * the syntax and keeps the plain text.
 */
import { useEffect, useRef, useState } from 'react';
import type { LinkContext } from './Editor';

interface LinkDialogProps {
  initial: LinkContext;
  onConfirm: (text: string, url: string) => void;
  onRemove: () => void;
  onCancel: () => void;
}

export function LinkDialog({ initial, onConfirm, onRemove, onCancel }: LinkDialogProps) {
  const [text, setText] = useState(initial.text);
  const [url, setUrl] = useState(initial.url);
  const urlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    urlRef.current?.focus(); // focus starts in the URL field
    urlRef.current?.select();
  }, []);

  // URL is required; Text is optional — when left blank the URL is used as the
  // link text (so `[https://x](https://x)`).
  const canConfirm = url.trim().length > 0;
  const confirm = () => {
    if (canConfirm) onConfirm(text, url);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="modal-overlay">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="link-title"
        onKeyDown={onKeyDown}
      >
        <h2 id="link-title" className="modal-title">{initial.editing ? 'Edit link' : 'Insert link'}</h2>
        <label className="link-field">
          <span>Text</span>
          <input type="text" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <label className="link-field">
          <span>URL</span>
          <input ref={urlRef} type="text" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <div className="modal-actions modal-actions-row">
          {initial.editing && (
            <button type="button" className="modal-danger" onClick={onRemove}>
              Remove link
            </button>
          )}
          <span className="modal-spacer" />
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" className="modal-primary" onClick={confirm} disabled={!canConfirm}>
            {initial.editing ? 'Update' : 'Insert'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Help window (PRD R48): basic app info, a keyboard-shortcut reference, and the
 * license + bundled third-party attribution (satisfying the §10 in-app notice).
 * A renderer modal — consistent with the app's other dialogs — opened from the
 * Help menu (main sends `menu:help`). Closes on the × button, the overlay, or Esc.
 */
import { useEffect } from 'react';
import { shortcutGroups } from '../help/shortcuts';
import { ATTRIBUTIONS, APP_LICENSE } from '../help/attribution';
import { APP_NAME, APP_DESCRIPTION } from '../help/meta';

interface HelpDialogProps {
  version: string;
  platform: string;
  onClose: () => void;
}

export function HelpDialog({ version, platform, onClose }: HelpDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const groups = shortcutGroups(platform);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal modal-help"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="help-header">
          <h2 id="help-title" className="modal-title">
            {APP_NAME} Help
          </h2>
          <button type="button" className="help-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="help-body">
          <section className="help-section">
            <p className="help-about">
              <strong>{APP_NAME}</strong> <span className="help-version">v{version}</span>
            </p>
            <p className="help-desc">{APP_DESCRIPTION}</p>
          </section>

          <section className="help-section">
            <h3 className="help-h">Keyboard shortcuts</h3>
            {groups.map((group) => (
              <div key={group.title} className="help-shortcut-group">
                <h4 className="help-group-title">{group.title}</h4>
                <dl className="help-shortcuts">
                  {group.items.map((s) => (
                    <div key={s.action} className="help-shortcut">
                      <dt>
                        <kbd>{s.keys}</kbd>
                      </dt>
                      <dd>{s.action}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </section>

          <section className="help-section">
            <h3 className="help-h">License &amp; attribution</h3>
            <p className="help-desc">
              {APP_NAME} is released under the {APP_LICENSE} license. It bundles these open-source
              libraries, with thanks:
            </p>
            <ul className="help-attrib">
              {ATTRIBUTIONS.map((a) => (
                <li key={a.name}>
                  <span className="help-lib">{a.name}</span>
                  <span className="help-license">{a.license}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

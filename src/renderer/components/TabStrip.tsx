/**
 * Tab strip (PRD R39/R40). One entry per open file: name, an unsaved-changes dot
 * (R40), an out-of-sync marker, and a close button (R41 — the prompt lives in
 * App). Clicking the label switches tabs; clicking × closes.
 */
import type { Tab } from '../App';

interface TabStripProps {
  tabs: Tab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  nameOf: (t: Tab) => string;
}

export function TabStrip({ tabs, activeId, onSelect, onClose, nameOf }: TabStripProps) {
  return (
    <div className="tab-strip" role="tablist">
      {tabs.map((t) => (
        <div key={t.id} className={`tab${t.id === activeId ? ' is-active' : ''}`}>
          <button
            type="button"
            className="tab-label"
            role="tab"
            aria-selected={t.id === activeId}
            title={t.path}
            onClick={() => onSelect(t.id)}
          >
            {t.conflict && (
              <span className="tab-warn" aria-label="Out of sync" title="Out of sync">●</span>
            )}
            {t.dirty && !t.conflict && (
              <span className="tab-dot" aria-label="Unsaved changes" title="Unsaved changes">●</span>
            )}
            <span className="tab-name">{nameOf(t)}</span>
          </button>
          <button
            type="button"
            className="tab-close"
            aria-label={`Close ${nameOf(t)}`}
            title="Close tab"
            onClick={() => onClose(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

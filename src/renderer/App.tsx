/**
 * Root component. Hosts the split editor/preview view (PRD R45) and the
 * view-mode switch (Source / Split / Preview) so either pane can fill the
 * window — reading mode hides the source.
 *
 * File opening, tabs, and saving are not built yet, so the view is seeded with a
 * built-in welcome document. Once the channel listener / file dialog land, this
 * shell grows a tab strip and the seed is replaced by opened files.
 */
import './app.css';
import { useState } from 'react';
import welcome from './welcome.md?raw';
import { SplitView, type ViewMode } from './components/SplitView';

const MODES: { id: ViewMode; label: string; title: string }[] = [
  { id: 'source', label: 'Source', title: 'Editor only' },
  { id: 'split', label: 'Split', title: 'Editor and preview' },
  { id: 'preview', label: 'Preview', title: 'Preview only (reading)' },
];

export function App() {
  const [viewMode, setViewMode] = useState<ViewMode>('split');

  return (
    <div className="app">
      <header className="app-titlebar">
        <span className="app-title">mdtool</span>
        <span className="app-subtitle">welcome.md — sample (unsaved)</span>
        <div className="view-switch" role="group" aria-label="View mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`view-switch-btn${viewMode === m.id ? ' is-active' : ''}`}
              aria-pressed={viewMode === m.id}
              title={m.title}
              onClick={() => setViewMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </header>
      <SplitView initialDoc={welcome} viewMode={viewMode} />
    </div>
  );
}

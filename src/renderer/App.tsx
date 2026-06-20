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

export function App() {
  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const showingSource = viewMode === 'split';

  const toggleSource = () => {
    const next: ViewMode = showingSource ? 'preview' : 'split';
    setViewMode(next);
    // Widen the window for the editor / shrink it back for reading (R45).
    void window.mdtool?.setSourceVisible(next === 'split');
  };

  return (
    <div className="app">
      <header className="app-titlebar">
        <span className="app-title">mdtool</span>
        <span className="app-subtitle">welcome.md — sample (unsaved)</span>
        <button
          type="button"
          className={`source-toggle${showingSource ? ' is-active' : ''}`}
          aria-pressed={showingSource}
          title={showingSource ? 'Hide the source editor' : 'Show the source editor'}
          onClick={toggleSource}
        >
          {showingSource ? 'Hide Source' : 'Show Source'}
        </button>
      </header>
      <SplitView initialDoc={welcome} viewMode={viewMode} />
    </div>
  );
}

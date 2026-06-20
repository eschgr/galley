/**
 * Root component. Hosts the split editor/preview view (PRD R45).
 *
 * File opening, tabs, and saving are not built yet, so the view is seeded with a
 * built-in welcome document. Once the channel listener / file dialog land, this
 * shell grows a tab strip and the seed is replaced by opened files.
 */
import './app.css';
import welcome from './welcome.md?raw';
import { SplitView } from './components/SplitView';

export function App() {
  return (
    <div className="app">
      <header className="app-titlebar">
        <span className="app-title">mdtool</span>
        <span className="app-subtitle">welcome.md — sample (unsaved)</span>
      </header>
      <SplitView initialDoc={welcome} />
    </div>
  );
}

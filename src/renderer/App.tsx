/**
 * Root component. Owns the open document and the view-mode switch, and hosts the
 * split editor/preview view (PRD R45).
 *
 * Document lifecycle (this phase): a file arrives via the command line (R7,
 * pulled on mount) or File → Open (R8); edits mark the doc dirty and trigger a
 * debounced auto-save (R29); Ctrl/Cmd+S force-saves (R30). External-change
 * watching/conflict (R32–R38) and tabs (R39+) are later phases. Until a file is
 * opened, the editor shows a built-in welcome sample (no path → not savable).
 */
import './app.css';
import { useEffect, useRef, useState } from 'react';
import welcome from './welcome.md?raw';
import { SplitView, type ViewMode } from './components/SplitView';
import type { EditorHandle } from './components/Editor';
import type { OpenedFile } from '../shared/api';

const AUTOSAVE_MS = 5000; // R29: save 5s after the last keystroke

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function App() {
  const editorRef = useRef<EditorHandle>(null);

  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const showingSource = viewMode === 'split';

  const [path, setPath] = useState<string | null>(null);
  const [text, setText] = useState(welcome);
  const [dirty, setDirty] = useState(false);

  // Refs mirror state for the once-registered IPC handlers / the autosave timer.
  const pathRef = useRef<string | null>(null);
  const textRef = useRef(welcome);
  const savedTextRef = useRef(welcome);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAutosave = () => {
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
  };

  const save = async () => {
    const p = pathRef.current;
    if (!p) return; // welcome sample has nowhere to save (Save As is a later phase)
    const content = textRef.current;
    if (content === savedTextRef.current) return; // nothing changed
    clearAutosave();
    try {
      await window.mdtool.saveFile(p, content);
      savedTextRef.current = content;
      setDirty(false);
    } catch (err) {
      console.error('[mdtool] save failed', err);
    }
  };

  const loadFile = (file: OpenedFile) => {
    clearAutosave();
    pathRef.current = file.path;
    savedTextRef.current = file.content;
    textRef.current = file.content;
    setPath(file.path);
    setText(file.content);
    setDirty(false);
    editorRef.current?.setDoc(file.content);
  };

  const onSourceChange = (next: string) => {
    setText(next);
    textRef.current = next;
    const isDirty = pathRef.current !== null && next !== savedTextRef.current;
    setDirty(isDirty);
    clearAutosave();
    if (isDirty) autosaveTimer.current = setTimeout(() => void save(), AUTOSAVE_MS);
  };

  // Pull a command-line file (R7) and subscribe to subsequent opens / save.
  useEffect(() => {
    void window.mdtool?.getStartupFile().then((file) => {
      if (file) loadFile(file);
    });
    const offOpen = window.mdtool?.onOpenFile((file) => loadFile(file));
    const offSave = window.mdtool?.onMenuSave(() => void save());
    return () => {
      offOpen?.();
      offSave?.();
      clearAutosave();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleSource = () => {
    const next: ViewMode = showingSource ? 'preview' : 'split';
    setViewMode(next);
    void window.mdtool?.setSourceVisible(next === 'split'); // widen/shrink window (R45)
  };

  const name = path ? basename(path) : 'welcome.md';
  const status = path ? (dirty ? 'unsaved changes' : 'saved') : 'sample (unsaved)';

  return (
    <div className="app">
      <header className="app-titlebar">
        <span className="app-title">Galley</span>
        <span className="app-subtitle" title={path ?? undefined}>
          {dirty && <span className="dirty-dot" aria-label="Unsaved changes">●</span>}
          {name} — {status}
        </span>
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
      <SplitView
        initialDoc={welcome}
        source={text}
        onSourceChange={onSourceChange}
        editorRef={editorRef}
        viewMode={viewMode}
      />
    </div>
  );
}

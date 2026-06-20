/**
 * Root component. Owns the open document and the view-mode switch, and hosts the
 * split editor/preview view (PRD R45).
 *
 * Document lifecycle: a file arrives via the command line (R7, pulled on mount)
 * or File → Open (R8); edits mark the doc dirty and trigger a debounced
 * auto-save (R29); Ctrl/Cmd+S force-saves (R30). The open file is watched for
 * external changes (R32).
 *
 * Conflict reconciliation (R34/R35/R36) — "decide once, mine wins until save or
 * reload":
 *  - clean buffer + external change → refresh silently;
 *  - dirty buffer + external change, or a save that finds disk diverged → prompt
 *    once (Keep my changes / Keep editing / Load from disk);
 *  - "Keep editing" starts a `mine` episode: further external changes are
 *    ignored and auto-save force-overwrites — no repeat prompts (R36). The
 *    episode ends on a deliberate Ctrl+S or a reload, after which a genuinely
 *    new change can prompt again.
 *
 * Tabs (R39+) are a later phase. Until a file is opened, the editor shows a
 * built-in welcome sample (not savable).
 */
import './app.css';
import { useEffect, useRef, useState } from 'react';
import welcome from './welcome.md?raw';
import { SplitView, type ViewMode } from './components/SplitView';
import { ConflictDialog } from './components/ConflictDialog';
import type { EditorHandle } from './components/Editor';
import type { OpenedFile } from '../shared/api';

const AUTOSAVE_MS = 5000; // R29: save 5s after the last keystroke

/** 'mine' = a conflict was resolved in favour of the editor for this episode. */
type Decision = 'none' | 'mine';

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
  const [conflict, setConflict] = useState<OpenedFile | null>(null);
  const [decision, setDecision] = useState<Decision>('none');

  // Refs mirror state for the once-registered IPC handlers / the autosave timer.
  const pathRef = useRef<string | null>(null);
  const textRef = useRef(welcome);
  const savedTextRef = useRef(welcome);
  const conflictRef = useRef<OpenedFile | null>(null);
  const decisionRef = useRef<Decision>('none');
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setConflictState = (next: OpenedFile | null) => {
    conflictRef.current = next;
    setConflict(next);
  };
  const setDecisionState = (next: Decision) => {
    decisionRef.current = next;
    setDecision(next);
  };

  const clearAutosave = () => {
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
  };

  // Save the current buffer. `force` overwrites disk ("keep mine"); otherwise a
  // checked save can come back as a conflict if disk diverged (R34). `manual`
  // (Ctrl+S) ends a `mine` episode.
  const save = async (opts?: { manual?: boolean; force?: boolean }) => {
    if (conflictRef.current) return; // R36: not while a conflict prompt is open
    const p = pathRef.current;
    if (!p) return; // welcome sample has nowhere to save (Save As is a later phase)
    const content = textRef.current;
    if (content === savedTextRef.current) return; // nothing changed
    clearAutosave();
    const force = opts?.force ?? decisionRef.current === 'mine';
    try {
      const outcome = await window.mdtool.saveFile(p, content, force);
      if (outcome.conflict) {
        setConflictState(outcome.disk); // write-path divergence (R34) → prompt
        return;
      }
      savedTextRef.current = content;
      setDirty(false);
      if (opts?.manual && decisionRef.current === 'mine') setDecisionState('none'); // Ctrl+S ends the episode
    } catch (err) {
      console.error('[Galley] save failed', err);
    }
  };

  const loadFile = (file: OpenedFile) => {
    clearAutosave();
    setConflictState(null);
    setDecisionState('none'); // reconciled with disk
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
    if (isDirty && !conflictRef.current) {
      autosaveTimer.current = setTimeout(() => void save(), AUTOSAVE_MS);
    }
  };

  // Conflict resolutions (R34/R35).
  const resolveKeepMine = () => {
    setConflictState(null);
    setDecisionState('none'); // committing mine reconciles → episode ends
    void save({ manual: true, force: true }); // overwrite the diverged disk
  };
  const resolveKeepEditing = () => {
    setConflictState(null);
    setDecisionState('mine'); // persist: ignore external changes, auto-save overwrites
  };
  const resolveLoadFromDisk = () => {
    if (conflictRef.current) loadFile(conflictRef.current); // take theirs
  };

  // Pull a command-line file (R7) and subscribe to opens / save / external change.
  useEffect(() => {
    void window.mdtool?.getStartupFile().then((file) => {
      if (file) loadFile(file);
    });
    const offOpen = window.mdtool?.onOpenFile((file) => loadFile(file));
    const offSave = window.mdtool?.onMenuSave(() => void save({ manual: true }));
    const offExternal = window.mdtool?.onExternalChange((diskFile) => {
      if (conflictRef.current) return; // a prompt is already open
      if (decisionRef.current === 'mine') return; // mine wins this episode — ignore (R34)
      if (textRef.current === savedTextRef.current) {
        loadFile(diskFile); // clean buffer → refresh silently (R35)
      } else {
        clearAutosave(); // R36: suspend auto-save while prompting
        setConflictState(diskFile); // dirty buffer → prompt (R35)
      }
    });
    return () => {
      offOpen?.();
      offSave?.();
      offExternal?.();
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
  const status = !path
    ? 'sample (unsaved)'
    : decision === 'mine'
      ? 'keeping your version'
      : dirty
        ? 'unsaved changes'
        : 'saved';

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
      {conflict && (
        <ConflictDialog
          fileName={basename(conflict.path)}
          onKeepMine={resolveKeepMine}
          onLoadFromDisk={resolveLoadFromDisk}
          onCancel={resolveKeepEditing}
        />
      )}
    </div>
  );
}

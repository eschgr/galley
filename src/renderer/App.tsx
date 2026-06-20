/**
 * Root component. Owns the open document and the view-mode switch, and hosts the
 * split editor/preview view (PRD R45).
 *
 * Document lifecycle: a file arrives via the command line (R7, pulled on mount)
 * or File → Open (R8); edits mark the doc dirty and trigger a debounced
 * auto-save (R29); Ctrl/Cmd+S force-saves (R30). The open file is watched for
 * external changes (R32).
 *
 * Conflict handling (R34/R35/R36) — Galley is for turn-based work, not
 * collaborative editing: the LLM writes the file and pauses, you read and tweak
 * it, you tell the LLM, it re-reads. Divergence (the file changing on disk while
 * you have unsaved edits) is the rare exception, so the app's only job is to say
 * so clearly and stay out of the way:
 *  - clean buffer + external change → refresh silently;
 *  - the first time disk diverges while you have edits (an external change, or a
 *    save that finds disk moved) → a modal pops once, loud enough to catch, and
 *    auto-save pauses so nothing is silently overwritten;
 *  - dismissing the modal ("decide later") collapses it to a passive status-bar
 *    flag (Reload / Keep mine) that does not re-pop on further external changes;
 *  - Reload takes disk, Keep mine overwrites — either clears the flag and resumes
 *    the normal flow. No locks, no sticky episodes.
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

// R29: save 5s after the last keystroke. A test seam lets e2e tests shorten it.
const AUTOSAVE_MS =
  Number((window as unknown as { __galleyAutosaveMs?: number }).__galleyAutosaveMs) || 5000;

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
  // The on-disk version that diverged from our buffer (null = in sync). Drives
  // the one-shot modal (until acknowledged) and the persistent status-bar flag.
  const [conflict, setConflict] = useState<OpenedFile | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  // Refs mirror state for the once-registered IPC handlers / the autosave timer.
  const pathRef = useRef<string | null>(null);
  const textRef = useRef(welcome);
  const savedTextRef = useRef(welcome);
  const conflictRef = useRef<OpenedFile | null>(null);
  // True once the user has edited since the last reconcile (load/reload or a
  // deliberate save). Auto-save can momentarily clear `dirty`, but while this is
  // set an external change still flags divergence instead of silently
  // refreshing — so an in-progress edit is never silently overwritten.
  const editedRef = useRef(false);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setConflictState = (next: OpenedFile | null) => {
    conflictRef.current = next;
    setConflict(next);
  };

  const clearAutosave = () => {
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
  };

  // Flag that disk diverged from our buffer. The first time (in sync → diverged)
  // we leave it un-acknowledged so the modal pops; later disk changes only
  // refresh the stashed version, keeping the flag passive (R36 no re-nag).
  const flagDiverged = (disk: OpenedFile) => {
    clearAutosave(); // R36: pause auto-save while out of sync
    if (!conflictRef.current) setAcknowledged(false); // first divergence → noisy modal
    setConflictState(disk); // always track the newest disk version
  };

  // Save the current buffer. `force` overwrites disk ("keep mine"); a normal
  // checked save can come back as a conflict if disk diverged (R34). `manual`
  // (Ctrl+S) records the reconcile so a clean buffer refreshes silently again.
  const save = async (opts?: { manual?: boolean; force?: boolean }) => {
    const force = opts?.force ?? false;
    if (conflictRef.current && !force) return; // out of sync: only a "keep mine" save writes
    const p = pathRef.current;
    if (!p) return; // welcome sample has nowhere to save (Save As is a later phase)
    const content = textRef.current;
    if (!force && content === savedTextRef.current) return; // nothing new
    clearAutosave();
    try {
      const outcome = await window.mdtool.saveFile(p, content, force);
      if (outcome.conflict) {
        flagDiverged(outcome.disk); // write-path divergence (R34)
        return;
      }
      savedTextRef.current = content;
      setDirty(false);
      if (opts?.manual) editedRef.current = false; // a deliberate save reconciles with disk
    } catch (err) {
      console.error('[Galley] save failed', err);
    }
  };

  const loadFile = (file: OpenedFile) => {
    clearAutosave();
    setConflictState(null);
    setAcknowledged(false);
    editedRef.current = false;
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
    if (isDirty) editedRef.current = true; // user has work in progress
    clearAutosave();
    if (isDirty && !conflictRef.current) {
      autosaveTimer.current = setTimeout(() => void save(), AUTOSAVE_MS);
    }
  };

  // Conflict resolutions (R34/R35).
  const resolveKeepMine = () => {
    setConflictState(null);
    setAcknowledged(false);
    void save({ manual: true, force: true }); // overwrite the diverged disk
  };
  const resolveLoadFromDisk = () => {
    if (conflictRef.current) loadFile(conflictRef.current); // take theirs
  };
  const resolveDecideLater = () => {
    setAcknowledged(true); // collapse the modal to a passive flag; keep the warning
  };

  // Pull a command-line file (R7) and subscribe to opens / save / external change.
  useEffect(() => {
    void window.mdtool?.getStartupFile().then((file) => {
      if (file) loadFile(file);
    });
    const offOpen = window.mdtool?.onOpenFile((file) => loadFile(file));
    const offSave = window.mdtool?.onMenuSave(() => {
      if (conflictRef.current) resolveKeepMine(); // Ctrl+S while out of sync = keep mine
      else void save({ manual: true });
    });
    const offExternal = window.mdtool?.onExternalChange((diskFile) => {
      if (!conflictRef.current && !editedRef.current) {
        loadFile(diskFile); // in sync & untouched → refresh silently (R35)
      } else {
        flagDiverged(diskFile); // edits in progress, or already flagged → surface it
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
    : conflict
      ? 'out of sync — disk changed'
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
        {conflict && (
          <span className="sync-flag" role="status">
            <span className="sync-flag-dot" aria-hidden="true">●</span>
            out of sync
            <button type="button" className="sync-flag-btn" onClick={resolveLoadFromDisk}>
              Reload
            </button>
            <button type="button" className="sync-flag-btn" onClick={resolveKeepMine}>
              Keep mine
            </button>
          </span>
        )}
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
      {conflict && !acknowledged && (
        <ConflictDialog
          fileName={basename(conflict.path)}
          onKeepMine={resolveKeepMine}
          onLoadFromDisk={resolveLoadFromDisk}
          onCancel={resolveDecideLater}
        />
      )}
    </div>
  );
}

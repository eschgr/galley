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
 * you have unsaved edits) is the rare exception, and there are only ever two
 * real choices — take theirs or keep yours:
 *  - clean buffer + external change → refresh silently;
 *  - the first divergence of a run while you have edits (an external change, or a
 *    save that finds disk moved) → one loud modal: Load from disk / Keep mine.
 *    Auto-save pauses so nothing is silently overwritten;
 *  - Keep mine writes your version and stays alert; if disk diverges again it
 *    recurs as a passive status-bar flag (Reload / Keep mine), not another modal;
 *  - Load from disk takes theirs and fully reconciles, re-arming the loud notice
 *    for a genuinely new divergence later. No locks, no sticky episodes.
 *
 * Tabs (R39+) are a later phase. Until a file is opened, the editor shows a
 * built-in welcome sample (not savable).
 */
import './app.css';
import { useEffect, useRef, useState } from 'react';
import welcome from './welcome.md?raw';
import { SplitView, type ViewMode } from './components/SplitView';
import { ConflictDialog } from './components/ConflictDialog';
import { LinkDialog } from './components/LinkDialog';
import type { EditorHandle, LinkContext } from './components/Editor';
import type { OpenedFile } from '../shared/api';

// R29: save 5s after the last keystroke. A test seam lets e2e tests shorten it.
const AUTOSAVE_MS =
  Number((window as unknown as { __galleyAutosaveMs?: number }).__galleyAutosaveMs) || 5000;

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * What the editor is currently showing, tracked explicitly rather than inferred
 * from a null path. Today it's either the built-in welcome screen (a never-saved
 * sandbox shown when no file is open) or a file opened from disk. A third
 * `untitled` kind — an editable buffer with no destination yet — arrives with
 * the Save As phase; keeping this a tagged union makes that a clean addition.
 */
type DocState = { kind: 'welcome' } | { kind: 'file'; path: string };

export function App() {
  const editorRef = useRef<EditorHandle>(null);

  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const showingSource = viewMode === 'split';

  const [doc, setDoc] = useState<DocState>({ kind: 'welcome' });
  const [text, setText] = useState(welcome);
  const [dirty, setDirty] = useState(false);
  // The on-disk version that diverged from our buffer (null = in sync). Drives
  // the loud modal (first divergence) and the passive flag (recurrences).
  const [conflict, setConflict] = useState<OpenedFile | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [linkCtx, setLinkCtx] = useState<LinkContext | null>(null);

  // Refs mirror state for the once-registered IPC handlers / the autosave timer.
  const docRef = useRef<DocState>({ kind: 'welcome' });
  const textRef = useRef(welcome);
  const savedTextRef = useRef(welcome);
  const conflictRef = useRef<OpenedFile | null>(null);
  // The loud modal has already been shown since the last full reload. Once set,
  // further divergence recurs as the passive flag, not another modal — "loud
  // once per run". Reset only by loading from disk / reopening.
  const noticedRef = useRef(false);
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
  const setDocState = (next: DocState) => {
    docRef.current = next;
    setDoc(next);
  };

  const clearAutosave = () => {
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
  };

  // Flag that disk diverged from our buffer. The first divergence of a run pops
  // the loud modal; once that's been shown, later divergence (e.g. after Keep
  // mine) recurs quietly as the passive flag (R36 — loud once).
  const flagDiverged = (disk: OpenedFile) => {
    clearAutosave(); // R36: pause auto-save while out of sync
    setConflictState(disk); // always track the newest disk version
    if (!noticedRef.current) {
      noticedRef.current = true;
      setShowModal(true); // first divergence of the run → one loud notice
    }
  };

  // Save the current buffer. `force` overwrites disk ("keep mine"); a normal
  // checked save can come back as a conflict if disk diverged (R34). `manual`
  // (Ctrl+S) records the reconcile so a clean buffer refreshes silently again.
  const save = async (opts?: { manual?: boolean; force?: boolean }) => {
    const force = opts?.force ?? false;
    if (conflictRef.current && !force) return; // out of sync: only a "keep mine" save writes
    const d = docRef.current;
    if (d.kind !== 'file') return; // the welcome screen has no destination (Save As is a later phase)
    const p = d.path;
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
    setShowModal(false);
    noticedRef.current = false; // full reconcile → the loud notice re-arms
    editedRef.current = false;
    setDocState({ kind: 'file', path: file.path });
    savedTextRef.current = file.content;
    textRef.current = file.content;
    setText(file.content);
    setDirty(false);
    editorRef.current?.setDoc(file.content);
  };

  const onSourceChange = (next: string) => {
    setText(next);
    textRef.current = next;
    const isDirty = docRef.current.kind === 'file' && next !== savedTextRef.current;
    setDirty(isDirty);
    if (isDirty) editedRef.current = true; // user has work in progress
    clearAutosave();
    if (isDirty && !conflictRef.current) {
      autosaveTimer.current = setTimeout(() => void save(), AUTOSAVE_MS);
    }
  };

  // Conflict resolutions (R34/R35) — two choices: take theirs, or keep mine.
  const resolveKeepMine = () => {
    setConflictState(null);
    setShowModal(false);
    // Write my version over disk, but stay alert: I still hold authored content,
    // so if disk diverges *again* the next change re-raises the notice (quietly,
    // as the passive flag) rather than silently loading over my version. Hence
    // keep `editedRef` set and don't pass `manual` (which would re-arm silent
    // refresh).
    editedRef.current = true;
    void save({ force: true }); // overwrite the diverged disk
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

  // Cmd/Ctrl+K (R27): snapshot the link context at the cursor, then open the
  // dialog. Resolving applies/removes via the editor handle's stashed range.
  const openLinkDialog = () => {
    const ctx = editorRef.current?.requestLink();
    if (ctx) setLinkCtx(ctx);
  };

  const toggleSource = () => {
    const next: ViewMode = showingSource ? 'preview' : 'split';
    setViewMode(next);
    void window.mdtool?.setSourceVisible(next === 'split'); // widen/shrink window (R45)
  };

  // The welcome screen is its own thing — a sandbox, not a file — so it just
  // reads "Welcome!". A file shows its name plus saved/dirty/out-of-sync status.
  const fileStatus = conflict
    ? 'out of sync — disk changed'
    : dirty
      ? 'unsaved changes'
      : 'saved';

  return (
    <div className="app">
      <header className="app-titlebar">
        <span className="app-title">Galley</span>
        <span className="app-subtitle" title={doc.kind === 'file' ? doc.path : undefined}>
          {doc.kind === 'file' ? (
            <>
              {dirty && <span className="dirty-dot" aria-label="Unsaved changes">●</span>}
              {basename(doc.path)} — {fileStatus}
            </>
          ) : (
            'Welcome!'
          )}
        </span>
        {conflict && !showModal && (
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
        onLink={openLinkDialog}
      />
      {conflict && showModal && (
        <ConflictDialog
          fileName={basename(conflict.path)}
          onKeepMine={resolveKeepMine}
          onLoadFromDisk={resolveLoadFromDisk}
        />
      )}
      {linkCtx && (
        <LinkDialog
          initial={linkCtx}
          onConfirm={(t, u) => {
            editorRef.current?.applyLink(t, u);
            setLinkCtx(null);
          }}
          onRemove={() => {
            editorRef.current?.removeLink();
            setLinkCtx(null);
          }}
          onCancel={() => setLinkCtx(null)}
        />
      )}
    </div>
  );
}

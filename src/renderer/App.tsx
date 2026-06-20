/**
 * Root component. Owns the open tabs and the view-mode switch, and hosts the
 * split editor/preview view (PRD R45).
 *
 * Tabs (R39): each open file is a tab with its own buffer, baseline, dirty state,
 * conflict state, and editor state (undo/scroll/selection, stashed on switch).
 * One CodeMirror instance is shared; switching tabs swaps its state. When no tab
 * is open the editor shows the built-in welcome sandbox (R46 empty state).
 *
 * Document lifecycle per tab: a file arrives via the command line (R7) or
 * File → Open (R8); edits mark the tab dirty and trigger a debounced auto-save
 * (R29); Ctrl/Cmd+S force-saves the active tab (R30); each open file is watched
 * for external changes (R32).
 *
 * Conflict handling (R34/R35/R36) is per tab — for the active tab a divergence
 * pops one loud modal then a passive flag; a background tab's divergence is
 * tracked silently (its tab shows a marker) and surfaces when you switch to it.
 * Two choices only: take theirs (Load from disk) or keep yours (Keep mine).
 */
import './app.css';
import { useEffect, useRef, useState } from 'react';
import type { EditorState } from '@codemirror/state';
import welcome from './welcome.md?raw';
import { SplitView, type ViewMode } from './components/SplitView';
import { ConflictDialog } from './components/ConflictDialog';
import { LinkDialog } from './components/LinkDialog';
import { TabStrip } from './components/TabStrip';
import { CloseTabDialog } from './components/CloseTabDialog';
import type { EditorHandle, LinkContext } from './components/Editor';
import type { OpenedFile } from '../shared/api';

// R29: save 5s after the last keystroke. A test seam lets e2e tests shorten it.
const AUTOSAVE_MS =
  Number((window as unknown as { __galleyAutosaveMs?: number }).__galleyAutosaveMs) || 5000;

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** One open document (R39). The buffer (`text`) is the source of truth; `saved`
 *  is the last loaded/saved baseline. `conflict`/`noticed`/`showModal`/`edited`
 *  carry the per-tab out-of-sync state (R34–R36). */
export interface Tab {
  id: string;
  path: string;
  text: string;
  saved: string;
  dirty: boolean;
  edited: boolean;
  conflict: OpenedFile | null;
  noticed: boolean;
  showModal: boolean;
}

export function App() {
  const editorRef = useRef<EditorHandle>(null);

  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const showingSource = viewMode === 'split';

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [welcomeText, setWelcomeText] = useState(welcome);
  const [linkCtx, setLinkCtx] = useState<LinkContext | null>(null);
  const [closing, setClosing] = useState<Tab | null>(null); // close-with-unsaved prompt

  // Refs mirror state for the once-registered IPC handlers and timers.
  const tabsRef = useRef<Tab[]>([]);
  const activeIdRef = useRef<string | null>(null);
  const welcomeTextRef = useRef(welcome);
  const editorStates = useRef<Map<string, EditorState>>(new Map());
  const autosaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const idSeq = useRef(0);

  const commitTabs = (next: Tab[]) => {
    tabsRef.current = next;
    setTabs(next);
  };
  const updateTab = (id: string, patch: Partial<Tab>) =>
    commitTabs(tabsRef.current.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const tabById = (id: string | null) => tabsRef.current.find((t) => t.id === id);
  const setActive = (id: string | null) => {
    activeIdRef.current = id;
    setActiveId(id);
  };
  const setWelcome = (next: string) => {
    welcomeTextRef.current = next;
    setWelcomeText(next);
  };

  const clearAutosave = (id: string) => {
    const timer = autosaveTimers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      autosaveTimers.current.delete(id);
    }
  };

  // Out-of-sync for one tab (R36): the first divergence of a run pops the loud
  // modal; once shown, later divergence recurs as the passive flag.
  const flagDiverged = (id: string, disk: OpenedFile) => {
    clearAutosave(id);
    const t = tabById(id);
    updateTab(id, { conflict: disk, noticed: true, showModal: !(t?.noticed ?? false) });
  };

  // Save one tab's buffer (R29/R30/R34). `force` overwrites disk ("keep mine").
  const saveTab = async (id: string, opts?: { manual?: boolean; force?: boolean }) => {
    const t = tabById(id);
    if (!t) return;
    const force = opts?.force ?? false;
    if (t.conflict && !force) return; // out of sync: only a keep-mine save writes
    const content = t.text;
    if (!force && content === t.saved) return; // nothing new
    clearAutosave(id);
    try {
      const outcome = await window.mdtool.saveFile(t.path, content, force);
      if (outcome.conflict) {
        flagDiverged(id, outcome.disk); // write-path divergence (R34)
        return;
      }
      const latest = tabById(id);
      updateTab(id, {
        saved: content,
        dirty: latest ? latest.text !== content : false,
        ...(opts?.manual ? { edited: false } : {}),
      });
    } catch (err) {
      console.error('[Galley] save failed', err);
    }
  };

  // Load disk content into a tab (open, reload, or silent refresh). Resets the
  // tab to a clean, in-sync baseline; the stashed editor state is dropped so the
  // editor rebuilds from the new text.
  const reloadTab = (id: string, file: OpenedFile) => {
    clearAutosave(id);
    editorStates.current.delete(id);
    updateTab(id, {
      path: file.path,
      text: file.content,
      saved: file.content,
      dirty: false,
      edited: false,
      conflict: null,
      noticed: false,
      showModal: false,
    });
    if (activeIdRef.current === id) editorRef.current?.setDoc(file.content);
  };

  // Switch the active tab, stashing the current editor state and restoring the
  // target's (or loading its text fresh if not stashed yet).
  const switchTo = (id: string) => {
    const cur = activeIdRef.current;
    if (cur === id) return;
    if (cur) {
      const st = editorRef.current?.getState();
      if (st) editorStates.current.set(cur, st);
    }
    setActive(id);
    const stashed = editorStates.current.get(id);
    if (stashed) editorRef.current?.setState(stashed);
    else {
      const t = tabById(id);
      if (t) editorRef.current?.setDoc(t.text);
    }
  };

  // Open a file in a tab (R39): focus + refresh if already open, else add a tab.
  const openTab = (file: OpenedFile) => {
    const existing = tabsRef.current.find((t) => t.path === file.path);
    if (existing) {
      reloadTab(existing.id, file);
      switchTo(existing.id);
      return;
    }
    const id = `tab${idSeq.current++}`;
    const tab: Tab = {
      id,
      path: file.path,
      text: file.content,
      saved: file.content,
      dirty: false,
      edited: false,
      conflict: null,
      noticed: false,
      showModal: false,
    };
    const cur = activeIdRef.current;
    if (cur) {
      const st = editorRef.current?.getState();
      if (st) editorStates.current.set(cur, st);
    }
    commitTabs([...tabsRef.current, tab]);
    setActive(id);
    editorRef.current?.setDoc(file.content);
  };

  const closeTab = (id: string) => {
    const idx = tabsRef.current.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const t = tabsRef.current[idx];
    window.mdtool?.notifyClosed(t.path); // R41: stop watching its file
    clearAutosave(id);
    editorStates.current.delete(id);
    const remaining = tabsRef.current.filter((x) => x.id !== id);
    commitTabs(remaining);
    if (activeIdRef.current !== id) return;
    if (remaining.length === 0) {
      setActive(null);
      editorRef.current?.setDoc(welcomeTextRef.current); // back to the welcome sandbox
      return;
    }
    const next = remaining[Math.min(idx, remaining.length - 1)];
    setActive(next.id);
    const stashed = editorStates.current.get(next.id);
    if (stashed) editorRef.current?.setState(stashed);
    else editorRef.current?.setDoc(next.text);
  };

  // R41: closing a tab with unsaved edits prompts first.
  const requestClose = (id: string) => {
    const t = tabById(id);
    if (t?.dirty) setClosing(t);
    else closeTab(id);
  };

  const onSourceChange = (next: string) => {
    const id = activeIdRef.current;
    if (!id) {
      setWelcome(next); // editing the welcome sandbox — ephemeral, not saved
      return;
    }
    const t = tabById(id);
    if (!t) return;
    const isDirty = next !== t.saved;
    updateTab(id, { text: next, dirty: isDirty, edited: t.edited || isDirty });
    clearAutosave(id);
    if (isDirty && !t.conflict) {
      autosaveTimers.current.set(id, setTimeout(() => void saveTab(id), AUTOSAVE_MS));
    }
  };

  // Conflict resolutions (R34/R35) on the active tab — take theirs, or keep mine.
  const resolveKeepMine = () => {
    const id = activeIdRef.current;
    if (!id) return;
    updateTab(id, { conflict: null, showModal: false, edited: true });
    void saveTab(id, { force: true });
  };
  const resolveLoadFromDisk = () => {
    const id = activeIdRef.current;
    const t = tabById(id);
    if (id && t?.conflict) reloadTab(id, t.conflict);
  };

  // Pull a command-line file (R7) and subscribe to opens / save / reload / change.
  useEffect(() => {
    void window.mdtool?.getStartupFile().then((file) => {
      if (file) openTab(file);
    });
    const offOpen = window.mdtool?.onOpenFile((file) => openTab(file));
    const offSave = window.mdtool?.onMenuSave(() => {
      const id = activeIdRef.current;
      const t = tabById(id);
      if (!id || !t) return;
      if (t.conflict) resolveKeepMine();
      else void saveTab(id, { manual: true });
    });
    const offReload = window.mdtool?.onReloadFile(() => {
      const id = activeIdRef.current;
      const t = tabById(id);
      if (!id || !t) return;
      void window.mdtool.readFile(t.path).then((file) => {
        if (file && activeIdRef.current === id) reloadTab(id, file);
      });
    });
    const offExternal = window.mdtool?.onExternalChange((diskFile) => {
      const t = tabsRef.current.find((x) => x.path === diskFile.path);
      if (!t) return;
      if (!t.conflict && !t.edited) reloadTab(t.id, diskFile); // in sync → refresh
      else flagDiverged(t.id, diskFile); // edits in progress / already flagged → surface
    });
    return () => {
      offOpen?.();
      offSave?.();
      offReload?.();
      offExternal?.();
      for (const timer of autosaveTimers.current.values()) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cmd/Ctrl+K (R27): snapshot the link context at the cursor, then open the dialog.
  const openLinkDialog = () => {
    const ctx = editorRef.current?.requestLink();
    if (ctx) setLinkCtx(ctx);
  };

  const toggleSource = () => {
    const next: ViewMode = showingSource ? 'preview' : 'split';
    setViewMode(next);
    void window.mdtool?.setSourceVisible(next === 'split'); // widen/shrink window (R45)
  };

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const source = activeTab ? activeTab.text : welcomeText;
  const conflict = activeTab?.conflict ?? null;
  const showModal = activeTab?.showModal ?? false;

  // The OS window title carries the active file name (the in-app title line was
  // removed in favour of the single toolbar row).
  const activePath = activeTab?.path;
  useEffect(() => {
    document.title = activePath ? `${basename(activePath)} — Galley` : 'Galley';
  }, [activePath]);

  return (
    <div className="app">
      {/* One toolbar row: tabs on the left, the source toggle on the right. */}
      <header className="toolbar">
        {tabs.length > 0 && (
          <TabStrip
            tabs={tabs}
            activeId={activeId}
            onSelect={switchTo}
            onClose={requestClose}
            nameOf={(t) => basename(t.path)}
          />
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
      {/* Out-of-sync notice sits just below the tab bar (R36, passive flag). */}
      {conflict && !showModal && (
        <div className="sync-flag" role="status">
          <span className="sync-flag-dot" aria-hidden="true">●</span>
          <span className="sync-flag-text">
            <strong>{basename(conflict.path)}</strong> is out of sync — disk changed
          </span>
          <button type="button" className="sync-flag-btn" onClick={resolveLoadFromDisk}>
            Reload
          </button>
          <button type="button" className="sync-flag-btn" onClick={resolveKeepMine}>
            Keep mine
          </button>
        </div>
      )}
      <SplitView
        initialDoc={welcome}
        source={source}
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
      {closing && (
        <CloseTabDialog
          fileName={basename(closing.path)}
          onSave={() => {
            const id = closing.id;
            setClosing(null);
            void saveTab(id, { manual: true }).then(() => closeTab(id));
          }}
          onDiscard={() => {
            const id = closing.id;
            setClosing(null);
            closeTab(id);
          }}
          onCancel={() => setClosing(null)}
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

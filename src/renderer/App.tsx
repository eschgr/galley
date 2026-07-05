/**
 * Root component. Owns the open tabs and the view-mode switch, and hosts a
 * per-tab split editor/preview view (split view & Show/Hide Source reading mode).
 *
 * Tabs: each open file is a tab with its own buffer, baseline, dirty state,
 * and conflict state. Each open tab also renders its OWN self-contained
 * TabView (its own CodeMirror editor + preview + split layout + scroll-sync). All
 * open tabs' TabViews stay mounted; only the active one is visible (the rest are
 * display:none). Switching tabs just changes which one is visible — no re-parse,
 * no DOM rebuild, no editor/preview state-swap. When no tab is open a dedicated
 * welcome TabView shows the built-in sandbox (empty state), editable but
 * ephemeral.
 *
 * Document lifecycle per tab: a file arrives via the command line or
 * File → Open; edits mark the tab dirty and trigger a debounced auto-save;
 * Ctrl/Cmd+S force-saves the active tab; each open file is watched
 * for external changes.
 *
 * Conflict handling (write-path/read-path guards + the out-of-sync notice) is per tab — for the active tab a divergence
 * pops one loud modal then a passive flag; a background tab's divergence is
 * tracked silently (its tab shows a marker) and surfaces when you switch to it.
 * Two choices only: take theirs (Load from disk) or keep yours (Keep mine).
 *
 * Text source of truth: the active tab's editor while mounted; Tab.text MIRRORS
 * it via onSourceChange (driving that tab's preview). A reload from disk pushes
 * the new text DOWN to the editor by bumping the tab's `docVersion` (TabView
 * watches it and re-seeds the editor); ordinary edits never bump it.
 */
import './app.css';
import './print.css';
import { useEffect, useRef, useState } from 'react';
import welcome from './welcome.md?raw';
import { type ViewMode } from './components/SplitView';
import { TabView, type TabViewHandle } from './components/TabView';
import { ConflictDialog } from './components/ConflictDialog';
import { LinkDialog } from './components/LinkDialog';
import { TabStrip } from './components/TabStrip';
import { reorderToIndex } from './reorderTabs';
import { CloseTabDialog } from './components/CloseTabDialog';
import { RestoreDialog } from './components/RestoreDialog';
import { HelpDialog } from './components/HelpDialog';
import type { LinkContext } from './components/Editor';
import type { OpenedFile, OpenTarget } from '../shared/api';
import { cycleTabTarget, type CycleDirection } from './cycleTab';
import { dropPaths } from './dropOpen';

// Debounced auto-save: save 5s after the last keystroke. A test seam lets e2e tests shorten it.
const AUTOSAVE_MS =
  Number((window as unknown as { __galleyAutosaveMs?: number }).__galleyAutosaveMs) || 5000;

// The welcome sandbox is rendered as a dedicated, always-present TabView keyed
// here, so the empty state owns a real editor/preview pair like any open tab.
const WELCOME_ID = '__welcome__';

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** One open document. The buffer (`text`) is the source of truth; `saved`
 *  is the last loaded/saved baseline. `conflict`/`noticed`/`showModal`/`edited`
 *  carry the per-tab out-of-sync state. `orphaned` is set when the file was
 *  moved/deleted on disk ("file gone"): the buffer is preserved, saving is guarded,
 *  and a passive banner shows until dismissed (`orphanAck`) or relocated (Save As).
 *  `docVersion` is bumped on a reload-from-disk so the tab's editor re-seeds (it
 *  never changes on an edit). */
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
  orphaned: boolean;
  orphanAck: boolean;
  docVersion: number;
}

export function App() {
  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const showingSource = viewMode === 'split';

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [welcomeText, setWelcomeText] = useState(welcome);
  const [linkCtx, setLinkCtx] = useState<LinkContext | null>(null);
  const [closing, setClosing] = useState<Tab | null>(null); // close-with-unsaved prompt
  const [showHelp, setShowHelp] = useState(false); // Help window
  // The session offered for restore after a dirty shutdown, or null.
  // Set once on mount when main reports a restorable session; cleared on the user's
  // Yes/No. Held so the Yes handler can reopen exactly what was loaded from disk.
  const [restore, setRestore] = useState<{ files: OpenedFile[]; activeIndex: number } | null>(null);

  // Refs mirror state for the once-registered IPC handlers and timers.
  const tabsRef = useRef<Tab[]>([]);
  const activeIdRef = useRef<string | null>(null);
  const welcomeTextRef = useRef(welcome);
  // One TabView handle per rendered view (open tabs + the welcome sandbox), so App
  // can drive the ACTIVE tab (link dialog, top line, fragment jump, focus). Set
  // via each TabView's ref callback; pruned as tabs close.
  const viewRefs = useRef<Map<string, TabViewHandle | null>>(new Map());
  // A `#fragment` from a clicked file link, applied to the target tab's preview
  // once it renders/activates.
  const pendingFragment = useRef<string | null>(null);
  // 1-based reveal lines (open at a specific line), keyed BY TAB id, applied to a
  // tab's preview once it is the visible tab. Per-tab (not a single ref) so several
  // channel opens arriving in one render batch never cross-wire — each file only
  // ever reveals its own line on its own tab, and an unfocused tab's reveal simply
  // waits until it is switched to (a hidden pane can't be scrolled).
  const pendingReveals = useRef<Map<string, number>>(new Map());
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
  // The TabView handle for the currently active tab (or the welcome sandbox).
  const activeView = () => viewRefs.current.get(activeIdRef.current ?? WELCOME_ID) ?? null;

  const clearAutosave = (id: string) => {
    const timer = autosaveTimers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      autosaveTimers.current.delete(id);
    }
  };

  // Out-of-sync notice for one tab: the first divergence of a run pops the loud
  // modal; once shown, later divergence recurs as the passive flag.
  const flagDiverged = (id: string, disk: OpenedFile) => {
    clearAutosave(id);
    const t = tabById(id);
    updateTab(id, { conflict: disk, noticed: true, showModal: !(t?.noticed ?? false) });
  };

  // Save one tab's buffer (auto-save / force-save / write-path conflict guard). `force` overwrites disk ("keep mine").
  // Resolves to whether it is now safe to CLOSE the tab off the back of this save:
  // false only when the user backed out of a relocation (Save As cancelled) so the
  // unsaved buffer must be kept, not closed. Non-close callers ignore the result.
  const saveTab = async (id: string, opts?: { manual?: boolean; force?: boolean }): Promise<boolean> => {
    const t = tabById(id);
    if (!t) return false;
    // File gone: never re-create it at the old path — a save on an orphaned tab is
    // routed to Save As so the user chooses where the relocated document lands. A
    // cancelled Save As returns false so a close-then-save never discards the buffer.
    if (t.orphaned) return saveAsTab(id);
    const force = opts?.force ?? false;
    if (t.conflict && !force) return true; // out of sync: only a keep-mine save writes
    const content = t.text;
    if (!force && content === t.saved) return true; // nothing new
    clearAutosave(id);
    try {
      const outcome = await window.galley.saveFile(t.path, content, force);
      if (outcome.conflict) {
        flagDiverged(id, outcome.disk); // write-path divergence
        return true;
      }
      const latest = tabById(id);
      updateTab(id, {
        saved: content,
        dirty: latest ? latest.text !== content : false,
        ...(opts?.manual ? { edited: false } : {}),
      });
      return true;
    } catch (err) {
      console.error('[Galley] save failed', err);
      return true;
    }
  };

  // Load disk content into a tab (open, reload, or silent refresh). Resets the tab
  // to a clean, in-sync baseline and bumps `docVersion` so the tab's TabView
  // re-seeds its editor from the new text (keeping the reading line on manual reload).
  const reloadTab = (id: string, file: OpenedFile) => {
    clearAutosave(id);
    const t = tabById(id);
    updateTab(id, {
      path: file.path,
      text: file.content,
      saved: file.content,
      dirty: false,
      edited: false,
      conflict: null,
      noticed: false,
      showModal: false,
      orphaned: false,
      orphanAck: false,
      docVersion: (t?.docVersion ?? 0) + 1,
    });
  };

  // Switch the active tab. With per-tab kept-mounted views this is just a
  // visibility flip — no stash/restore. A pending #fragment is applied to the
  // now-active tab's preview once it's visible (see the [activeId] effect).
  const switchTo = (id: string) => {
    if (activeIdRef.current === id) return;
    setActive(id);
  };

  // Apply (and consume) a tab's pending open-at-line reveal, if it has one and its
  // view is mounted. Per-tab, so a reveal is always applied to the file it was
  // meant for — never a line from a different open that raced into the same batch.
  const applyReveal = (id: string) => {
    const line = pendingReveals.current.get(id);
    if (line === undefined) return;
    pendingReveals.current.delete(id);
    viewRefs.current.get(id)?.revealLine(line);
  };

  // Open a file in a tab: focus + refresh if already open, else add a tab. An
  // optional reveal line (open at a specific line) is recorded for THAT tab and
  // applied once it is the visible tab — immediately if it already is, otherwise by
  // the [activeId] effect after the switch (which is also when a fresh tab first
  // renders).
  const openTab = (file: OpenTarget) => {
    const existing = tabsRef.current.find((t) => t.path === file.path);
    if (existing) {
      reloadTab(existing.id, file);
      if (file.line !== undefined) pendingReveals.current.set(existing.id, file.line);
      if (file.line !== undefined && activeIdRef.current === existing.id) {
        applyReveal(existing.id); // already the visible tab (no switch to trigger the effect)
      } else {
        switchTo(existing.id);
      }
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
      orphaned: false,
      orphanAck: false,
      docVersion: 0,
    };
    if (file.line !== undefined) pendingReveals.current.set(id, file.line); // revealed once the new tab activates
    commitTabs([...tabsRef.current, tab]);
    setActive(id);
  };

  const closeTab = (id: string) => {
    const idx = tabsRef.current.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const t = tabsRef.current[idx];
    window.galley?.notifyClosed(t.path); // closing a tab: stop watching its file
    clearAutosave(id);
    viewRefs.current.delete(id);
    pendingReveals.current.delete(id); // drop any unapplied reveal for the closed tab
    const remaining = tabsRef.current.filter((x) => x.id !== id);
    commitTabs(remaining);
    if (activeIdRef.current !== id) return;
    if (remaining.length === 0) {
      setActive(null); // back to the welcome sandbox
      return;
    }
    const next = remaining[Math.min(idx, remaining.length - 1)];
    setActive(next.id);
  };

  // Drag-reorder the tab strip. Reorders the array only — activeId is an id,
  // not an index, so the active tab stays active and simply moves to its new slot.
  const reorder = (draggedId: string, insertIndex: number) => {
    commitTabs(reorderToIndex(tabsRef.current, draggedId, insertIndex));
  };

  // Closing a tab with unsaved edits prompts first.
  const requestClose = (id: string) => {
    const t = tabById(id);
    if (t?.dirty) setClosing(t);
    else closeTab(id);
  };

  // An edit in a tab's editor (or the welcome sandbox) — mirror it into state. The
  // editor is the source of truth; this keeps Tab.text (which drives the preview)
  // in step and runs the dirty/auto-save bookkeeping. Never bumps docVersion, so
  // the editor is not re-seeded from its own edit.
  const onSourceChange = (id: string, next: string) => {
    if (id === WELCOME_ID) {
      setWelcome(next); // editing the welcome sandbox — ephemeral, not saved
      return;
    }
    const t = tabById(id);
    if (!t) return;
    const isDirty = next !== t.saved;
    updateTab(id, { text: next, dirty: isDirty, edited: t.edited || isDirty });
    clearAutosave(id);
    // An orphaned tab's buffer is preserved and editable, but auto-save is
    // suspended — there is no valid path to write to (saving routes to Save As).
    if (isDirty && !t.conflict && !t.orphaned) {
      autosaveTimers.current.set(id, setTimeout(() => void saveTab(id), AUTOSAVE_MS));
    }
  };

  // Conflict resolutions (write-path/read-path guards) on the active tab — take theirs, or keep mine.
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

  // The file behind a tab was moved/deleted on disk ("file gone"): mark it
  // orphaned so the buffer is preserved, saving is guarded, and a passive banner
  // appears — never a modal, so a bulk reorg can't storm. Idempotent: a path
  // already orphaned stays as-is, so repeated removal signals coalesce. Auto-save
  // is cancelled — there is no valid path to write to.
  const markOrphaned = (path: string) => {
    const t = tabsRef.current.find((x) => x.path === path);
    if (!t || t.orphaned) return;
    clearAutosave(t.id);
    updateTab(t.id, { orphaned: true, orphanAck: false });
  };

  // Save As… for a tab (relocate): the buffer is written to a user-chosen path via
  // a native dialog. On success the tab adopts the new path, stops watching the old
  // (gone) one, and clears its orphaned state; a cancel leaves the tab untouched.
  // Resolves to true only when the relocation actually wrote, so a close chained
  // off it is skipped when the user backs out (preserving the unsaved buffer).
  const saveAsTab = async (id: string): Promise<boolean> => {
    const t = tabById(id);
    if (!t) return false;
    const content = t.text;
    const relocated = await window.galley?.saveFileAs(t.path, content);
    if (!relocated) return false; // user cancelled or the write failed — stay orphaned
    window.galley?.notifyClosed(t.path); // stop watching the old, vanished path
    const latest = tabById(id);
    updateTab(id, {
      path: relocated.path,
      saved: relocated.content,
      dirty: latest ? latest.text !== relocated.content : false,
      orphaned: false,
      orphanAck: false,
      edited: false,
    });
    return true;
  };

  // "Keep open" on the orphaned banner: dismiss the notice but keep the tab and its
  // buffer in memory. The tab stays orphaned (saving is still guarded to Save As),
  // it just stops nagging.
  const dismissOrphanBanner = (id: string) => updateTab(id, { orphanAck: true });

  // Pull a command-line file and subscribe to opens / save / reload / change.
  useEffect(() => {
    void window.galley
      ?.getStartupFiles()
      .then((files) => {
        files.forEach((file) => openTab(file));
        // openTab leaves the LAST-opened tab active; when several files were passed
        // on the command line, re-assert the FIRST (leftmost) as the focused tab. Its
        // own reveal (recorded per-tab by its openTab call) applies on the switch.
        if (files.length > 1) {
          const first = tabsRef.current.find((t) => t.path === files[0].path);
          if (first) switchTo(first.id);
        }
      })
      // After the CLI files are open, ask main whether a prior session should be
      // restored. Non-null only after a dirty shutdown in a claimed
      // project; then offer the restore prompt. Runs AFTER getStartupFiles so the
      // CLI-file behaviour is fully in place either way — restore only ever adds.
      .then(() => window.galley?.getRestore())
      .then((session) => {
        if (session && session.files.length > 0) setRestore(session);
      });
    const offOpen = window.galley?.onOpenFile((file) => openTab(file));
    const offSave = window.galley?.onMenuSave(() => {
      const id = activeIdRef.current;
      const t = tabById(id);
      if (!id || !t) return;
      if (t.conflict) resolveKeepMine();
      else void saveTab(id, { manual: true });
    });
    const offReload = window.galley?.onReloadFile(() => {
      const id = activeIdRef.current;
      const t = tabById(id);
      if (!id || !t) return;
      void window.galley.readFile(t.path).then((file) => {
        if (file && activeIdRef.current === id) reloadTab(id, file);
      });
    });
    const offClose = window.galley?.onCloseTab(() => {
      const id = activeIdRef.current;
      if (id) requestClose(id); // close the active tab (prompts if dirty)
    });
    const offExternal = window.galley?.onExternalChange((diskFile) => {
      const t = tabsRef.current.find((x) => x.path === diskFile.path);
      if (!t) return;
      if (t.orphaned) {
        // A vanished file reappeared at its old path. A clean orphaned tab re-adopts
        // it (un-orphans via reloadTab); one with unsaved edits stays orphaned so the
        // user relocates deliberately, rather than layering a conflict on the gone state.
        if (!t.edited) reloadTab(t.id, diskFile);
        return;
      }
      if (!t.conflict && !t.edited) reloadTab(t.id, diskFile); // in sync → refresh
      else flagDiverged(t.id, diskFile); // edits in progress / already flagged → surface
    });
    const offRemoved = window.galley?.onFileRemoved((path) => markOrphaned(path));
    // Ctrl+Tab / Ctrl+Shift+Tab cycle tabs with wraparound.
    const cycle = (direction: CycleDirection) => {
      const target = cycleTabTarget(
        tabsRef.current.map((t) => t.id),
        activeIdRef.current,
        direction,
      );
      if (target) switchTo(target);
    };
    const offNext = window.galley?.onNextTab(() => cycle('next'));
    const offPrev = window.galley?.onPrevTab(() => cycle('prev'));
    const offHelp = window.galley?.onHelp(() => setShowHelp(true)); // Help window
    return () => {
      offOpen?.();
      offSave?.();
      offReload?.();
      offClose?.();
      offNext?.();
      offPrev?.();
      offExternal?.();
      offRemoved?.();
      offHelp?.();
      for (const timer of autosaveTimers.current.values()) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drag-and-drop file opening: dropping files anywhere on the window opens each
  // as a tab (dedup/focus handled by openTab). Both dragover and drop must
  // preventDefault, or Electron navigates the window to the dropped file and
  // replaces the app. Paths are resolved in the preload (webUtils) since the
  // renderer cannot read File.path; main opens them through the CLI/dialog path.
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const paths = dropPaths(Array.from(files), (file) => window.galley?.getDroppedPath(file) ?? '');
      if (paths.length > 0) window.galley?.openFiles(paths);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  // Restore resolutions. Yes → open each restored file (openTab dedups
  // by path: a file already open from the CLI is focused/kept, never duplicated),
  // then focus the restored active tab. No → start fresh (keep the CLI files /
  // welcome). Either way the dialog is dismissed.
  const acceptRestore = () => {
    const session = restore;
    setRestore(null);
    if (!session) return;
    session.files.forEach((file) => openTab(file));
    const active = session.files[session.activeIndex];
    if (active) {
      const tab = tabsRef.current.find((t) => t.path === active.path);
      if (tab) switchTo(tab.id);
    }
  };
  const dismissRestore = () => setRestore(null);

  // Cmd/Ctrl+K (the link dialog): snapshot the link context at the cursor, then open the dialog.
  const openLinkDialog = () => {
    const ctx = activeView()?.requestLink() ?? null;
    if (ctx) setLinkCtx(ctx);
  };

  const toggleSource = () => {
    const next: ViewMode = showingSource ? 'preview' : 'split';
    setViewMode(next);
    void window.galley?.setSourceVisible(next === 'split'); // widen/shrink window (split view & Show/Hide Source)
  };

  // Apply a pending reveal to the now-active tab's preview once it is visible —
  // either a #fragment (a file link jumps to that heading; no match → the top) or a
  // target line (open at a specific line). This is also when a freshly opened tab
  // first renders, so a new file reveals its line here. The active TabView keeps
  // its own reading position when nothing is pending, so there is nothing else to
  // restore on a switch.
  useEffect(() => {
    const frag = pendingFragment.current;
    pendingFragment.current = null;
    if (frag) {
      const view = activeView();
      if (view && !view.jumpToFragment(frag)) view.scrollPreviewTop();
      return;
    }
    // Apply the now-active tab's own pending reveal (if any). Keyed per-tab, so the
    // line applied is always the one addressed to THIS file.
    if (activeId) applyReveal(activeId);
  }, [activeId]);

  // Report the open-tab set to main so it can persist the session as a crash
  // safety net. Fires on open/close/switch/reorder — anything that
  // changes the open paths in order or which one is active. The welcome sandbox
  // has no path and is excluded; an empty tab set reports `files: []`. Main
  // debounces the write and no-ops in projectless mode. Mirrors setActiveDocPath.
  //
  // Keyed on an order-sensitive signature of the open paths plus the active id, so
  // it re-runs on any open/close/reorder/switch but not on unrelated per-tab edits.
  const sessionSignature = JSON.stringify({ paths: tabs.map((t) => t.path), activeId });
  useEffect(() => {
    const { paths, activeId: active } = JSON.parse(sessionSignature) as {
      paths: string[];
      activeId: string | null;
    };
    // paths and activeId came from the same render's `tabs`, so the active tab's
    // slot is its position in that ordered path list (paths are unique per tab).
    const activeIndex = active === null ? -1 : paths.indexOf(tabById(active)?.path ?? '\0');
    window.galley?.setSession({ files: paths, activeIndex });
  }, [sessionSignature]);

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const conflict = activeTab?.conflict ?? null;
  const showModal = activeTab?.showModal ?? false;
  // The active tab's file was moved/deleted and the banner hasn't been dismissed.
  const showOrphanBanner = (activeTab?.orphaned ?? false) && !(activeTab?.orphanAck ?? false);

  // The OS window title carries the active file name, then the project name, then
  // the app — the in-app title line was removed in favour of the single
  // toolbar row. The project name is a per-window constant, so it need not be an
  // effect dependency: file (project) Galley, dropping any null parts.
  const activePath = activeTab?.path;
  useEffect(() => {
    const project = window.galley?.projectName ?? null;
    const file = activePath ? basename(activePath) : null;
    document.title = [file, project, 'Galley'].filter(Boolean).join(' — ');
    // Mirror the active path to main so Export to PDF defaults beside the source.
    // null on the welcome screen.
    window.galley?.setActiveDocPath(activePath ?? null);
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
            onReorder={reorder}
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
      {/* Out-of-sync notice sits just below the tab bar (passive flag). Suppressed
          when the file is gone — the orphaned banner below takes precedence. */}
      {conflict && !showModal && !showOrphanBanner && (
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
      {/* File gone: a passive per-tab banner (never a modal), preserving the buffer
          and offering the safe choices — relocate, keep in memory, or close. */}
      {showOrphanBanner && activeTab && (
        <div className="sync-flag orphan-flag" role="status">
          <span className="sync-flag-dot" aria-hidden="true">●</span>
          <span className="sync-flag-text">
            <strong>{basename(activeTab.path)}</strong> was moved or deleted on disk
          </span>
          <button type="button" className="sync-flag-btn" onClick={() => void saveAsTab(activeTab.id)}>
            Save As…
          </button>
          <button type="button" className="sync-flag-btn" onClick={() => dismissOrphanBanner(activeTab.id)}>
            Keep open
          </button>
          <button type="button" className="sync-flag-btn" onClick={() => requestClose(activeTab.id)}>
            Close
          </button>
        </div>
      )}
      {/* One TabView per open tab plus the welcome sandbox; all stay mounted, only
          the active one is visible (the rest are display:none). A local link is
          resolved against the active file's folder (host side). */}
      {tabs.map((t) => (
        <TabView
          key={t.id}
          ref={(h) => viewRefs.current.set(t.id, h)}
          initialText={t.text}
          text={t.text}
          docVersion={t.docVersion}
          viewMode={viewMode}
          hidden={t.id !== activeId}
          onSourceChange={(next) => onSourceChange(t.id, next)}
          onLink={openLinkDialog}
          onOpenLocal={(href) => onOpenLocalLink(href, t.path)}
        />
      ))}
      {/* The welcome sandbox: editable but ephemeral, shown only when no tab is
          open (empty state). Mounted/unmounted with the empty state rather than kept
          hidden behind open tabs — its buffer lives in App's welcomeText, so it
          re-seeds from there each time, and not rendering it while tabs are open
          keeps exactly ONE editor/preview pair in the DOM at a time. */}
      {activeId === null && (
        <TabView
          key={WELCOME_ID}
          ref={(h) => viewRefs.current.set(WELCOME_ID, h)}
          initialText={welcomeText}
          text={welcomeText}
          docVersion={0}
          viewMode={viewMode}
          hidden={false}
          onSourceChange={(next) => onSourceChange(WELCOME_ID, next)}
          onLink={openLinkDialog}
        />
      )}
      {showHelp && (
        <HelpDialog
          version={window.galley?.version ?? '0.0.0'}
          platform={window.galley?.platform ?? 'unknown'}
          onClose={() => setShowHelp(false)}
        />
      )}
      {restore && <RestoreDialog onRestore={acceptRestore} onDismiss={dismissRestore} />}
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
            // Close only once the save actually persisted — if this is an orphaned
            // tab and the user cancels the Save As dialog, keep the tab (and its
            // unsaved buffer) open rather than discarding it on close.
            void saveTab(id, { manual: true }).then((saved) => {
              if (saved) closeTab(id);
            });
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
            activeView()?.applyLink(t, u);
            setLinkCtx(null);
          }}
          onRemove={() => {
            activeView()?.removeLink();
            setLinkCtx(null);
          }}
          onCancel={() => setLinkCtx(null)}
        />
      )}
    </div>
  );

  // Resolve a clicked local link against the active file's folder (host side); a
  // local link only makes sense when a real file is open. Remember a #fragment so
  // we can jump to it once the target tab opens/activates.
  function onOpenLocalLink(href: string, fromPath: string) {
    const hash = href.indexOf('#');
    pendingFragment.current = hash >= 0 ? decodeURIComponent(href.slice(hash + 1)) || null : null;
    window.galley?.openLocalFile(href, fromPath);
  }
}

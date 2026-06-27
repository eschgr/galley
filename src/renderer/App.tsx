/**
 * Root component. Owns the open tabs and the view-mode switch, and hosts a
 * per-tab split editor/preview view (PRD R45, #26).
 *
 * Tabs (R39): each open file is a tab with its own buffer, baseline, dirty state,
 * and conflict state. As of #26 each open tab also renders its OWN self-contained
 * TabView (its own CodeMirror editor + preview + split layout + scroll-sync). All
 * open tabs' TabViews stay mounted; only the active one is visible (the rest are
 * display:none). Switching tabs just changes which one is visible — no re-parse,
 * no DOM rebuild, no editor/preview state-swap. When no tab is open a dedicated
 * welcome TabView shows the built-in sandbox (R46 empty state), editable but
 * ephemeral.
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
import { HelpDialog } from './components/HelpDialog';
import type { LinkContext } from './components/Editor';
import type { OpenedFile } from '../shared/api';
import { cycleTabTarget, type CycleDirection } from './cycleTab';

// R29: save 5s after the last keystroke. A test seam lets e2e tests shorten it.
const AUTOSAVE_MS =
  Number((window as unknown as { __galleyAutosaveMs?: number }).__galleyAutosaveMs) || 5000;

// The welcome sandbox is rendered as a dedicated, always-present TabView keyed
// here, so the empty state owns a real editor/preview pair like any open tab.
const WELCOME_ID = '__welcome__';

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** One open document (R39). The buffer (`text`) is the source of truth; `saved`
 *  is the last loaded/saved baseline. `conflict`/`noticed`/`showModal`/`edited`
 *  carry the per-tab out-of-sync state (R34–R36). `docVersion` is bumped on a
 *  reload-from-disk so the tab's editor re-seeds (it never changes on an edit). */
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
  const [showHelp, setShowHelp] = useState(false); // Help window (R48)

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

  // Load disk content into a tab (open, reload, or silent refresh). Resets the tab
  // to a clean, in-sync baseline and bumps `docVersion` so the tab's TabView
  // re-seeds its editor from the new text (keeping the reading line, R31a).
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
      docVersion: 0,
    };
    commitTabs([...tabsRef.current, tab]);
    setActive(id);
  };

  const closeTab = (id: string) => {
    const idx = tabsRef.current.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const t = tabsRef.current[idx];
    window.mdtool?.notifyClosed(t.path); // R41: stop watching its file
    clearAutosave(id);
    viewRefs.current.delete(id);
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

  // #20: drag-reorder the tab strip. Reorders the array only — activeId is an id,
  // not an index, so the active tab stays active and simply moves to its new slot.
  const reorder = (draggedId: string, insertIndex: number) => {
    commitTabs(reorderToIndex(tabsRef.current, draggedId, insertIndex));
  };

  // R41: closing a tab with unsaved edits prompts first.
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
    void window.mdtool?.getStartupFiles().then((files) => {
      files.forEach((file) => openTab(file));
      // openTab leaves the LAST-opened tab active; when several files were passed
      // on the command line, re-assert the FIRST (leftmost) as the focused tab.
      if (files.length > 1) {
        const first = tabsRef.current.find((t) => t.path === files[0].path);
        if (first) switchTo(first.id);
      }
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
    const offClose = window.mdtool?.onCloseTab(() => {
      const id = activeIdRef.current;
      if (id) requestClose(id); // close the active tab (prompts if dirty; R41)
    });
    const offExternal = window.mdtool?.onExternalChange((diskFile) => {
      const t = tabsRef.current.find((x) => x.path === diskFile.path);
      if (!t) return;
      if (!t.conflict && !t.edited) reloadTab(t.id, diskFile); // in sync → refresh
      else flagDiverged(t.id, diskFile); // edits in progress / already flagged → surface
    });
    // Ctrl+Tab / Ctrl+Shift+Tab cycle tabs with wraparound (#19).
    const cycle = (direction: CycleDirection) => {
      const target = cycleTabTarget(
        tabsRef.current.map((t) => t.id),
        activeIdRef.current,
        direction,
      );
      if (target) switchTo(target);
    };
    const offNext = window.mdtool?.onNextTab(() => cycle('next'));
    const offPrev = window.mdtool?.onPrevTab(() => cycle('prev'));
    const offHelp = window.mdtool?.onHelp(() => setShowHelp(true)); // R48
    return () => {
      offOpen?.();
      offSave?.();
      offReload?.();
      offClose?.();
      offNext?.();
      offPrev?.();
      offExternal?.();
      offHelp?.();
      for (const timer of autosaveTimers.current.values()) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cmd/Ctrl+K (R27): snapshot the link context at the cursor, then open the dialog.
  const openLinkDialog = () => {
    const ctx = activeView()?.requestLink() ?? null;
    if (ctx) setLinkCtx(ctx);
  };

  const toggleSource = () => {
    const next: ViewMode = showingSource ? 'preview' : 'split';
    setViewMode(next);
    void window.mdtool?.setSourceVisible(next === 'split'); // widen/shrink window (R45)
  };

  // Apply a pending #fragment to the now-active tab's preview once it is visible
  // (a file link with a #fragment jumps to that heading; no match → the top). The
  // active TabView keeps its own reading position when no fragment is pending, so
  // there is nothing else to restore on a switch.
  useEffect(() => {
    const frag = pendingFragment.current;
    pendingFragment.current = null;
    if (!frag) return;
    const view = activeView();
    if (!view) return;
    if (!view.jumpToFragment(frag)) view.scrollPreviewTop();
  }, [activeId]);

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const conflict = activeTab?.conflict ?? null;
  const showModal = activeTab?.showModal ?? false;

  // The OS window title carries the active file name (the in-app title line was
  // removed in favour of the single toolbar row).
  const activePath = activeTab?.path;
  useEffect(() => {
    document.title = activePath ? `${basename(activePath)} — Galley` : 'Galley';
    // Mirror the active path to main so Export to PDF defaults beside the source
    // (R52). null on the welcome screen.
    window.mdtool?.setActiveDocPath(activePath ?? null);
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
          open (R46). Mounted/unmounted with the empty state rather than kept
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
          version={window.mdtool?.version ?? '0.0.0'}
          platform={window.mdtool?.platform ?? 'unknown'}
          onClose={() => setShowHelp(false)}
        />
      )}
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
    window.mdtool?.openLocalFile(href, fromPath);
  }
}

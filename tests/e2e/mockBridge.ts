import { expect, type Page } from '@playwright/test';
import type { EditorMenuParams, GalleyApi } from '../../src/shared/api';

// The ONE mock main-process bridge shared across the renderer e2e specs. The real
// file IO (read/write/hash, CLI parse) is unit-tested (src/main/platform), and
// full Electron E2E is a later phase; these specs cover the React wiring by driving
// the renderer through this mock `window.galley`, installed before the app loads.
//
// Why a single module: the bridge was hand-rolled and COPIED across spec files, and
// the copies DRIFTED (one missed setActiveDocPath, another onNextTab) — each gap a
// runtime "X is not a function" that crashes <App> on mount and only surfaces in a
// clean-server e2e run. Consolidating here, typed with `satisfies GalleyApi`, turns
// any such gap into a COMPILE error (`npx tsc --noEmit`) instead.

// `line` is the optional one-shot reveal target (open at a specific line) carried
// on the open payload (OpenTarget); most specs omit it.
export type MockFile = { path: string; content: string; hash: string; line?: number };

// The test harness exposed on `window.__mock`: the callback slots the bridge's
// on*() subscriptions fill in, plus the call-log / queued-response state the specs
// read and arm. Kept in sync with the slots/state the specs actually use.
type Harness = {
  openCb: ((f: MockFile) => void) | null;
  saveCb: (() => void) | null;
  extCb: ((f: MockFile) => void) | null;
  removedCb: ((path: string) => void) | null;
  reloadCb: (() => void) | null;
  closeTabCb: (() => void) | null;
  closeFileCb: ((path: string) => void) | null;
  retainCb: ((paths: string[]) => void) | null;
  helpCb: (() => void) | null;
  nextTabCb: (() => void) | null;
  prevTabCb: (() => void) | null;
  saveCalls: { path: string; content: string; force: boolean }[];
  saveAsCalls: { path: string; content: string }[];
  closed: string[];
  // Paths handed to openFiles() by the drag-and-drop open path.
  dropped: string[];
  openExternalCalls: string[];
  openLocalCalls: { href: string; from: string }[];
  // When set, the next non-force save returns this as a write-path conflict.
  nextSaveConflict: MockFile | null;
  // What saveFileAs() (relocate) returns next; null = the user cancelled the dialog.
  nextSaveAs: MockFile | null;
  // What readFile() (reload) returns next.
  nextRead: MockFile | null;
  // What getRestore() returns on mount (#61 slice B). Null = no restore (default);
  // a spec arms it via installMockBridge's `restore` arg or setRestore() below.
  restore: { files: MockFile[]; activeIndex: number } | null;
  // Spell-check (#132): the params each showEditorContextMenu() call was given,
  // the words getDictionaryWords() returns (seed), and the menu-action callback
  // slots the editor subscribes, fired by fireSpellReplace / fireDictionaryWordAdded.
  spellMenuCalls: EditorMenuParams[];
  dictionaryWords: string[];
  spellReplaceCb: ((suggestion: string) => void) | null;
  wordAddedCb: ((word: string) => void) | null;
};

/**
 * Install a COMPLETE `window.galley` mock (typed `satisfies GalleyApi`, so a
 * missing/renamed bridge method is a COMPILE error here rather than a runtime
 * crash) plus the `window.__mock` harness, before the app loads. `startup` is the
 * optional file(s) `getStartupFiles()` returns (R7 command-line open).
 *
 * The addInitScript closure is serialized into the browser, so everything it needs
 * must live INSIDE it — the only outer-scope value it may reference is the
 * serializable `startup` argument.
 */
export async function installMockBridge(
  page: Page,
  startup: MockFile | MockFile[] | null = null,
  restore: { files: MockFile[]; activeIndex: number } | null = null,
  // The claimed project name surfaced as window.galley.projectName (PF24). Fixed
  // for the window's lifetime; null (default) is projectless mode (PF27). Threaded
  // like startup/restore so a spec can arm a named project for the title tests.
  projectName: string | null = null,
  // The persistent custom-dictionary words getDictionaryWords() returns (#132).
  // Threaded like startup/restore so it's armed BEFORE the app loads, since the
  // editor seeds the engine from it as soon as its tab mounts.
  dictionaryWords: string[] = [],
): Promise<void> {
  await page.addInitScript(({ startupArg, restoreArg, projectNameArg, dictionaryWordsArg }) => {
    const startupFiles = Array.isArray(startupArg) ? startupArg : startupArg ? [startupArg] : [];
    const harness: Harness = {
      openCb: null, saveCb: null, extCb: null, removedCb: null, reloadCb: null, closeTabCb: null, helpCb: null,
      closeFileCb: null, retainCb: null,
      nextTabCb: null, prevTabCb: null,
      saveCalls: [], saveAsCalls: [], closed: [], dropped: [], openExternalCalls: [], openLocalCalls: [],
      nextSaveConflict: null, nextSaveAs: null, nextRead: null,
      restore: restoreArg,
      spellMenuCalls: [], dictionaryWords: dictionaryWordsArg, spellReplaceCb: null, wordAddedCb: null,
    };
    (window as unknown as { __mock: typeof harness }).__mock = harness;
    (window as unknown as { galley: unknown }).galley = {
      platform: 'win32',
      version: '0.0.0-test',
      // Per-window static (PF24): the claimed project name, or null projectless.
      projectName: projectNameArg,
      openExternal: async (url: string) => {
        harness.openExternalCalls.push(url);
      },
      openLocalFile: (href: string, from: string) => harness.openLocalCalls.push({ href, from }),
      setSourceVisible: async () => {},
      // App mirrors the active doc path to main (for the Export-to-PDF default) on
      // every tab change; the renderer calls window.galley?.setActiveDocPath(...),
      // and `?.` only guards galley being null — a MISSING method still throws and
      // crashes <App> on mount. So the mock must implement the whole bridge.
      setActiveDocPath: () => {},
      // App reports the open-tab session (files + active) to main on every tab
      // change (#61 slice A). Same rule as above: a missing method crashes <App>.
      setSession: () => {},
      // App pulls the restore session on mount (#61 slice B). Default null (no
      // restore); a spec arms `harness.restore` to make it offer one. Same rule
      // as above: a missing method crashes <App> on mount in a clean-server run.
      getRestore: async () => harness.restore,
      getStartupFiles: async () => startupFiles,
      saveFile: async (path: string, content: string, force?: boolean) => {
        harness.saveCalls.push({ path, content, force: !!force });
        if (!force && harness.nextSaveConflict) {
          const disk = harness.nextSaveConflict;
          harness.nextSaveConflict = null;
          return { conflict: true, disk };
        }
        return { conflict: false, file: { path, content, hash: 'mock-hash' } };
      },
      readFile: async () => harness.nextRead,
      // Save As… (relocate an orphaned tab). Records the call; returns the armed
      // relocated snapshot, or null to simulate the user cancelling the dialog.
      saveFileAs: async (path: string, content: string) => {
        harness.saveAsCalls.push({ path, content });
        return harness.nextSaveAs;
      },
      notifyClosed: (path: string) => harness.closed.push(path),
      // Drag-and-drop open: the renderer resolves each dropped File to a path via
      // getDroppedPath (webUtils in the real preload) then hands them to openFiles.
      // A missing method would crash <App>'s drop effect on mount, so the mock must
      // provide both. The specs that exercise dropping arm/read these via the page.
      getDroppedPath: (file: File) => (file as unknown as { path?: string }).path ?? '',
      openFiles: (paths: string[]) => harness.dropped.push(...paths),
      onOpenFile: (cb: (f: MockFile) => void) => {
        harness.openCb = cb;
        return () => (harness.openCb = null);
      },
      onMenuSave: (cb: () => void) => {
        harness.saveCb = cb;
        return () => (harness.saveCb = null);
      },
      onReloadFile: (cb: () => void) => {
        harness.reloadCb = cb;
        return () => (harness.reloadCb = null);
      },
      onCloseTab: (cb: () => void) => {
        harness.closeTabCb = cb;
        return () => (harness.closeTabCb = null);
      },
      // #19 tab cycling — App subscribes on mount, so the mock must provide these
      // or its startup effect throws. The Ctrl+Tab path (App.cycle -> switchTo) is
      // driven via fireNextTab/firePrevTab below.
      onNextTab: (cb: () => void) => {
        harness.nextTabCb = cb;
        return () => (harness.nextTabCb = null);
      },
      onPrevTab: (cb: () => void) => {
        harness.prevTabCb = cb;
        return () => (harness.prevTabCb = null);
      },
      onHelp: (cb: () => void) => {
        harness.helpCb = cb;
        return () => (harness.helpCb = null);
      },
      onExternalChange: (cb: (f: MockFile) => void) => {
        harness.extCb = cb;
        return () => (harness.extCb = null);
      },
      onCloseFile: (cb: (path: string) => void) => {
        harness.closeFileCb = cb;
        return () => (harness.closeFileCb = null);
      },
      onRetainFiles: (cb: (paths: string[]) => void) => {
        harness.retainCb = cb;
        return () => (harness.retainCb = null);
      },
      onFileRemoved: (cb: (path: string) => void) => {
        harness.removedCb = cb;
        return () => (harness.removedCb = null);
      },
      // Spell-check (#132): record the menu params the editor computes, hand back
      // the seed words, and store the menu-action callbacks for the specs to fire.
      showEditorContextMenu: (params: EditorMenuParams) => harness.spellMenuCalls.push(params),
      getDictionaryWords: async () => harness.dictionaryWords,
      onSpellReplace: (cb: (suggestion: string) => void) => {
        harness.spellReplaceCb = cb;
        return () => (harness.spellReplaceCb = null);
      },
      onDictionaryWordAdded: (cb: (word: string) => void) => {
        harness.wordAddedCb = cb;
        return () => (harness.wordAddedCb = null);
      },
      // `satisfies` makes a missing/renamed bridge method a COMPILE error here,
      // instead of a runtime "X is not a function" crash that only surfaces in a
      // clean-server e2e run (how setActiveDocPath/onNextTab slipped through).
    } satisfies GalleyApi;
  }, { startupArg: startup, restoreArg: restore, projectNameArg: projectName, dictionaryWordsArg: dictionaryWords });
}

/**
 * Open a file through the app's REAL open-file path (the onOpenFile callback the
 * main process fires for CLI/File→Open). A freshly opened doc renders with NO
 * typing and starts at the top — so tests seed fixtures this way rather than typing
 * into the editor (which leaves the editor as the scroll-sync leader and races).
 */
export async function openFile(page: Page, file: MockFile): Promise<void> {
  await page.evaluate(
    (f) => (window as unknown as { __mock: { openCb: (x: MockFile) => void } }).__mock.openCb(f),
    file,
  );
}

// Fire a mock main-process callback (openCb / extCb) with a file. Kept for specs
// that drive both the open and external-change paths with one helper.
export async function fire(page: Page, cb: 'openCb' | 'extCb', file: MockFile): Promise<void> {
  await page.evaluate(
    ([name, f]) =>
      (window as unknown as { __mock: Record<string, (x: MockFile) => void> }).__mock[name as string](
        f as MockFile,
      ),
    [cb, file] as const,
  );
}

/** Fire an external on-disk change (the watcher payload) for the open file (R32/R33). */
export async function fireExternalChange(page: Page, file: MockFile): Promise<void> {
  await fire(page, 'extCb', file);
}

/** Fire a caller `--close <path>` (the channel close verb) for the given path. */
export async function fireCloseFile(page: Page, path: string): Promise<void> {
  await page.evaluate(
    (p) => (window as unknown as { __mock: { closeFileCb: (x: string) => void } }).__mock.closeFileCb(p),
    path,
  );
}

/** Fire a file-removed event (moved/deleted on disk) for the given path — the tab
 *  goes orphaned ("file gone"). */
export async function fireRemoved(page: Page, path: string): Promise<void> {
  await page.evaluate(
    (p) => (window as unknown as { __mock: { removedCb: (x: string) => void } }).__mock.removedCb(p),
    path,
  );
}

/** Fire a caller `--set` retain list (the channel set verb): close every tab NOT
 *  in `paths`. (The members are opened separately via openFile.) */
export async function fireRetain(page: Page, paths: string[]): Promise<void> {
  await page.evaluate(
    (ps) => (window as unknown as { __mock: { retainCb: (x: string[]) => void } }).__mock.retainCb(ps),
    paths,
  );
}

/** Arm what the next Save As… returns: a relocated snapshot, or null to simulate
 *  the user cancelling the dialog. */
export async function setNextSaveAs(page: Page, file: MockFile | null): Promise<void> {
  await page.evaluate(
    (f) => ((window as unknown as { __mock: { nextSaveAs: MockFile | null } }).__mock.nextSaveAs = f),
    file,
  );
}

/** Fire the File → Save menu/accelerator (R30). */
export async function fireMenuSave(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __mock: { saveCb: () => void } }).__mock.saveCb());
}

/** Fire Ctrl+Tab — next tab (right, wrapping) (#19). */
export async function fireNextTab(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { __mock: { nextTabCb: () => void } }).__mock.nextTabCb(),
  );
}

/** Fire Ctrl+Shift+Tab — previous tab (left, wrapping) (#19). */
export async function firePrevTab(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { __mock: { prevTabCb: () => void } }).__mock.prevTabCb(),
  );
}

/** Arm the words getDictionaryWords() returns (the persistent custom dictionary),
 *  so the editor seeds the offline engine with them on mount (#132). Set before
 *  the editor is shown. */
export async function setDictionaryWords(page: Page, words: string[]): Promise<void> {
  await page.evaluate(
    (w) => ((window as unknown as { __mock: { dictionaryWords: string[] } }).__mock.dictionaryWords = w),
    words,
  );
}

/** The params of each showEditorContextMenu() call the editor made (#132). */
export async function getSpellMenuCalls(page: Page): Promise<EditorMenuParams[]> {
  return page.evaluate(
    () => (window as unknown as { __mock: { spellMenuCalls: EditorMenuParams[] } }).__mock.spellMenuCalls,
  );
}

/** Fire the menu's "replace with suggestion" action back to the editor (#132). */
export async function fireSpellReplace(page: Page, suggestion: string): Promise<void> {
  await page.evaluate(
    (s) => (window as unknown as { __mock: { spellReplaceCb: ((x: string) => void) | null } }).__mock.spellReplaceCb?.(s),
    suggestion,
  );
}

/** Fire the menu's "add to dictionary" notification back to the editor (#132). */
export async function fireDictionaryWordAdded(page: Page, word: string): Promise<void> {
  await page.evaluate(
    (w) => (window as unknown as { __mock: { wordAddedCb: ((x: string) => void) | null } }).__mock.wordAddedCb?.(w),
    word,
  );
}

// Re-export so specs can `import { expect } from './mockBridge'` if convenient; not
// required — specs may keep importing from @playwright/test directly.
export { expect };

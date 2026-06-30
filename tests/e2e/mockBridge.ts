import { expect, type Page } from '@playwright/test';
import type { GalleyApi } from '../../src/shared/api';

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

export type MockFile = { path: string; content: string; hash: string };

// The test harness exposed on `window.__mock`: the callback slots the bridge's
// on*() subscriptions fill in, plus the call-log / queued-response state the specs
// read and arm. Kept in sync with the slots/state the specs actually use.
type Harness = {
  openCb: ((f: MockFile) => void) | null;
  saveCb: (() => void) | null;
  extCb: ((f: MockFile) => void) | null;
  reloadCb: (() => void) | null;
  closeTabCb: (() => void) | null;
  helpCb: (() => void) | null;
  nextTabCb: (() => void) | null;
  prevTabCb: (() => void) | null;
  saveCalls: { path: string; content: string; force: boolean }[];
  closed: string[];
  openExternalCalls: string[];
  openLocalCalls: { href: string; from: string }[];
  // When set, the next non-force save returns this as a write-path conflict.
  nextSaveConflict: MockFile | null;
  // What readFile() (reload) returns next.
  nextRead: MockFile | null;
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
): Promise<void> {
  await page.addInitScript((startupArg) => {
    const startupFiles = Array.isArray(startupArg) ? startupArg : startupArg ? [startupArg] : [];
    const harness: Harness = {
      openCb: null, saveCb: null, extCb: null, reloadCb: null, closeTabCb: null, helpCb: null,
      nextTabCb: null, prevTabCb: null,
      saveCalls: [], closed: [], openExternalCalls: [], openLocalCalls: [],
      nextSaveConflict: null, nextRead: null,
    };
    (window as unknown as { __mock: typeof harness }).__mock = harness;
    (window as unknown as { galley: unknown }).galley = {
      platform: 'win32',
      version: '0.0.0-test',
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
      notifyClosed: (path: string) => harness.closed.push(path),
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
      // `satisfies` makes a missing/renamed bridge method a COMPILE error here,
      // instead of a runtime "X is not a function" crash that only surfaces in a
      // clean-server e2e run (how setActiveDocPath/onNextTab slipped through).
    } satisfies GalleyApi;
  }, startup);
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

// Re-export so specs can `import { expect } from './mockBridge'` if convenient; not
// required — specs may keep importing from @playwright/test directly.
export { expect };

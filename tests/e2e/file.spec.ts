import { test, expect, type Page } from '@playwright/test';

// The renderer's open/edit/save flow, driven through a MOCK main-process bridge
// installed before the app loads. The real file IO (read/write/hash, CLI parse)
// is unit-tested (src/main/platform), and full Electron E2E is a later phase;
// this covers the React wiring: load → title/preview, edit → dirty, save →
// write + clear dirty.

type MockFile = { path: string; content: string; hash: string };

async function installMockBridge(page: Page, startup: MockFile | null = null): Promise<void> {
  await page.addInitScript((startupFile) => {
    const harness: {
      openCb: ((f: MockFile) => void) | null;
      saveCb: (() => void) | null;
      extCb: ((f: MockFile) => void) | null;
      reloadCb: (() => void) | null;
      closeTabCb: (() => void) | null;
      saveCalls: { path: string; content: string; force: boolean }[];
      closed: string[];
      // When set, the next non-force save returns this as a write-path conflict.
      nextSaveConflict: MockFile | null;
      // What readFile() (reload) returns next.
      nextRead: MockFile | null;
    } = {
      openCb: null, saveCb: null, extCb: null, reloadCb: null, closeTabCb: null,
      saveCalls: [], closed: [], nextSaveConflict: null, nextRead: null,
    };
    (window as unknown as { __mock: typeof harness }).__mock = harness;
    (window as unknown as { mdtool: unknown }).mdtool = {
      platform: 'win32',
      version: '0.0.0-test',
      openExternal: async () => {},
      setSourceVisible: async () => {},
      getStartupFile: async () => startupFile,
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
      onExternalChange: (cb: (f: MockFile) => void) => {
        harness.extCb = cb;
        return () => (harness.extCb = null);
      },
    };
  }, startup);
}

// Fire a mock main-process callback (openCb / extCb) with a file.
async function fire(page: Page, cb: 'openCb' | 'extCb', file: MockFile): Promise<void> {
  await page.evaluate(
    ([name, f]) =>
      (window as unknown as { __mock: Record<string, (x: MockFile) => void> }).__mock[name as string](
        f as MockFile,
      ),
    [cb, file] as const,
  );
}

// The unsaved-changes dot now lives on the active tab; out-of-sync is a banner.
const dirtyDot = (page: Page) => page.locator('.tab.is-active .tab-dot');
const syncFlag = (page: Page) => page.locator('.sync-flag');
const tabNames = (page: Page) => page.locator('.tab-name');
const activeTabName = (page: Page) => page.locator('.tab.is-active .tab-name');
const noTabs = (page: Page) => page.locator('.tab-strip');

test('loads a command-line file on startup, in a tab (R7/R39)', async ({ page }) => {
  await installMockBridge(page, {
    path: 'C:\\docs\\startup.md',
    content: '# Startup\n\nLoaded at launch.\n',
    hash: 'h',
  });
  await page.goto('/');
  await expect(activeTabName(page)).toHaveText('startup.md');
  await expect(page.locator('.markdown-preview')).toContainText('Loaded at launch');
});

test('the welcome screen shows until a file is opened in a tab (R8/R46)', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  // No file open → welcome sandbox, no tab strip.
  await expect(noTabs(page)).toBeHidden();
  await expect(page.locator('.markdown-preview')).toContainText('Welcome to Galley');

  await page.evaluate(() =>
    (window as unknown as { __mock: { openCb: (f: MockFile) => void } }).__mock.openCb({
      path: 'C:\\docs\\report.md',
      content: '# Report\n\nFresh open.\n',
      hash: 'h',
    }),
  );
  await expect(activeTabName(page)).toHaveText('report.md');
  await expect(page.locator('.markdown-preview')).toContainText('Fresh open');
  await expect(dirtyDot(page)).toBeHidden();
});

test('editing marks the doc dirty; save writes it and clears dirty (R29/R30)', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  await page.evaluate(() =>
    (window as unknown as { __mock: { openCb: (f: MockFile) => void } }).__mock.openCb({
      path: 'C:\\docs\\a.md',
      content: 'original line\n',
      hash: 'h',
    }),
  );

  await page.locator('.source-toggle').click(); // Show Source
  await expect(page.locator('.pane-editor')).toBeVisible();
  await page.locator('.cm-content').click();
  await page.keyboard.type(' EDITED');
  await expect(dirtyDot(page)).toBeVisible();

  // Force-save via the menu/accelerator path.
  await page.evaluate(() =>
    (window as unknown as { __mock: { saveCb: () => void } }).__mock.saveCb(),
  );
  await expect(dirtyDot(page)).toBeHidden();

  const calls = await page.evaluate(
    () => (window as unknown as { __mock: { saveCalls: { path: string; content: string }[] } }).__mock.saveCalls,
  );
  expect(calls.length).toBe(1);
  expect(calls[0].path).toBe('C:\\docs\\a.md');
  expect(calls[0].content).toContain('EDITED');
});

const overlay = (page: Page) => page.locator('.modal-overlay');

async function openAndDirty(page: Page, file: MockFile, typed: string): Promise<void> {
  await fire(page, 'openCb', file);
  await page.locator('.source-toggle').click(); // Show Source
  await expect(page.locator('.pane-editor')).toBeVisible();
  await page.locator('.cm-content').click();
  await page.keyboard.type(typed);
  await expect(dirtyDot(page)).toBeVisible();
}

test('external change with a clean buffer refreshes silently (R35)', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  await fire(page, 'openCb', { path: 'C:\\docs\\a.md', content: '# A\n\nfirst version.\n', hash: 'h1' });
  await expect(page.locator('.markdown-preview')).toContainText('first version');

  await fire(page, 'extCb', { path: 'C:\\docs\\a.md', content: '# A\n\nrefreshed from disk.\n', hash: 'h2' });
  await expect(page.locator('.markdown-preview')).toContainText('refreshed from disk');
  await expect(overlay(page)).toBeHidden(); // no prompt — buffer was clean
  await expect(dirtyDot(page)).toBeHidden();
});

test('external change with unsaved edits prompts; Load from disk discards them (R35)', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  await openAndDirty(page, { path: 'C:\\docs\\b.md', content: 'original\n', hash: 'h' }, ' MY EDIT');

  await fire(page, 'extCb', { path: 'C:\\docs\\b.md', content: 'DISK VERSION\n', hash: 'h2' });
  await expect(overlay(page)).toBeVisible();
  await expect(page.locator('.modal')).toContainText('b.md');

  await page.getByRole('button', { name: /Load from disk/ }).click();
  await expect(overlay(page)).toBeHidden();
  await expect(page.locator('.markdown-preview')).toContainText('DISK VERSION');
  await expect(dirtyDot(page)).toBeHidden();
});

test('conflict → Keep mine overwrites the disk version (R35)', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  await openAndDirty(page, { path: 'C:\\docs\\c.md', content: 'original\n', hash: 'h' }, ' MINE');

  await fire(page, 'extCb', { path: 'C:\\docs\\c.md', content: 'theirs\n', hash: 'h2' });
  await expect(overlay(page)).toBeVisible();

  await page.getByRole('button', { name: /Keep mine/ }).click();
  await expect(overlay(page)).toBeHidden();
  await expect(dirtyDot(page)).toBeHidden();

  const calls = await page.evaluate(
    () => (window as unknown as { __mock: { saveCalls: { path: string; content: string }[] } }).__mock.saveCalls,
  );
  expect(calls[calls.length - 1].path).toBe('C:\\docs\\c.md');
  expect(calls[calls.length - 1].content).toContain('MINE');
});

test('after Keep mine, a further external change re-raises quietly — never a silent load (R36)', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  await openAndDirty(page, { path: 'C:\\docs\\k.md', content: 'orig\n', hash: 'h' }, ' MINE');

  await fire(page, 'extCb', { path: 'C:\\docs\\k.md', content: 'theirs\n', hash: 'h2' });
  await page.getByRole('button', { name: /Keep mine/ }).click();
  await expect(overlay(page)).toBeHidden();
  await expect(page.locator('.markdown-preview')).toContainText('MINE');

  // The writer didn't stop: another external change lands. My version must not
  // be silently replaced — but having already seen the loud modal, the notice
  // recurs as the passive flag, not a second modal.
  await fire(page, 'extCb', { path: 'C:\\docs\\k.md', content: 'theirs again\n', hash: 'h3' });
  await expect(page.locator('.sync-flag')).toBeVisible();
  await expect(overlay(page)).toBeHidden();
  await expect(page.locator('.markdown-preview')).not.toContainText('theirs again');
  await expect(page.locator('.markdown-preview')).toContainText('MINE');
});

const menuSave = (page: Page) =>
  page.evaluate(() => (window as unknown as { __mock: { saveCb: () => void } }).__mock.saveCb());

test('a save that finds disk diverged prompts (write-path guard, R34)', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  await openAndDirty(page, { path: 'C:\\docs\\w.md', content: 'orig\n', hash: 'h' }, ' EDIT');

  // Arm a write-path conflict for the next checked (non-force) save, then save.
  await page.evaluate(() => {
    (window as unknown as { __mock: { nextSaveConflict: MockFile } }).__mock.nextSaveConflict = {
      path: 'C:\\docs\\w.md',
      content: 'changed underneath\n',
      hash: 'h2',
    };
  });
  await menuSave(page);
  await expect(overlay(page)).toBeVisible();
  await expect(page.locator('.modal')).toContainText('w.md');
});

test('the loud modal pops only once; repeated divergence stays on the passive flag (R36)', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  await openAndDirty(page, { path: 'C:\\docs\\s.md', content: 'orig\n', hash: 'h' }, ' MINE');

  await fire(page, 'extCb', { path: 'C:\\docs\\s.md', content: 'theirs one\n', hash: 'h2' });
  await expect(overlay(page)).toBeVisible();
  await page.getByRole('button', { name: /Keep mine/ }).click(); // resolve once
  await expect(overlay(page)).toBeHidden();

  // The writer keeps going. Each further change recurs as the passive flag —
  // never another modal — and never silently replaces my version.
  for (const v of ['theirs two', 'theirs three', 'theirs four']) {
    await fire(page, 'extCb', { path: 'C:\\docs\\s.md', content: `${v}\n`, hash: v });
    await expect(page.locator('.sync-flag')).toBeVisible();
    await expect(overlay(page)).toBeHidden();
    await expect(page.locator('.markdown-preview')).not.toContainText(v);
  }
  await expect(page.locator('.markdown-preview')).toContainText('MINE');
});

test('Ctrl+S while flagged keeps mine; Load from disk re-arms the loud modal (R36)', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  await openAndDirty(page, { path: 'C:\\docs\\e.md', content: 'orig\n', hash: 'h' }, ' MINE');

  await fire(page, 'extCb', { path: 'C:\\docs\\e.md', content: 'theirs\n', hash: 'h2' });
  await page.getByRole('button', { name: /Keep mine/ }).click();

  // A recurrence brings up the passive flag; Ctrl+S there = keep mine, clears it.
  await fire(page, 'extCb', { path: 'C:\\docs\\e.md', content: 'theirs two\n', hash: 'h3' });
  await expect(page.locator('.sync-flag')).toBeVisible();
  await menuSave(page);
  await expect(page.locator('.sync-flag')).toBeHidden();

  // Another recurrence → passive flag; Reload takes theirs and fully reconciles.
  await fire(page, 'extCb', { path: 'C:\\docs\\e.md', content: 'theirs three\n', hash: 'h4' });
  await expect(page.locator('.sync-flag')).toBeVisible();
  await page.getByRole('button', { name: /Reload/ }).click();
  await expect(page.locator('.sync-flag')).toBeHidden();
  await expect(page.locator('.markdown-preview')).toContainText('theirs three');

  // Having reconciled, a brand-new divergence is loud again.
  await page.locator('.cm-content').click();
  await page.keyboard.type(' AGAIN');
  await fire(page, 'extCb', { path: 'C:\\docs\\e.md', content: 'theirs four\n', hash: 'h5' });
  await expect(overlay(page)).toBeVisible();
});

test('auto-save is suspended while out of sync (R36)', async ({ page }) => {
  await installMockBridge(page);
  await page.addInitScript(() => {
    (window as unknown as { __galleyAutosaveMs: number }).__galleyAutosaveMs = 120;
  });
  await page.goto('/');
  await fire(page, 'openCb', { path: 'C:\\docs\\p.md', content: 'orig\n', hash: 'h' });

  await page.locator('.source-toggle').click();
  await expect(page.locator('.pane-editor')).toBeVisible();
  await page.locator('.cm-content').click();
  await page.keyboard.type(' FIRST');
  await expect(dirtyDot(page)).toBeHidden(); // first auto-save fired

  // Go out of sync (loud modal), keep mine, then a recurrence → passive flag.
  await fire(page, 'extCb', { path: 'C:\\docs\\p.md', content: 'theirs\n', hash: 'h2' });
  await page.getByRole('button', { name: /Keep mine/ }).click();
  await fire(page, 'extCb', { path: 'C:\\docs\\p.md', content: 'theirs two\n', hash: 'h3' });
  await expect(page.locator('.sync-flag')).toBeVisible();
  const before = await page.evaluate(
    () => (window as unknown as { __mock: { saveCalls: unknown[] } }).__mock.saveCalls.length,
  );
  await page.locator('.cm-content').click();
  await page.keyboard.type(' MORE WORK');
  await page.waitForTimeout(300); // well past the 120ms debounce
  const after = await page.evaluate(
    () => (window as unknown as { __mock: { saveCalls: unknown[] } }).__mock.saveCalls.length,
  );
  expect(after).toBe(before); // no auto-save while flagged
});

test('auto-save does not let an external change silently discard edits (R36)', async ({ page }) => {
  await installMockBridge(page);
  await page.addInitScript(() => {
    (window as unknown as { __galleyAutosaveMs: number }).__galleyAutosaveMs = 120; // fast auto-save
  });
  await page.goto('/');
  await fire(page, 'openCb', { path: 'C:\\docs\\d.md', content: 'orig\n', hash: 'h' });

  await page.locator('.source-toggle').click();
  await expect(page.locator('.pane-editor')).toBeVisible();
  await page.locator('.cm-content').click();
  await page.keyboard.type(' MY WORK');
  await expect(dirtyDot(page)).toBeVisible();
  await expect(dirtyDot(page)).toBeHidden(); // auto-save fired → buffer clean again

  // Even though the buffer is clean, the user has work in progress — an external
  // change must prompt, not silently refresh over their edit.
  await fire(page, 'extCb', { path: 'C:\\docs\\d.md', content: 'theirs\n', hash: 'h2' });
  await expect(overlay(page)).toBeVisible();
  await expect(page.locator('.markdown-preview')).not.toContainText('theirs');
});

const tabByName = (page: Page, name: string) => page.locator('.tab', { hasText: name });

test('the toolbar is the same height with or without open tabs', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  const toolbarHeight = () =>
    page.evaluate(() => Math.round(document.querySelector('.toolbar')!.getBoundingClientRect().height));
  const empty = await toolbarHeight();
  await fire(page, 'openCb', { path: 'C:\\docs\\a.md', content: 'x\n', hash: 'h' });
  expect(await toolbarHeight()).toBe(empty);
});

test('opens multiple files in tabs and switches between them (R39)', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  await fire(page, 'openCb', { path: 'C:\\docs\\a.md', content: '# Doc A\n', hash: 'h' });
  await fire(page, 'openCb', { path: 'C:\\docs\\b.md', content: '# Doc B\n', hash: 'h' });
  await expect(tabNames(page)).toHaveText(['a.md', 'b.md']);
  await expect(activeTabName(page)).toHaveText('b.md');
  await expect(page.locator('.markdown-preview')).toContainText('Doc B');

  await tabByName(page, 'a.md').locator('.tab-label').click();
  await expect(activeTabName(page)).toHaveText('a.md');
  await expect(page.locator('.markdown-preview')).toContainText('Doc A');
});

test('reopening an already-open file focuses its tab — no duplicate (R39)', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  await fire(page, 'openCb', { path: 'C:\\docs\\a.md', content: '# Doc A\n', hash: 'h' });
  await fire(page, 'openCb', { path: 'C:\\docs\\b.md', content: '# Doc B\n', hash: 'h' });
  await fire(page, 'openCb', { path: 'C:\\docs\\a.md', content: '# Doc A\n', hash: 'h' });
  await expect(tabNames(page)).toHaveText(['a.md', 'b.md']); // still two
  await expect(activeTabName(page)).toHaveText('a.md'); // focused
});

test('per-tab dirty indicator marks only the edited tab (R40)', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  await fire(page, 'openCb', { path: 'C:\\docs\\a.md', content: 'aaa\n', hash: 'h' });
  await fire(page, 'openCb', { path: 'C:\\docs\\b.md', content: 'bbb\n', hash: 'h' }); // active b
  await page.locator('.source-toggle').click();
  await expect(page.locator('.pane-editor')).toBeVisible();
  await page.locator('.cm-content').click();
  await page.keyboard.type(' EDIT');
  await expect(tabByName(page, 'b.md').locator('.tab-dot')).toBeVisible();
  await expect(tabByName(page, 'a.md').locator('.tab-dot')).toBeHidden();
});

test('closing a clean tab removes it and keeps a neighbor active (R41)', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  await fire(page, 'openCb', { path: 'C:\\docs\\a.md', content: 'a\n', hash: 'h' });
  await fire(page, 'openCb', { path: 'C:\\docs\\b.md', content: 'b\n', hash: 'h' });
  await fire(page, 'openCb', { path: 'C:\\docs\\c.md', content: 'c\n', hash: 'h' }); // active c
  await tabByName(page, 'b.md').locator('.tab-close').click();
  await expect(tabNames(page)).toHaveText(['a.md', 'c.md']);
  await expect(activeTabName(page)).toHaveText('c.md'); // closing a background tab keeps active
  await page.locator('.tab.is-active .tab-close').click(); // close active c
  await expect(tabNames(page)).toHaveText(['a.md']);
  await expect(activeTabName(page)).toHaveText('a.md');
});

test('closing the last tab returns to the welcome screen (R46)', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  await fire(page, 'openCb', { path: 'C:\\docs\\only.md', content: '# Only\n', hash: 'h' });
  await page.locator('.tab.is-active .tab-close').click();
  await expect(noTabs(page)).toBeHidden();
  await expect(page.locator('.markdown-preview')).toContainText('Welcome to Galley');
});

test('closing a tab with unsaved edits prompts; Save closes and writes (R41)', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  await openAndDirty(page, { path: 'C:\\docs\\w.md', content: 'orig\n', hash: 'h' }, ' EDIT');
  await page.locator('.tab.is-active .tab-close').click();
  await expect(overlay(page)).toBeVisible();
  await expect(page.locator('.modal')).toContainText('w.md');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.tab-strip')).toBeHidden(); // closed → welcome
  const calls = await page.evaluate(
    () => (window as unknown as { __mock: { saveCalls: { content: string }[] } }).__mock.saveCalls,
  );
  expect(calls.some((c) => c.content.includes('EDIT'))).toBe(true);
});

// Drive the File → Close Tab menu item (Ctrl/Cmd+W), which posts to the renderer.
const closeViaMenu = (page: Page) =>
  page.evaluate(() => (window as unknown as { __mock: { closeTabCb: () => void } }).__mock.closeTabCb());

test('Ctrl+W closes the active tab (not the window); last tab → welcome (R41/R46)', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  await fire(page, 'openCb', { path: 'C:\\docs\\a.md', content: 'a\n', hash: 'h' });
  await fire(page, 'openCb', { path: 'C:\\docs\\b.md', content: 'b\n', hash: 'h' }); // active b
  await closeViaMenu(page);
  await expect(tabNames(page)).toHaveText(['a.md']);
  await expect(activeTabName(page)).toHaveText('a.md');
  await closeViaMenu(page); // last tab → welcome, app stays
  await expect(noTabs(page)).toBeHidden();
  await expect(page.locator('.markdown-preview')).toContainText('Welcome to Galley');
});

test('Ctrl+W on a tab with unsaved edits prompts first (R41)', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  await openAndDirty(page, { path: 'C:\\docs\\w.md', content: 'orig\n', hash: 'h' }, ' EDIT');
  await closeViaMenu(page);
  await expect(overlay(page)).toBeVisible();
  await expect(page.locator('.modal')).toContainText('w.md');
});

test('close prompt — Discard closes without saving; Cancel keeps the tab (R41)', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  await openAndDirty(page, { path: 'C:\\docs\\w.md', content: 'orig\n', hash: 'h' }, ' EDIT');

  await page.locator('.tab.is-active .tab-close').click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(activeTabName(page)).toHaveText('w.md'); // still open

  await page.locator('.tab.is-active .tab-close').click();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.locator('.tab-strip')).toBeHidden();
  const calls = await page.evaluate(
    () => (window as unknown as { __mock: { saveCalls: unknown[] } }).__mock.saveCalls,
  );
  expect(calls.length).toBe(0); // nothing written (auto-save's 5s never fired)
});

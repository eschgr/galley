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
      saveCalls: { path: string; content: string; force: boolean }[];
      // When set, the next non-force save returns this as a write-path conflict.
      nextSaveConflict: MockFile | null;
    } = { openCb: null, saveCb: null, extCb: null, saveCalls: [], nextSaveConflict: null };
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
      onOpenFile: (cb: (f: MockFile) => void) => {
        harness.openCb = cb;
        return () => (harness.openCb = null);
      },
      onMenuSave: (cb: () => void) => {
        harness.saveCb = cb;
        return () => (harness.saveCb = null);
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

const subtitle = (page: Page) => page.locator('.app-subtitle');
const dirtyDot = (page: Page) => page.locator('.app-subtitle .dirty-dot');

test('loads a command-line file on startup (R7)', async ({ page }) => {
  await installMockBridge(page, {
    path: 'C:\\docs\\startup.md',
    content: '# Startup\n\nLoaded at launch.\n',
    hash: 'h',
  });
  await page.goto('/');
  await expect(subtitle(page)).toContainText('startup.md');
  await expect(page.locator('.markdown-preview')).toContainText('Loaded at launch');
});

test('File → Open replaces the document and updates the title bar (R8)', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  await expect(subtitle(page)).toContainText('welcome.md');

  await page.evaluate(() =>
    (window as unknown as { __mock: { openCb: (f: MockFile) => void } }).__mock.openCb({
      path: 'C:\\docs\\report.md',
      content: '# Report\n\nFresh open.\n',
      hash: 'h',
    }),
  );
  await expect(subtitle(page)).toContainText('report.md');
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

test('conflict → Keep my changes overwrites the disk version (R35)', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  await openAndDirty(page, { path: 'C:\\docs\\c.md', content: 'original\n', hash: 'h' }, ' MINE');

  await fire(page, 'extCb', { path: 'C:\\docs\\c.md', content: 'theirs\n', hash: 'h2' });
  await expect(overlay(page)).toBeVisible();

  await page.getByRole('button', { name: /Keep my changes/ }).click();
  await expect(overlay(page)).toBeHidden();
  await expect(dirtyDot(page)).toBeHidden();

  const calls = await page.evaluate(
    () => (window as unknown as { __mock: { saveCalls: { path: string; content: string }[] } }).__mock.saveCalls,
  );
  expect(calls[calls.length - 1].path).toBe('C:\\docs\\c.md');
  expect(calls[calls.length - 1].content).toContain('MINE');
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

test('Keep editing collapses the modal to a passive flag; later changes do not re-pop it (R36)', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  await openAndDirty(page, { path: 'C:\\docs\\s.md', content: 'orig\n', hash: 'h' }, ' MINE');

  await fire(page, 'extCb', { path: 'C:\\docs\\s.md', content: 'theirs one\n', hash: 'h2' });
  await page.getByRole('button', { name: /Keep editing/ }).click();
  await expect(overlay(page)).toBeHidden();
  await expect(subtitle(page)).toContainText('out of sync');
  await expect(page.locator('.sync-flag')).toBeVisible(); // passive flag remains

  // A second external change must NOT re-pop the modal, and must not replace my version.
  await fire(page, 'extCb', { path: 'C:\\docs\\s.md', content: 'theirs two\n', hash: 'h3' });
  await page.waitForTimeout(150);
  await expect(overlay(page)).toBeHidden();
  await expect(page.locator('.sync-flag')).toBeVisible();
  await expect(page.locator('.markdown-preview')).not.toContainText('theirs two');
});

test('Ctrl+S while flagged keeps mine and clears the flag; a later change pops again (R36)', async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
  await openAndDirty(page, { path: 'C:\\docs\\e.md', content: 'orig\n', hash: 'h' }, ' MINE');

  await fire(page, 'extCb', { path: 'C:\\docs\\e.md', content: 'theirs\n', hash: 'h2' });
  await page.getByRole('button', { name: /Keep editing/ }).click();
  await expect(subtitle(page)).toContainText('out of sync');

  await menuSave(page); // Ctrl+S while flagged = keep mine; clears the flag
  await expect(page.locator('.sync-flag')).toBeHidden();
  await expect(subtitle(page)).not.toContainText('out of sync');

  // Editing again + a fresh external change pops the notice once more.
  await page.locator('.cm-content').click();
  await page.keyboard.type(' MORE');
  await fire(page, 'extCb', { path: 'C:\\docs\\e.md', content: 'theirs again\n', hash: 'h4' });
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

  // Go out of sync, then keep editing — auto-save must not write again.
  await fire(page, 'extCb', { path: 'C:\\docs\\p.md', content: 'theirs\n', hash: 'h2' });
  await page.getByRole('button', { name: /Keep editing/ }).click();
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

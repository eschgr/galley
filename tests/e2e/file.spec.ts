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
      saveCalls: { path: string; content: string }[];
    } = { openCb: null, saveCb: null, saveCalls: [] };
    (window as unknown as { __mock: typeof harness }).__mock = harness;
    (window as unknown as { mdtool: unknown }).mdtool = {
      platform: 'win32',
      version: '0.0.0-test',
      openExternal: async () => {},
      setSourceVisible: async () => {},
      getStartupFile: async () => startupFile,
      saveFile: async (path: string, content: string) => {
        harness.saveCalls.push({ path, content });
        return { path, content, hash: 'mock-hash' };
      },
      onOpenFile: (cb: (f: MockFile) => void) => {
        harness.openCb = cb;
        return () => (harness.openCb = null);
      },
      onMenuSave: (cb: () => void) => {
        harness.saveCb = cb;
        return () => (harness.saveCb = null);
      },
    };
  }, startup);
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

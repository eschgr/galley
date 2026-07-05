import { test, expect, type Page } from '@playwright/test';
import {
  installMockBridge,
  fireRemoved,
  fireMenuSave,
  setNextSaveAs,
  type MockFile,
} from './mockBridge';

// A file open in a tab is moved or deleted on disk (#58 "file gone"). The tab is
// marked orphaned with a passive banner (never a modal), the buffer is preserved,
// saving is guarded to Save As, and a bulk removal doesn't storm with dialogs. The
// platform-side removal detection is unit-tested (watcher.test.ts); this covers the
// renderer's reaction through the mock bridge.

const VIS = '.tab-view:not([hidden])';
const activePreview = (page: Page) => page.locator(`${VIS} .markdown-preview`);
const dirtyDot = (page: Page) => page.locator('.tab.is-active .tab-dot');
const orphanBanner = (page: Page) => page.locator('.orphan-flag');
const activeTabName = (page: Page) => page.locator('.tab.is-active .tab-name');

const file = (over: Partial<MockFile> = {}): MockFile => ({
  path: 'C:\\docs\\report.md',
  content: '# Report\n\nbody text.\n',
  hash: 'h',
  ...over,
});

test('an open file removed on disk surfaces a passive orphaned banner (#58)', async ({ page }) => {
  await installMockBridge(page, file());
  await page.goto('/');
  await expect(activePreview(page)).toContainText('body text');

  await fireRemoved(page, 'C:\\docs\\report.md');

  await expect(orphanBanner(page)).toBeVisible();
  await expect(orphanBanner(page)).toContainText('moved or deleted');
  // Passive: no modal overlay/dialog is shown.
  await expect(page.locator('.modal-overlay')).toHaveCount(0);
  // The buffer is preserved — content still renders.
  await expect(activePreview(page)).toContainText('body text');
});

test('unsaved edits are preserved when the file is removed (#58)', async ({ page }) => {
  await installMockBridge(page, file());
  await page.goto('/');
  await page.locator('.source-toggle').click(); // reveal the editor (opens in reading mode)
  await page.locator(`${VIS} .cm-content`).click();
  await page.keyboard.type(' UNSAVED');
  await expect(dirtyDot(page)).toBeVisible();

  await fireRemoved(page, 'C:\\docs\\report.md');

  // Still orphaned, still dirty, edit intact.
  await expect(orphanBanner(page)).toBeVisible();
  await expect(dirtyDot(page)).toBeVisible();
  await expect(page.locator(`${VIS} .cm-content`)).toContainText('UNSAVED');
});

test('saving an orphaned tab routes to Save As, never re-creating the old path (#58)', async ({
  page,
}) => {
  await installMockBridge(page, file());
  await page.goto('/');
  await fireRemoved(page, 'C:\\docs\\report.md');
  await expect(orphanBanner(page)).toBeVisible();

  // Arm Save As to relocate, then Ctrl/Cmd+S (the File → Save accelerator).
  await setNextSaveAs(page, file({ path: 'C:\\docs\\moved\\report.md' }));
  await fireMenuSave(page);

  // It went through Save As (relocate), not a plain save to the old path.
  const calls = await page.evaluate(
    () =>
      (window as unknown as { __mock: { saveAsCalls: unknown[]; saveCalls: unknown[] } }).__mock,
  );
  expect(calls.saveAsCalls).toHaveLength(1);
  expect(calls.saveCalls).toHaveLength(0);
  // The tab adopted the new path and cleared the orphaned banner.
  await expect(activeTabName(page)).toHaveText('report.md');
  await expect(orphanBanner(page)).toBeHidden();
});

test('Save As via the banner adopts the new path and clears orphaned state (#58)', async ({
  page,
}) => {
  await installMockBridge(page, file({ path: 'C:\\docs\\old.md' }));
  await page.goto('/');
  await fireRemoved(page, 'C:\\docs\\old.md');
  await expect(activeTabName(page)).toHaveText('old.md');

  await setNextSaveAs(page, file({ path: 'C:\\docs\\new.md' }));
  await orphanBanner(page).getByRole('button', { name: 'Save As…' }).click();

  await expect(orphanBanner(page)).toBeHidden();
  await expect(activeTabName(page)).toHaveText('new.md');
  // The old, vanished path was unwatched.
  const closed = await page.evaluate(
    () => (window as unknown as { __mock: { closed: string[] } }).__mock.closed,
  );
  expect(closed).toContain('C:\\docs\\old.md');
});

test('"Keep open" dismisses the banner but keeps the tab and buffer (#58)', async ({ page }) => {
  await installMockBridge(page, file());
  await page.goto('/');
  await fireRemoved(page, 'C:\\docs\\report.md');
  await expect(orphanBanner(page)).toBeVisible();

  await orphanBanner(page).getByRole('button', { name: 'Keep open' }).click();

  await expect(orphanBanner(page)).toBeHidden();
  await expect(activeTabName(page)).toHaveText('report.md'); // tab still open
  await expect(activePreview(page)).toContainText('body text'); // buffer intact
});

test('closing a dirty orphaned tab and cancelling Save As keeps the tab (no edit loss) (#58)', async ({
  page,
}) => {
  await installMockBridge(page, file());
  await page.goto('/');
  await page.locator('.source-toggle').click();
  await page.locator(`${VIS} .cm-content`).click();
  await page.keyboard.type(' PRECIOUS');
  await expect(dirtyDot(page)).toBeVisible();

  await fireRemoved(page, 'C:\\docs\\report.md');
  await expect(orphanBanner(page)).toBeVisible();

  // Close the (dirty, orphaned) tab → the save-before-closing prompt appears.
  await orphanBanner(page).getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.modal')).toContainText('Save before closing?');

  // Choose Save → routes to Save As → the user CANCELS the relocation dialog.
  await setNextSaveAs(page, null); // null = cancelled
  await page.locator('.modal').getByRole('button', { name: 'Save', exact: true }).click();

  // The tab must NOT close — the unsaved buffer is preserved and still orphaned.
  await expect(activeTabName(page)).toHaveText('report.md');
  await expect(orphanBanner(page)).toBeVisible();
  await expect(page.locator(`${VIS} .cm-content`)).toContainText('PRECIOUS');
});

test('closing a dirty orphaned tab and completing Save As saves then closes (#58)', async ({
  page,
}) => {
  await installMockBridge(page, [
    file({ path: 'C:\\docs\\report.md' }),
    file({ path: 'C:\\docs\\keep.md', content: '# Keep\n\nstays.\n', hash: 'hk' }),
  ]);
  await page.goto('/');
  // Focus the first tab, edit it, orphan it.
  await page.locator('.tab-name', { hasText: 'report.md' }).click();
  await page.locator('.source-toggle').click();
  await page.locator(`${VIS} .cm-content`).click();
  await page.keyboard.type(' X');
  await fireRemoved(page, 'C:\\docs\\report.md');
  await orphanBanner(page).getByRole('button', { name: 'Close' }).click();

  // Save → Save As succeeds (relocate) → the tab closes.
  await setNextSaveAs(page, file({ path: 'C:\\docs\\report-moved.md' }));
  await page.locator('.modal').getByRole('button', { name: 'Save', exact: true }).click();

  await expect(page.locator('.tab-name', { hasText: 'report' })).toHaveCount(0);
  await expect(page.locator('.tab-name')).toHaveText(['keep.md']);
});

test('a bulk removal marks every tab orphaned without a storm of modals (#58)', async ({ page }) => {
  await installMockBridge(page, [
    file({ path: 'C:\\docs\\a.md', content: '# A\n\naaa\n', hash: 'ha' }),
    file({ path: 'C:\\docs\\b.md', content: '# B\n\nbbb\n', hash: 'hb' }),
    file({ path: 'C:\\docs\\c.md', content: '# C\n\nccc\n', hash: 'hc' }),
  ]);
  await page.goto('/');

  // All three files vanish at once (a reorg).
  await fireRemoved(page, 'C:\\docs\\a.md');
  await fireRemoved(page, 'C:\\docs\\b.md');
  await fireRemoved(page, 'C:\\docs\\c.md');

  // No modal storm — zero modals — and exactly one passive banner (for the active
  // tab). Switching tabs shows each one's own banner.
  await expect(page.locator('.modal-overlay')).toHaveCount(0);
  await expect(orphanBanner(page)).toHaveCount(1);
  await expect(orphanBanner(page)).toBeVisible();
});

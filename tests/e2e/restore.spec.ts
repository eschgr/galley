import { test, expect, type Page } from '@playwright/test';
import { installMockBridge, type MockFile } from './mockBridge';

// Session-restore prompt (#61 slice B, PRD §8.6, PF20/D2), driven through the MOCK
// main-process bridge. The restore DECISION (dirty-vs-clean) and the disk load are
// unit-tested in main (src/main/platform + the getRestore IPC); here we cover the
// React wiring: getRestore returns a session → the RestoreDialog appears with the
// error-marked title and the short question → Yes reopens the tabs and focuses the
// active one; a null decision shows no prompt and starts normally.

const tabNames = (page: Page) => page.locator('.tab-name');
const activeTabName = (page: Page) => page.locator('.tab.is-active .tab-name');
const activePreview = (page: Page) => page.locator('.tab-view:not([hidden]) .markdown-preview');
const restoreModal = (page: Page) => page.locator('.modal', { hasText: 'recovered from a crash' });

const SESSION: { files: MockFile[]; activeIndex: number } = {
  files: [
    { path: 'C:\\docs\\alpha.md', content: '# Alpha\n\nalpha body.\n', hash: 'ha' },
    { path: 'C:\\docs\\bravo.md', content: '# Bravo\n\nbravo body.\n', hash: 'hb' },
  ],
  activeIndex: 1, // bravo is the active tab to restore
};

test('a dirty-shutdown session offers the restore prompt; Yes reopens the tabs and focuses the active one (PF20)', async ({
  page,
}) => {
  // No CLI files; main reports a restorable two-file session.
  await installMockBridge(page, null, SESSION);
  await page.goto('/');

  // The prompt appears, marked as an error recovery, with the short question body.
  const modal = restoreModal(page);
  await expect(modal).toBeVisible();
  await expect(modal.locator('.modal-title')).toHaveText('Galley recovered from a crash');
  await expect(modal.locator('.modal-body')).toHaveText('Restore session from last save?');
  // Exactly two choices, in order, with bare labels — no per-button hint text (a
  // regression that re-adds the "start fresh" / "reopen…" hints, or flips the
  // order, fails here rather than passing the loose /Yes/ selector below).
  await expect(modal.getByRole('button')).toHaveText(['No', 'Yes']);

  // Yes → both tabs open, in order, with the active one (bravo) focused.
  await page.getByRole('button', { name: /Yes/ }).click();
  await expect(restoreModal(page)).toHaveCount(0);
  await expect(tabNames(page)).toHaveText(['alpha.md', 'bravo.md']);
  await expect(activeTabName(page)).toHaveText('bravo.md');
  await expect(activePreview(page)).toContainText('bravo body');
});

test('No leaves the CLI files / welcome untouched — no restore (PF20)', async ({ page }) => {
  await installMockBridge(page, null, SESSION);
  await page.goto('/');

  await expect(restoreModal(page)).toBeVisible();
  await page.getByRole('button', { name: /^No/ }).click();

  // Dismissed, and nothing was restored — back to the empty welcome state.
  await expect(restoreModal(page)).toHaveCount(0);
  await expect(page.locator('.tab-strip')).toHaveCount(0);
});

test('a null restore decision shows no prompt and starts normally', async ({ page }) => {
  // Default (clean shutdown / projectless): getRestore resolves null.
  await installMockBridge(page);
  await page.goto('/');

  await expect(page.locator('.markdown-preview')).toBeVisible(); // welcome renders
  await expect(restoreModal(page)).toHaveCount(0);
});

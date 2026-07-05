import { test, expect, type Page } from '@playwright/test';
import { installMockBridge, fireCloseFile, fireRetain, type MockFile } from './mockBridge';

// The launcher can manage the tab set, not just add to it (#95): `--close <file>`
// closes a tab, `--set <files>` makes the open set exactly those. Both route over
// the channel; closing a dirty tab still prompts (Save / Discard / Cancel). The CLI
// parse + channel transport are unit-tested (src/main/platform); this covers the
// renderer's close/retain behavior through the mock bridge.

const VIS = '.tab-view:not([hidden])';
const tabNames = (page: Page) => page.locator('.tab-name');
const dirtyDot = (page: Page) => page.locator('.tab.is-active .tab-dot');

const files: MockFile[] = [
  { path: 'C:\\docs\\a.md', content: '# A\n\naaa\n', hash: 'ha' },
  { path: 'C:\\docs\\b.md', content: '# B\n\nbbb\n', hash: 'hb' },
  { path: 'C:\\docs\\c.md', content: '# C\n\nccc\n', hash: 'hc' },
];

test('--close closes the named tab, leaving the rest (#95)', async ({ page }) => {
  await installMockBridge(page, files);
  await page.goto('/');
  await expect(tabNames(page)).toHaveText(['a.md', 'b.md', 'c.md']);

  await fireCloseFile(page, 'C:\\docs\\b.md');

  await expect(tabNames(page)).toHaveText(['a.md', 'c.md']);
});

test('--close of a path that is not open is a no-op (#95)', async ({ page }) => {
  await installMockBridge(page, files);
  await page.goto('/');
  await fireCloseFile(page, 'C:\\docs\\nope.md');
  await expect(tabNames(page)).toHaveText(['a.md', 'b.md', 'c.md']);
});

test('--set makes the open set exactly the retained files (#95)', async ({ page }) => {
  await installMockBridge(page, files);
  await page.goto('/');
  await expect(tabNames(page)).toHaveText(['a.md', 'b.md', 'c.md']);

  // Retain only a.md → b.md and c.md close (their content isn't a member).
  await fireRetain(page, ['C:\\docs\\a.md']);

  await expect(tabNames(page)).toHaveText(['a.md']);
});

test('--set retaining all currently-open files closes nothing (#95)', async ({ page }) => {
  await installMockBridge(page, files);
  await page.goto('/');
  await fireRetain(page, ['C:\\docs\\a.md', 'C:\\docs\\b.md', 'C:\\docs\\c.md']);
  await expect(tabNames(page)).toHaveText(['a.md', 'b.md', 'c.md']);
});

test('closing a dirty tab via --close prompts, and Cancel keeps it (#95)', async ({ page }) => {
  await installMockBridge(page, files);
  await page.goto('/');
  // Focus b.md and make it dirty.
  await page.locator('.tab-name', { hasText: 'b.md' }).click();
  await page.locator('.source-toggle').click();
  await page.locator(`${VIS} .cm-content`).click();
  await page.keyboard.type(' EDIT');
  await expect(dirtyDot(page)).toBeVisible();

  await fireCloseFile(page, 'C:\\docs\\b.md');

  // The save-before-closing prompt appears; Cancel keeps the tab.
  await expect(page.locator('.modal')).toContainText('Save before closing?');
  await page.locator('.modal').getByRole('button', { name: 'Cancel' }).click();
  await expect(tabNames(page)).toHaveText(['a.md', 'b.md', 'c.md']);
});

test('a --set that removes several tabs prompts per dirty tab, closing the clean ones (#95)', async ({
  page,
}) => {
  await installMockBridge(page, files);
  await page.goto('/');
  // Make c.md dirty; a.md and b.md stay clean.
  await page.locator('.tab-name', { hasText: 'c.md' }).click();
  await page.locator('.source-toggle').click();
  await page.locator(`${VIS} .cm-content`).click();
  await page.keyboard.type(' DIRTY');
  await expect(dirtyDot(page)).toBeVisible();

  // Retain only a.md → b.md (clean) closes immediately; c.md (dirty) prompts.
  await fireRetain(page, ['C:\\docs\\a.md']);

  await expect(page.locator('.modal')).toContainText('Save before closing?');
  // Discard c.md → it closes too; only a.md remains, no modal storm (one at a time).
  await page.locator('.modal').getByRole('button', { name: 'Discard' }).click();
  await expect(tabNames(page)).toHaveText(['a.md']);
  await expect(page.locator('.modal')).toHaveCount(0);
});

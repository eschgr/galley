import { test, expect } from '@playwright/test';
import { installMockBridge, openFile, type MockFile } from './mockBridge';

// OS window title (PF24), driven through the MOCK main-process bridge. The
// renderer sets document.title from the active file name, the project name (a
// per-window static on window.galley.projectName), and the app, dropping any
// null parts: file — project — Galley. These specs cover the four orderings.
//
// The projectless cases (no project arg) genuinely differ from the project
// cases: were projectName ignored, (b) and (c) would collapse to the projectless
// titles ('Galley' / 'alpha.md — Galley') and the toHaveTitle assertions fail.

const FILE: MockFile = { path: 'C:\\docs\\alpha.md', content: '# Alpha\n\nbody.\n', hash: 'ha' };

test('projectless with no file open → "Galley"', async ({ page }) => {
  await installMockBridge(page); // projectName defaults to null
  await page.goto('/');
  await expect(page).toHaveTitle('Galley');
});

test('a named project with no file open → "<project> — Galley"', async ({ page }) => {
  await installMockBridge(page, null, null, 'Notebook');
  await page.goto('/');
  await expect(page).toHaveTitle('Notebook — Galley');
});

test('a named project with an open file → "<file> — <project> — Galley"', async ({ page }) => {
  await installMockBridge(page, null, null, 'Notebook');
  await page.goto('/');
  await expect(page.locator('.markdown-preview')).toBeVisible();
  await openFile(page, FILE);
  await expect(page).toHaveTitle('alpha.md — Notebook — Galley');
});

test('projectless with an open file → "<file> — Galley"', async ({ page }) => {
  await installMockBridge(page); // projectName defaults to null
  await page.goto('/');
  await expect(page.locator('.markdown-preview')).toBeVisible();
  await openFile(page, FILE);
  // The only ordering that exercises filter(Boolean) dropping a MIDDLE null (the
  // absent project), so file and app still join without a stray separator.
  await expect(page).toHaveTitle('alpha.md — Galley');
});

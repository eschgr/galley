import { test, expect, type Page } from '@playwright/test';
import { installMockBridge, openFile, fireNextTab } from './mockBridge';

// Source-editor focus on activate. With the source editor visible, keyboard focus
// must land in the ACTIVE tab's editor whenever it becomes the thing you'd type
// into — a tab switch, a fresh open, or the moment Show Source reveals the editor —
// so you can keep typing without a click. The editor keeps its own cursor/scroll
// (all tabs stay mounted; only the active one is visible), so this is purely about
// where DOM focus lands, which a display:none editor otherwise loses on a switch.
//
// The one exception is a clicked cross-file #fragment link: that navigation is
// preview-oriented, so focus stays in the preview (last test).

const VIS_EDITOR = '.tab-view:not([hidden]) .pane-editor';
const tabLabel = (page: Page, name: string) => page.locator('.tab', { hasText: name }).locator('.tab-label');
const activeTabName = (page: Page) => page.locator('.tab.is-active .tab-name');

/** True when keyboard focus is inside the VISIBLE tab's source editor. */
async function editorHasFocus(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement;
    return !!el && !!el.closest('.tab-view:not([hidden]) .pane-editor');
  });
}

async function showSource(page: Page): Promise<void> {
  await page.locator('.source-toggle').click(); // Show Source
  await expect(page.locator(VIS_EDITOR)).toBeVisible();
}

const doc = (label: string) => `# ${label}\n\n${label} body paragraph.\n`;

test.beforeEach(async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
});

test('Show Source lands keyboard focus in the source editor', async ({ page }) => {
  await openFile(page, { path: 'C:\\docs\\alpha.md', content: doc('Alpha'), hash: 'ha' });
  // Before Show Source there is no editor to hold focus.
  expect(await editorHasFocus(page)).toBe(false);

  await showSource(page);
  await expect.poll(() => editorHasFocus(page)).toBe(true);
});

test('switching tabs returns focus to the active tab editor (click and Ctrl+Tab)', async ({ page }) => {
  await openFile(page, { path: 'C:\\docs\\alpha.md', content: doc('Alpha'), hash: 'ha' });
  await openFile(page, { path: 'C:\\docs\\bravo.md', content: doc('Bravo'), hash: 'hb' });
  await showSource(page);
  // bravo opened last, so it is active; its editor is focused on reveal.
  await expect(activeTabName(page)).toHaveText('bravo.md');
  await expect.poll(() => editorHasFocus(page)).toBe(true);

  // Click back to alpha — its editor takes focus (at its own retained cursor).
  await tabLabel(page, 'alpha.md').click();
  await expect(activeTabName(page)).toHaveText('alpha.md');
  await expect.poll(() => editorHasFocus(page)).toBe(true);

  // Click over to bravo.
  await tabLabel(page, 'bravo.md').click();
  await expect(activeTabName(page)).toHaveText('bravo.md');
  await expect.poll(() => editorHasFocus(page)).toBe(true);

  // Ctrl+Tab (keyboard) wraps to alpha — the editor is focused on that path too.
  await fireNextTab(page);
  await expect(activeTabName(page)).toHaveText('alpha.md');
  await expect.poll(() => editorHasFocus(page)).toBe(true);
});

test('opening a new file while source is visible focuses its editor', async ({ page }) => {
  await openFile(page, { path: 'C:\\docs\\alpha.md', content: doc('Alpha'), hash: 'ha' });
  await showSource(page);
  await expect.poll(() => editorHasFocus(page)).toBe(true);

  await openFile(page, { path: 'C:\\docs\\bravo.md', content: doc('Bravo'), hash: 'hb' });
  await expect(activeTabName(page)).toHaveText('bravo.md');
  await expect.poll(() => editorHasFocus(page)).toBe(true);
});

test('preview-only mode never forces focus into a hidden editor', async ({ page }) => {
  // Source stays hidden (default preview mode). Switching tabs must NOT pull focus
  // into the (display:none) editor — the focus behavior is gated on the editor
  // being visible.
  await openFile(page, { path: 'C:\\docs\\alpha.md', content: doc('Alpha'), hash: 'ha' });
  await openFile(page, { path: 'C:\\docs\\bravo.md', content: doc('Bravo'), hash: 'hb' });

  await tabLabel(page, 'alpha.md').click();
  await expect(activeTabName(page)).toHaveText('alpha.md');
  await expect(page.locator(VIS_EDITOR)).toBeHidden();
  // Give any (unwanted) focus effect a beat to run, then confirm focus stayed out.
  await page.waitForTimeout(100);
  expect(await editorHasFocus(page)).toBe(false);
});

test('a clicked cross-file #fragment link leaves focus in the preview, not the editor', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 320 }); // short, so the target is below the fold
  await openFile(page, {
    path: 'C:/docs/index.md',
    content: 'see [the intro](./sibling.md#intro)\n',
    hash: 'h',
  });
  await showSource(page);
  await expect.poll(() => editorHasFocus(page)).toBe(true); // index's editor focused on Show Source

  // Click the fragment link, then simulate main resolving + opening the target.
  await page.locator('.markdown-preview a', { hasText: 'the intro' }).click();
  const filler = Array.from({ length: 20 }, (_, i) => `Filler paragraph ${i}.`).join('\n\n');
  await openFile(page, {
    path: 'C:/docs/sibling.md',
    content: `# Sibling\n\n${filler}\n\n## Intro\n\nThe target section.`,
    hash: 'hs',
  });
  await expect(activeTabName(page)).toHaveText('sibling.md');

  // The preview jumped to the heading (fragment nav worked)...
  const previewScrollTop = () =>
    page.evaluate(() => document.querySelector<HTMLElement>('.tab-view:not([hidden]) .preview-scroll')!.scrollTop);
  await expect.poll(previewScrollTop).toBeGreaterThan(20);
  // ...and focus was NOT yanked into the editor — a fragment click is preview-oriented.
  await page.waitForTimeout(100);
  expect(await editorHasFocus(page)).toBe(false);
});

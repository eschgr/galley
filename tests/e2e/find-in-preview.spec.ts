import { test, expect, type Page } from '@playwright/test';
import { installMockBridge, openFile } from './mockBridge';

// Find-in-preview search bar (#57). Ctrl/Cmd+F opens a find bar over the RENDERED
// preview; typing highlights matches and shows "n of N"; Enter / Shift+Enter cycle
// and scroll the current match into view; Esc closes. Works with the source hidden
// (the default reading mode), and defers to the editor's own find when the source
// editor is focused.

// A doc with a unique needle ("Zephyr") in 6 paragraphs, each separated by tall
// filler so the matches are spread down the page — cycling must scroll to reach them.
const NEEDLES = 6;
function findDoc(): string {
  const out: string[] = ['# Find target doc', ''];
  for (let i = 0; i < NEEDLES; i++) {
    out.push(`Paragraph ${i} mentions Zephyr as the unique needle.`);
    out.push('');
    // A full screenful of filler between needles so cycling must scroll to reach
    // the next match (a nearby match already in view wouldn't move the scroller).
    for (let j = 0; j < 30; j++) {
      out.push(`Filler line ${i}-${j}: lorem ipsum dolor sit amet consectetur adipiscing.`);
      out.push('');
    }
  }
  return out.join('\n') + '\n';
}

// Scope every find-bar query to the VISIBLE tab: each open tab renders its own
// (kept-mounted) find bar, so an unscoped selector could match a hidden tab's.
const bar = (page: Page) => page.locator('.tab-view:not([hidden]) .preview-find');
const input = (page: Page) => page.locator('.tab-view:not([hidden]) .preview-find-input');
const count = (page: Page) => page.locator('.tab-view:not([hidden]) .preview-find-count');
const previewScrollTop = (page: Page) =>
  page.evaluate(() => document.querySelector<HTMLElement>('.tab-view:not([hidden]) .preview-scroll')!.scrollTop);
const tabByName = (page: Page, name: string) => page.locator('.tab', { hasText: name });
const activeTabName = (page: Page) => page.locator('.tab.is-active .tab-name');

test.beforeEach(async ({ page }) => {
  await installMockBridge(page);
  await page.goto('/');
});

test('Ctrl+F opens the find bar over the preview, shows the match count, and Esc closes it (source hidden)', async ({
  page,
}) => {
  await openFile(page, { path: 'C:\\docs\\find.md', content: findDoc(), hash: 'h' });
  await expect(page.locator('.markdown-preview')).toBeVisible();
  // Default reading mode: the source editor is hidden.
  await expect(page.locator('.tab-view:not([hidden]) .pane-editor')).toBeHidden();

  await expect(bar(page)).toBeHidden();
  await page.keyboard.press('Control+f');
  await expect(bar(page)).toBeVisible();
  await expect(input(page)).toBeFocused();

  await input(page).fill('Zephyr');
  await expect(count(page)).toHaveText(`1 of ${NEEDLES}`);

  await page.keyboard.press('Escape');
  await expect(bar(page)).toBeHidden();
});

test('Enter / Shift+Enter cycle matches, scroll the current one into view, and wrap around', async ({
  page,
}) => {
  await openFile(page, { path: 'C:\\docs\\find.md', content: findDoc(), hash: 'h' });
  await expect(page.locator('.markdown-preview')).toBeVisible();

  await page.keyboard.press('Control+f');
  await input(page).fill('Zephyr');
  await expect(count(page)).toHaveText(`1 of ${NEEDLES}`);
  const topAtFirst = await previewScrollTop(page);

  // Enter → next match, which lives far below → the preview scrolls down to it.
  await page.keyboard.press('Enter');
  await expect(count(page)).toHaveText(`2 of ${NEEDLES}`);
  await expect.poll(() => previewScrollTop(page)).toBeGreaterThan(topAtFirst + 200);

  // Shift+Enter → previous match, back to the first (near the top).
  await page.keyboard.press('Shift+Enter');
  await expect(count(page)).toHaveText(`1 of ${NEEDLES}`);

  // Shift+Enter from the first wraps to the last.
  await page.keyboard.press('Shift+Enter');
  await expect(count(page)).toHaveText(`${NEEDLES} of ${NEEDLES}`);
  const topAtLast = await previewScrollTop(page);
  expect(topAtLast).toBeGreaterThan(topAtFirst + 200);

  // Enter from the last wraps back to the first.
  await page.keyboard.press('Enter');
  await expect(count(page)).toHaveText(`1 of ${NEEDLES}`);
});

test('a query with no matches shows "0 of 0"', async ({ page }) => {
  await openFile(page, { path: 'C:\\docs\\find.md', content: findDoc(), hash: 'h' });
  await expect(page.locator('.markdown-preview')).toBeVisible();

  await page.keyboard.press('Control+f');
  await input(page).fill('nosuchwordhere');
  await expect(count(page)).toHaveText('0 of 0');
});

test('Ctrl+F is routed by focus: editor find when the source is focused, preview find otherwise', async ({
  page,
}) => {
  await openFile(page, { path: 'C:\\docs\\find.md', content: findDoc(), hash: 'h' });
  await expect(page.locator('.markdown-preview')).toBeVisible();

  // Show the source pane and put the caret in the editor.
  await page.locator('.source-toggle').click();
  await expect(page.locator('.tab-view:not([hidden]) .pane-editor')).toBeVisible();
  await page.locator('.tab-view:not([hidden]) .cm-content').click();

  // Editor focused → CodeMirror's own find owns Ctrl+F; the preview bar must NOT open.
  await page.keyboard.press('Control+f');
  await expect(page.locator('.tab-view:not([hidden]) .cm-panel')).toBeVisible();
  await expect(bar(page)).toBeHidden();
  await page.keyboard.press('Escape'); // close the editor's find panel

  // Focus the preview, then Ctrl+F opens the preview find bar (source still shown).
  await page.locator('.tab-view:not([hidden]) .preview-scroll').click();
  await page.keyboard.press('Control+f');
  await expect(bar(page)).toBeVisible();
  await input(page).fill('Zephyr');
  await expect(count(page)).toHaveText(`1 of ${NEEDLES}`);
});

test('each tab keeps its own find state across a tab switch', async ({ page }) => {
  await openFile(page, { path: 'C:\\docs\\alpha.md', content: findDoc(), hash: 'ha' });
  await openFile(page, { path: 'C:\\docs\\bravo.md', content: 'Bravo body with no needle here.\n', hash: 'hb' });
  await expect(page.locator('.tab-view:not([hidden]) .markdown-preview')).toBeVisible();

  // Open find on alpha and search.
  await tabByName(page, 'alpha.md').locator('.tab-label').click();
  await expect(activeTabName(page)).toHaveText('alpha.md');
  await page.keyboard.press('Control+f');
  await input(page).fill('Zephyr');
  await expect(count(page)).toHaveText(`1 of ${NEEDLES}`);

  // Switch to bravo: its own find bar was never opened, so nothing shows there.
  await tabByName(page, 'bravo.md').locator('.tab-label').click();
  await expect(activeTabName(page)).toHaveText('bravo.md');
  await expect(bar(page)).toBeHidden();

  // Back to alpha: its find bar, query, and count are preserved (no retyping).
  await tabByName(page, 'alpha.md').locator('.tab-label').click();
  await expect(activeTabName(page)).toHaveText('alpha.md');
  await expect(bar(page)).toBeVisible();
  await expect(input(page)).toHaveValue('Zephyr');
  await expect(count(page)).toHaveText(`1 of ${NEEDLES}`);
});

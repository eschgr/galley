import { test, expect, type Page } from '@playwright/test';
import { installMockBridge, openFile } from './mockBridge';

// Open at a specific line (#52): a file opened with a target line scrolls that
// line into view (with context) instead of starting at the top, and an
// out-of-range line clamps to the document's bounds. The CLI `path:line` parse
// and the channel envelope's `line` are unit-tested (src/main/platform); this
// covers the renderer reveal itself through the mock bridge.

const VIS = '.tab-view:not([hidden])';
const activePreview = (page: Page) => page.locator(`${VIS} .markdown-preview`);
const scrollTop = (page: Page) =>
  page.locator(`${VIS} .preview-scroll`).evaluate((el) => (el as HTMLElement).scrollTop);

// A long document of numbered headings, each on its own source line with a blank
// line between — so heading N sits on 0-based source line 2N (its data-source-line).
const HEADINGS = 120;
const longDoc = (): string => {
  const lines: string[] = [];
  for (let n = 0; n < HEADINGS; n++) {
    lines.push(`# Heading ${n}`);
    lines.push('');
  }
  return lines.join('\n');
};

test('opens a startup file scrolled to its target line, not the top (#52)', async ({ page }) => {
  // Heading 50 is on source line 100 (0-based) → 1-based line 101.
  await installMockBridge(page, {
    path: 'C:\\docs\\long.md',
    content: longDoc(),
    hash: 'h',
    line: 101,
  });
  await page.goto('/');

  // The target heading is scrolled into view (roughly centred), and the pane is
  // no longer at the top — proof it revealed the line rather than opening at 0.
  await expect(activePreview(page).getByText('Heading 50', { exact: true })).toBeInViewport();
  expect(await scrollTop(page)).toBeGreaterThan(0);
  // A block far below the target is NOT in view (we didn't just scroll to the end).
  await expect(activePreview(page).getByText('Heading 119', { exact: true })).not.toBeInViewport();
});

test('clamps an out-of-range target line to the end of the document (#52)', async ({ page }) => {
  await installMockBridge(page, {
    path: 'C:\\docs\\long.md',
    content: longDoc(),
    hash: 'h',
    line: 100000, // far past the end
  });
  await page.goto('/');

  // Clamped to the last block — the final heading is revealed.
  await expect(activePreview(page).getByText('Heading 119', { exact: true })).toBeInViewport();
  expect(await scrollTop(page)).toBeGreaterThan(0);
});

test('focusing an already-open file scrolls its tab to the requested line (#52)', async ({ page }) => {
  // Open at the top first (no line)...
  await installMockBridge(page, { path: 'C:\\docs\\long.md', content: longDoc(), hash: 'h' });
  await page.goto('/');
  await expect(activePreview(page).getByText('Heading 0', { exact: true })).toBeInViewport();
  expect(await scrollTop(page)).toBe(0);

  // ...then re-deliver the SAME file with a line (the focus-existing path).
  await openFile(page, { path: 'C:\\docs\\long.md', content: longDoc(), hash: 'h', line: 141 });

  // Heading 70 is on source line 140 → 1-based 141; it is now revealed.
  await expect(activePreview(page).getByText('Heading 70', { exact: true })).toBeInViewport();
  expect(await scrollTop(page)).toBeGreaterThan(0);
});

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
// Heading N sits on 0-based source line 2N → 1-based line 2N+1, so `lineFor(N)`
// is the CLI/channel line that reveals "Heading N".
const lineFor = (heading: number) => 2 * heading + 1;

const tab = (page: Page, name: string) => page.locator('.tab-name', { hasText: name });

// Deliver several opens SYNCHRONOUSLY (one JS tick → one React batch), the way the
// channel delivers a multi-file command under load. Each item shares `doc` content;
// omit `line` for a no-line open.
async function deliverBatch(
  page: Page,
  doc: string,
  items: { path: string; hash: string; line?: number }[],
): Promise<void> {
  await page.evaluate(
    ({ d, its }) => {
      const cb = (window as unknown as { __mock: { openCb: (f: unknown) => void } }).__mock.openCb;
      for (const it of its) {
        cb({ path: it.path, content: d, hash: it.hash, ...(it.line !== undefined ? { line: it.line } : {}) });
      }
    },
    { d: doc, its: items },
  );
}

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

test('two open-at-line deliveries in one batch each reveal their OWN line — no cross-wire (#52 regression)', async ({
  page,
}) => {
  // Regression for a channel race: two `file:opened` messages carrying different
  // lines, processed in the SAME render batch, used to share one reveal ref — so a
  // reveal meant for one file landed on another (or was lost). Reproduced live by
  // firing `A:200 B:30`, after which B sat at ~200 (A's line) instead of 30.
  const doc = longDoc();
  await installMockBridge(page, [
    { path: 'C:\\docs\\A.md', content: doc, hash: 'ha' },
    { path: 'C:\\docs\\B.md', content: doc, hash: 'hb' },
    { path: 'C:\\docs\\C.md', content: doc, hash: 'hc' },
  ]);
  await page.goto('/');
  // Focus C so BOTH the A and B re-reveals go through the switch path (where the
  // single shared ref used to get clobbered) rather than the active-tab fast path.
  await tab(page, 'C.md').click();

  // Deliver two opens SYNCHRONOUSLY — one JS tick, so React batches them into one
  // render (the exact same-batch condition the channel produces under load).
  await page.evaluate((d) => {
    const cb = (window as unknown as { __mock: { openCb: (f: unknown) => void } }).__mock.openCb;
    cb({ path: 'C:\\docs\\A.md', content: d, hash: 'ha', line: 181 }); // → Heading 90 (src line 180)
    cb({ path: 'C:\\docs\\B.md', content: d, hash: 'hb', line: 101 }); // → Heading 50 (src line 100)
  }, doc);

  // B was delivered last → it is active, and at its OWN line 101 → Heading 50.
  await expect(activePreview(page).getByText('Heading 50', { exact: true })).toBeInViewport();

  // A must be at ITS line 181 → Heading 90 — not lost (top) and not B's line.
  await tab(page, 'A.md').click();
  await expect(activePreview(page).getByText('Heading 90', { exact: true })).toBeInViewport();
  await expect(activePreview(page).getByText('Heading 0', { exact: true })).not.toBeInViewport();
});

// Open two files, positioned at known lines, ready for the "manage the set" cases.
async function openTwoPositioned(page: Page, doc: string): Promise<void> {
  await installMockBridge(page);
  await page.goto('/');
  await openFile(page, { path: 'C:\\docs\\A.md', content: doc, hash: 'ha', line: lineFor(50) });
  await openFile(page, { path: 'C:\\docs\\B.md', content: doc, hash: 'hb', line: lineFor(30) });
}

test('no line on multiple files leaves each tab where it was (#52)', async ({ page }) => {
  const doc = longDoc();
  await openTwoPositioned(page, doc); // A → Heading 50, B → Heading 30
  // Re-deliver BOTH with no line, in one batch — must not move either.
  await deliverBatch(page, doc, [
    { path: 'C:\\docs\\A.md', hash: 'ha' },
    { path: 'C:\\docs\\B.md', hash: 'hb' },
  ]);
  await tab(page, 'A.md').click();
  await expect(activePreview(page).getByText('Heading 50', { exact: true })).toBeInViewport();
  await tab(page, 'B.md').click();
  await expect(activePreview(page).getByText('Heading 30', { exact: true })).toBeInViewport();
});

test('a mix of lined and no-line files moves only the lined ones (#52)', async ({ page }) => {
  const doc = longDoc();
  await openTwoPositioned(page, doc); // A → Heading 50, B → Heading 30
  // A gets a new line, B gets none — in one batch.
  await deliverBatch(page, doc, [
    { path: 'C:\\docs\\A.md', hash: 'ha', line: lineFor(90) }, // → Heading 90
    { path: 'C:\\docs\\B.md', hash: 'hb' }, // no line → stays at Heading 30
  ]);
  await tab(page, 'A.md').click();
  await expect(activePreview(page).getByText('Heading 90', { exact: true })).toBeInViewport();
  await tab(page, 'B.md').click();
  await expect(activePreview(page).getByText('Heading 30', { exact: true })).toBeInViewport();
});

test('opening a new file at a line does not disturb the already-open tabs (#52)', async ({ page }) => {
  const doc = longDoc();
  await openTwoPositioned(page, doc); // A → Heading 50, B → Heading 30
  // A brand-new file opens at its line; A and B must be untouched.
  await openFile(page, { path: 'C:\\docs\\C.md', content: doc, hash: 'hc', line: lineFor(40) });
  await expect(activePreview(page).getByText('Heading 40', { exact: true })).toBeInViewport();
  await tab(page, 'A.md').click();
  await expect(activePreview(page).getByText('Heading 50', { exact: true })).toBeInViewport();
  await tab(page, 'B.md').click();
  await expect(activePreview(page).getByText('Heading 30', { exact: true })).toBeInViewport();
});

test('re-revealing an already-open file works in split view (#52)', async ({ page }) => {
  const doc = longDoc();
  await installMockBridge(page, { path: 'C:\\docs\\long.md', content: doc, hash: 'h' });
  await page.goto('/');
  await page.locator('.source-toggle').click(); // Show Source → split view
  // Re-deliver with a line while the source editor is shown — the reveal must win
  // over the reload's keep-place restore (both panes land on the line).
  await openFile(page, { path: 'C:\\docs\\long.md', content: doc, hash: 'h', line: lineFor(70) });
  await expect(activePreview(page).getByText('Heading 70', { exact: true })).toBeInViewport();
  await expect(activePreview(page).getByText('Heading 0', { exact: true })).not.toBeInViewport();
});

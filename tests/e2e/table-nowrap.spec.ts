import { test, expect, type Page } from '@playwright/test';
import { installMockBridge, openFile } from './mockBridge';

// #59: in a table wider than the preview pane, the FIRST column (typically
// short date/label cells) must stay on one line and let the table scroll,
// rather than shrinking and wrapping the dates across 2-3 rows. This is a pure
// renderer/CSS concern (Markdown has no column-width syntax), so it needs real
// layout — hence Playwright rather than the jsdom pipeline unit test.

// A calendar with a NARROW first column (dates) beside a WIDE last column (long
// notes), wide enough to exceed a narrow pane so the wrap-vs-scroll choice is
// actually exercised. Mirrors the corpus fixture in markdown/corpus/02-tables.md.
const CALENDAR = [
  '| Date      | Notes                                                                                       |',
  '|-----------|---------------------------------------------------------------------------------------------|',
  '| Mon Sep 1 | Kickoff at 6:30 PM in the main hall; bring the signed permission slips and a refillable water bottle. |',
  '| Tue Sep 2 | Field trip to the observatory — buses leave promptly at 8:00 AM, and lunch will not be provided. |',
  '| Wed Sep 3 | Guest speaker on deep-sea ecosystems, followed by a hands-on session with the touch-tank exhibits. |',
  '',
].join('\n');

/** Geometry for the first-column cells and the table, read from real layout. */
async function tableGeometry(page: Page) {
  return page.evaluate(() => {
    const table = document.querySelector<HTMLElement>('.markdown-preview table')!;
    const firstCol = [...table.querySelectorAll<HTMLElement>('tr > :first-child')];
    const lastCol = [...table.querySelectorAll<HTMLElement>('tr > :last-child')];
    // The number of visual lines a cell's TEXT occupies — from the client rects
    // of a range over its contents (1 rect = one line, >1 = wrapped). Cell BOX
    // height can't be used: cells stretch to their row's height, so a one-line
    // date in a row whose notes wrap to 3 lines still has a 3-line-tall box.
    const textLines = (el: HTMLElement) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return r.getClientRects().length;
    };
    return {
      firstColWhiteSpace: getComputedStyle(firstCol[firstCol.length - 1]).whiteSpace,
      firstColAllOneLine: firstCol.every((el) => textLines(el) === 1),
      // A wide-notes body cell SHOULD wrap to multiple lines (proving the table
      // is genuinely under width pressure, so "first column didn't wrap" isn't
      // trivially true just because the pane was wide enough for everything).
      lastBodyCellWraps: lastCol.slice(1).some((el) => textLines(el) > 1),
    };
  });
}

test('a wide table keeps its first column on one line and scrolls (#59)', async ({ page }) => {
  // Narrow the window so the calendar's natural width exceeds the preview pane.
  await installMockBridge(page);
  await page.setViewportSize({ width: 640, height: 800 });
  await page.goto('/');
  await expect(page.locator('.markdown-preview')).toBeVisible();
  await openFile(page, { path: 'C:\\docs\\calendar.md', content: CALENDAR, hash: 'h' });
  await expect(page.locator('.markdown-preview table')).toBeVisible();

  const geo = await tableGeometry(page);
  // The fix: first column is nowrap and every date cell renders on one line.
  expect(geo.firstColWhiteSpace).toBe('nowrap');
  expect(geo.firstColAllOneLine).toBe(true);
  // Guardrail so the assertion above can't pass trivially: the wide notes column
  // still wraps, proving the table is genuinely squeezed by the narrow pane.
  expect(geo.lastBodyCellWraps).toBe(true);
});

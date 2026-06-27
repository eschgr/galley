import { test, expect, type Page } from '@playwright/test';
import { installMockBridge, openFile } from './mockBridge';

// REVEAL-ALIGN across a tab switch (#26 — per-tab kept-mounted views).
//
// The reveal-on-Show-Source effect (keyed on [showEditor]) aligns the ACTIVE
// tab's editor to its preview's reading line when source is first shown. But the
// INACTIVE tabs' editors are still display:none at that moment, so they never get
// aligned. When you later switch to one of them, the [hidden, viewMode] effect
// only re-MEASURES (refresh()) the now-visible editor — it does NOT alignTo the
// preview's current line. So the newly-shown tab's editor re-measures but stays at
// its own STALE scroll instead of matching its preview.
//
// User repro (preview-only mode hides the editor entirely, so it can't follow the
// preview while you scroll):
//   1. Preview-only. Open 2 tabs.
//   2. Scroll EACH tab's preview to a DIFFERENT deep position (still preview-only).
//   3. Show Source -> split. The ACTIVE tab's editor is aligned to its preview. ok
//   4. Switch to the OTHER tab -> its EDITOR is at the WRONG scroll (not aligned). x
//
// This asserts that AFTER Show Source, BOTH tabs' editors agree with their own
// preview's top source line once they become the active (visible) tab in split.
//
// Wrap-heavy, non-uniform docs (different per tab) so the editor line geometry is
// genuinely position-dependent: a stale editor scroll lands on a clearly different
// line than the preview's.

type MockFile = { path: string; content: string; hash: string };

// --- Geometry helpers — all scoped to the VISIBLE tab's panes (#26) ----------
const VIS_ED = '.tab-view:not([hidden]) .pane-editor .cm-scroller';
const VIS_PV = '.tab-view:not([hidden]) .preview-scroll';

/** The VISIBLE editor's top visible 0-based source line, scraped from the gutter. */
async function editorTopLine(page: Page): Promise<number> {
  return page.evaluate((sel) => {
    const cm = document.querySelector<HTMLElement>(sel);
    if (!cm) return -1;
    const cmTop = cm.getBoundingClientRect().top;
    let line = -1,
      best = Infinity;
    for (const g of cm.querySelectorAll<HTMLElement>('.cm-gutterElement')) {
      const tx = (g.textContent || '').trim();
      if (!/^\d+$/.test(tx)) continue;
      const d = g.getBoundingClientRect().top - cmTop;
      if (d >= -3 && d < best) {
        best = d;
        line = +tx;
      }
    }
    return line - 1; // 1-based gutter -> 0-based source line
  }, VIS_ED);
}

/** The (fractional) 0-based source line shown at the top of the VISIBLE preview. */
async function previewTopLine(page: Page): Promise<number> {
  return page.evaluate((sel) => {
    const ps = document.querySelector<HTMLElement>(sel);
    if (!ps) return 0;
    const base = ps.getBoundingClientRect().top - ps.scrollTop;
    const a = [...ps.querySelectorAll<HTMLElement>('[data-source-line]')]
      .map((el) => ({ line: +el.getAttribute('data-source-line')!, top: el.getBoundingClientRect().top - base }))
      .sort((x, y) => x.line - y.line || x.top - y.top);
    const st = ps.scrollTop;
    if (!a.length) return 0;
    if (st <= a[0].top) return a[0].line;
    for (let i = 0; i < a.length - 1; i++) {
      if (st < a[i + 1].top) {
        const span = a[i + 1].top - a[i].top;
        const f = span > 0 ? (st - a[i].top) / span : 0;
        return a[i].line + f * (a[i + 1].line - a[i].line);
      }
    }
    return a[a.length - 1].line;
  }, VIS_PV);
}

const previewMaxScroll = (page: Page) =>
  page.evaluate((sel) => {
    const ps = document.querySelector<HTMLElement>(sel)!;
    return Math.max(0, ps.scrollHeight - ps.clientHeight);
  }, VIS_PV);

const editorScrollTop = (page: Page) =>
  page.evaluate((sel) => document.querySelector<HTMLElement>(sel)!.scrollTop, VIS_ED);

// Drive the VISIBLE preview (preview-only mode — the editor is display:none) to a
// target scrollTop with a real pointer hover + wheel. There is no editor to follow
// here; that's the whole point of the repro.
async function previewLedTo(page: Page, targetPx: number): Promise<void> {
  await page.evaluate((sel) => {
    document.querySelector<HTMLElement>(sel)!.scrollTop = 0;
  }, VIS_PV);
  await page.locator('.tab-view:not([hidden]) .pane-preview').hover();
  let prev = -1;
  let stall = 0;
  await expect
    .poll(
      async () => {
        const g = await page.evaluate((sel) => {
          const ps = document.querySelector<HTMLElement>(sel)!;
          return { top: ps.scrollTop, max: ps.scrollHeight - ps.clientHeight, client: ps.clientHeight };
        }, VIS_PV);
        if (g.top >= targetPx) return g.top;
        if (g.max - g.top <= 2) return g.top; // saturated at the preview's own max
        if (g.top > prev + 2) stall = 0;
        else stall++;
        prev = g.top;
        if (stall >= 4) return g.top;
        const remaining = targetPx - g.top;
        await page.mouse.wheel(0, remaining <= g.client ? 120 : 700);
        return -1;
      },
      { timeout: 30_000, intervals: [50] },
    )
    .toBeGreaterThan(0);
  await page.mouse.move(0, 0); // pointer off so it doesn't lead during switches/reveal
}

// Full settle: a couple frames + a healthy tail.
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  await page.waitForTimeout(300);
}

// --- Non-uniform, wrap-heavy docs --------------------------------------------
const PARAS = 170;

function nonUniformDoc(label: string, bulk: number, period: number): string {
  const out: string[] = [`# ${label}`, ''];
  for (let i = 0; i < PARAS; i++) {
    if (i % period === 0) {
      out.push(
        `P${i} ${label} ` +
          Array.from({ length: bulk }, (_, w) => `word${w}${label.toLowerCase()}`).join(' ') +
          ' end.',
      );
    } else {
      out.push(`P${i} ${label} short paragraph.`);
    }
    out.push('');
  }
  return out.join('\n') + '\n';
}

const tabByName = (page: Page, name: string) => page.locator('.tab', { hasText: name });
const activeTabName = (page: Page) => page.locator('.tab.is-active .tab-name');

async function openTwo(page: Page, aContent: string, bContent: string): Promise<void> {
  await openFile(page, { path: 'C:\\docs\\alpha.md', content: aContent, hash: 'ha' });
  await openFile(page, { path: 'C:\\docs\\bravo.md', content: bContent, hash: 'hb' });
  // NOTE: do NOT Show Source yet — the repro scrolls each preview in PREVIEW-ONLY.
}

test.beforeEach(async ({ page }) => {
  test.setTimeout(180_000);
  await installMockBridge(page);
  await page.goto('/');
});

// The bug: in preview-only mode, scroll each tab's preview to a different deep
// position; THEN Show Source; THEN switch tabs. The now-active tab's editor must
// align to ITS preview's top line — for BOTH tabs after the switch.
test('split view: revealing source then switching tabs aligns each editor to its preview (#26)', async ({
  page,
}) => {
  await openTwo(page, nonUniformDoc('Alpha', 22, 3), nonUniformDoc('Bravo', 60, 5));

  // --- Preview-only: scroll EACH tab's preview to a DIFFERENT deep position ---
  // Tab A first.
  await tabByName(page, 'alpha.md').locator('.tab-label').click();
  await expect(activeTabName(page)).toHaveText('alpha.md');
  await settle(page);
  // No editor pane visible in preview-only — confirm we are genuinely preview-only.
  await expect(page.locator('.tab-view:not([hidden]) .pane-editor')).toBeHidden();
  const aMax = await previewMaxScroll(page);
  expect(aMax, 'A preview must be tall enough to sweep').toBeGreaterThan(2000);
  await previewLedTo(page, Math.round(aMax * 0.7));
  await settle(page);
  const aPreviewLine = await previewTopLine(page);
  expect(aPreviewLine, 'A preview scrolled deep').toBeGreaterThan(20);

  // Tab B — a DIFFERENT depth (and different doc geometry).
  await tabByName(page, 'bravo.md').locator('.tab-label').click();
  await expect(activeTabName(page)).toHaveText('bravo.md');
  await settle(page);
  await expect(page.locator('.tab-view:not([hidden]) .pane-editor')).toBeHidden();
  const bMax = await previewMaxScroll(page);
  expect(bMax, 'B preview must be tall enough to sweep').toBeGreaterThan(2000);
  await previewLedTo(page, Math.round(bMax * 0.4));
  await settle(page);
  const bPreviewLine = await previewTopLine(page);
  expect(bPreviewLine, 'B preview scrolled deep').toBeGreaterThan(20);
  // The two tabs sit at clearly different reading lines, so a stale editor scroll
  // can't accidentally match.
  expect(Math.abs(aPreviewLine - bPreviewLine), 'A and B at distinct depths').toBeGreaterThan(10);

  // --- Show Source -> split. Active tab is B; its editor aligns via the reveal
  //     effect. (Sanity-check that path still works.) ---
  await page.locator('.source-toggle').click();
  await expect(page.locator('.tab-view:not([hidden]) .pane-editor')).toBeVisible();
  await settle(page);

  const bEditorAfterReveal = await editorTopLine(page);
  const bPreviewAfterReveal = await previewTopLine(page);
  expect(
    Math.abs(bEditorAfterReveal - bPreviewAfterReveal),
    `reveal aligned B's editor to its preview: edLine=${bEditorAfterReveal.toFixed(1)} pvLine=${bPreviewAfterReveal.toFixed(1)}`,
  ).toBeLessThanOrEqual(3);

  // --- Switch to A. A's editor must now align to A's preview line. THIS is the
  //     bug: A's editor was display:none during the reveal, so it never aligned;
  //     the [hidden, viewMode] effect only refresh()es it. ---
  await tabByName(page, 'alpha.md').locator('.tab-label').click();
  await expect(activeTabName(page)).toHaveText('alpha.md');
  await settle(page);

  const aEditorAfterSwitch = await editorTopLine(page);
  const aPreviewAfterSwitch = await previewTopLine(page);
  const aEditorScroll = await editorScrollTop(page);
  const detail = `A after switch: editorLine=${aEditorAfterSwitch.toFixed(1)} previewLine=${aPreviewAfterSwitch.toFixed(1)} editorScrollTop=${aEditorScroll} (preview-only depth ~${aPreviewLine.toFixed(1)})`;
  expect(aPreviewAfterSwitch, `A preview kept its deep position: ${detail}`).toBeGreaterThan(20);
  expect(
    Math.abs(aEditorAfterSwitch - aPreviewAfterSwitch),
    `A's EDITOR not aligned to its preview after the switch: ${detail}`,
  ).toBeLessThanOrEqual(3);

  // --- And back to B: B's editor must STILL agree with its preview (the switch
  //     away and back must not desync it). ---
  await tabByName(page, 'bravo.md').locator('.tab-label').click();
  await expect(activeTabName(page)).toHaveText('bravo.md');
  await settle(page);

  const bEditorBack = await editorTopLine(page);
  const bPreviewBack = await previewTopLine(page);
  const detailB = `B back: editorLine=${bEditorBack.toFixed(1)} previewLine=${bPreviewBack.toFixed(1)}`;
  expect(
    Math.abs(bEditorBack - bPreviewBack),
    `B's editor desynced from its preview after switching away and back: ${detailB}`,
  ).toBeLessThanOrEqual(3);
});

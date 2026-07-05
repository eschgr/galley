import { test, expect, type Page } from '@playwright/test';

// EDITOR scroll across a tab switch in SPLIT view (#26 — per-tab kept-mounted
// views).
//
// Originally (#18) this proved the single shared CodeMirror editor, whose state
// App swapped on every switch via setState(), landed on the WRONG line: the
// rebuilt height map carried ESTIMATED off-viewport (wrapped) line heights, so the
// line-anchored restore resolved against the wrong pixels and DRIFTED as CM6
// refined them — a timing-dependent "fast vs slow" shift.
//
// #26 removes that whole class of bug by construction: every open tab owns its OWN
// CodeMirror, and all stay mounted (inactive ones are display:none, never
// re-stated). Switching tabs is just a visibility flip — the editor's scroller
// keeps its scrollTop the whole time, with no setState and no height-map rebuild
// to re-resolve. This test now asserts that GUARANTEE directly: A's editor scroll
// AND its synced-with-preview line survive A->B->A unchanged, at every observation
// delay, with NO settle/rAF recovery window (the old warm-sweep restore is gone).
//
// The narrow, wrap-heavy, non-uniform fixtures are kept so the assertion is
// meaningful: under the old state-swap model these were exactly where the restore
// drifted. Now the position must simply be preserved.

type MockFile = { path: string; content: string; hash: string };

// --- Mock main-process bridge ------------------------------------------------
async function installMockBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const harness: {
      openCb: ((f: MockFile) => void) | null;
      nextTabCb: (() => void) | null;
      prevTabCb: (() => void) | null;
    } = { openCb: null, nextTabCb: null, prevTabCb: null };
    (window as unknown as { __mock: typeof harness }).__mock = harness;
    (window as unknown as { galley: unknown }).galley = {
      platform: 'win32',
      version: '0.0.0-test',
      openExternal: async () => {},
      openLocalFile: () => {},
      setSourceVisible: async () => {},
      setActiveDocPath: () => {},
      setSession: () => {},
      getRestore: async () => null,
      getStartupFiles: async () => [],
      saveFile: async (path: string, content: string) => ({
        conflict: false,
        file: { path, content, hash: 'mock-hash' },
      }),
      readFile: async () => null,
      notifyClosed: () => {},
      onOpenFile: (cb: (f: MockFile) => void) => {
        harness.openCb = cb;
        return () => (harness.openCb = null);
      },
      onMenuSave: () => () => {},
      onReloadFile: () => () => {},
      onCloseTab: () => () => {},
      onNextTab: (cb: () => void) => {
        harness.nextTabCb = cb;
        return () => (harness.nextTabCb = null);
      },
      onPrevTab: (cb: () => void) => {
        harness.prevTabCb = cb;
        return () => (harness.prevTabCb = null);
      },
      onHelp: () => () => {},
      onExternalChange: () => () => {},
      onCloseFile: () => () => {},
      onRetainFiles: () => () => {},
      onFileRemoved: () => () => {},
      saveFileAs: async () => null,
      getDroppedPath: () => '',
      openFiles: () => {},
    };
  });
}

async function openFile(page: Page, file: MockFile): Promise<void> {
  await page.evaluate(
    (f) => (window as unknown as { __mock: { openCb: (x: MockFile) => void } }).__mock.openCb(f),
    file,
  );
}

async function fireNextTab(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { __mock: { nextTabCb: () => void } }).__mock.nextTabCb(),
  );
}

// --- Geometry helpers — all scoped to the VISIBLE tab's panes (#26) ----------
const VIS_ED = '.tab-view:not([hidden]) .pane-editor .cm-scroller';
const VIS_PV = '.tab-view:not([hidden]) .preview-scroll';

/** The VISIBLE editor's top visible 0-based source line, scraped from the gutter.
 *  (The old __galleyTestEditorTopLine probe is a single global overwritten by the
 *  last-mounted editor, so with one CM per tab we read the visible gutter directly.) */
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

const editorScrollTop = (page: Page) =>
  page.evaluate((sel) => document.querySelector<HTMLElement>(sel)!.scrollTop, VIS_ED);

const editorMaxScroll = (page: Page) =>
  page.evaluate((sel) => {
    const cm = document.querySelector<HTMLElement>(sel)!;
    return Math.max(0, cm.scrollHeight - cm.clientHeight);
  }, VIS_ED);

// Narrow the EDITOR pane hard (drag the divider toward the right edge, to the
// MIN editor width / MAX preview). A narrow editor maximizes line WRAPPING, the
// most non-uniform-height case — the worst case for the OLD restore, now a no-op.
async function narrowEditor(page: Page): Promise<void> {
  const box = await page.locator('.tab-view:not([hidden]) .split-view, .tab-view:not([hidden])').first().boundingBox();
  if (!box) throw new Error('split-view not laid out');
  const divider = page.locator('.tab-view:not([hidden]) .split-divider');
  const db = await divider.boundingBox();
  if (!db) throw new Error('divider not laid out');
  await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.82, db.y + db.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.mouse.move(0, 0);
}

// Drive the VISIBLE preview (as the leader) deep and let the editor follow, leaving
// both panes synced there — a trustworthy reference (editor top line == preview
// top line) to carry across the switch. `untilEditor` is the editor scrollTop to
// reach; we stop early if the (shorter) preview saturates so the panes stay synced.
async function previewLedDeepAndSync(page: Page, untilEditor: number): Promise<void> {
  await page.evaluate(
    ([edSel, pvSel]) => {
      document.querySelector<HTMLElement>(pvSel)!.scrollTop = 0;
      document.querySelector<HTMLElement>(edSel)!.scrollTop = 0;
    },
    [VIS_ED, VIS_PV],
  );
  await page.locator('.tab-view:not([hidden]) .pane-preview').hover(); // pointer-over preview → it leads
  let prev = -1;
  let stall = 0;
  await expect
    .poll(
      async () => {
        const g = await page.evaluate(
          ([edSel, pvSel]) => {
            const cm = document.querySelector<HTMLElement>(edSel)!;
            const ps = document.querySelector<HTMLElement>(pvSel)!;
            return {
              ed: cm.scrollTop,
              pTop: ps.scrollTop,
              pMax: ps.scrollHeight - ps.clientHeight,
              pClient: ps.clientHeight,
            };
          },
          [VIS_ED, VIS_PV],
        );
        const ed = g.ed;
        if (ed >= untilEditor) return ed;
        if (g.pMax - g.pTop <= g.pClient * 1.5) return ed; // preview bottomed out — stay synced
        if (ed > prev + 2) stall = 0;
        else stall++;
        prev = ed;
        if (stall >= 3) return ed; // editor saturated at its own max
        const remaining = untilEditor - ed;
        const near = remaining <= 1500 || g.pMax - g.pTop <= g.pClient * 2.5;
        await page.mouse.wheel(0, near ? 120 : 800);
        return -1;
      },
      { timeout: 30_000, intervals: [50] },
    )
    .toBeGreaterThan(0);
  await page.mouse.move(0, 0);
}

// Observe the editor after a switch at a chosen number of rAFs (0 = synchronous)
// plus an optional ms tail.
async function observeAfter(page: Page, rafs: number, ms: number): Promise<void> {
  if (rafs > 0) {
    await page.evaluate(
      (n) =>
        new Promise<void>((resolve) => {
          let i = 0;
          const step = () => (++i >= n ? resolve() : requestAnimationFrame(step));
          requestAnimationFrame(step);
        }),
      rafs,
    );
  }
  if (ms > 0) await page.waitForTimeout(ms);
}

// Full settle: a couple frames + a healthy tail.
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  await page.waitForTimeout(300);
}

// --- Non-uniform, wrap-heavy docs --------------------------------------------
const PARAS = 170; // 170 paragraphs * 2 lines each + heading => 340+ source lines

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

const longDoc = (label: string) =>
  `# ${label}\n\n` + Array.from({ length: 120 }, (_, i) => `Paragraph ${i} of ${label}.`).join('\n\n') + '\n';

async function setupSplit(page: Page, aContent: string, bContent: string): Promise<void> {
  await openFile(page, { path: 'C:\\docs\\alpha.md', content: aContent, hash: 'ha' });
  await openFile(page, { path: 'C:\\docs\\bravo.md', content: bContent, hash: 'hb' });
  await page.locator('.source-toggle').click(); // Show Source
  await expect(page.locator('.tab-view:not([hidden]) .pane-editor')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  test.setTimeout(180_000);
  await installMockBridge(page);
  await page.goto('/');
});

test('split view: switching tabs preserves the editor scroll position and keeps panes in sync — mouse (#26)', async ({
  page,
}) => {
  await setupSplit(page, longDoc('Alpha'), longDoc('Bravo'));

  await tabByName(page, 'alpha.md').locator('.tab-label').click();
  await expect(activeTabName(page)).toHaveText('alpha.md');
  await settle(page);
  await previewLedDeepAndSync(page, 700);
  await settle(page);

  const aEditorBefore = await editorTopLine(page);
  const aScrollBefore = await editorScrollTop(page);
  expect(aEditorBefore).toBeGreaterThan(10);
  expect(Math.abs(aEditorBefore - (await previewTopLine(page)))).toBeLessThanOrEqual(3);

  await tabByName(page, 'bravo.md').locator('.tab-label').click();
  await expect(activeTabName(page)).toHaveText('bravo.md');
  await settle(page);

  await tabByName(page, 'alpha.md').locator('.tab-label').click();
  await expect(activeTabName(page)).toHaveText('alpha.md');
  await settle(page);

  const aEditorAfter = await editorTopLine(page);
  const previewAfter = await previewTopLine(page);
  const aScrollAfter = await editorScrollTop(page);

  const detail = `editorBefore=${aEditorBefore.toFixed(1)} editorAfter=${aEditorAfter.toFixed(
    1,
  )} previewAfter=${previewAfter.toFixed(1)} scrollBefore=${aScrollBefore} scrollAfter=${aScrollAfter}`;
  expect(aEditorAfter, detail).toBeGreaterThan(10);
  expect(Math.abs(aEditorAfter - aEditorBefore), detail).toBeLessThanOrEqual(3);
  expect(Math.abs(aEditorAfter - previewAfter), detail).toBeLessThanOrEqual(3);
  expect(Math.abs(aScrollAfter - aScrollBefore), detail).toBeLessThanOrEqual(30);
});

test('split view: Ctrl+Tab cycle preserves the editor scroll position and keeps panes in sync — keyboard (#26)', async ({
  page,
}) => {
  await setupSplit(page, longDoc('Alpha'), longDoc('Bravo'));

  // Active is bravo (opened last). Cycle to alpha (wraps), scroll it deep.
  await fireNextTab(page);
  await expect(activeTabName(page)).toHaveText('alpha.md');
  await settle(page);
  await previewLedDeepAndSync(page, 700);
  await settle(page);

  const aEditorBefore = await editorTopLine(page);
  expect(aEditorBefore).toBeGreaterThan(10);

  await fireNextTab(page);
  await expect(activeTabName(page)).toHaveText('bravo.md');
  await settle(page);
  await fireNextTab(page);
  await expect(activeTabName(page)).toHaveText('alpha.md');
  await settle(page);

  const aEditorAfter = await editorTopLine(page);
  const previewAfter = await previewTopLine(page);
  const detail = `editorBefore=${aEditorBefore.toFixed(1)} editorAfter=${aEditorAfter.toFixed(
    1,
  )} previewAfter=${previewAfter.toFixed(1)}`;
  expect(aEditorAfter, detail).toBeGreaterThan(10);
  expect(Math.abs(aEditorAfter - aEditorBefore), detail).toBeLessThanOrEqual(3);
  expect(Math.abs(aEditorAfter - previewAfter), detail).toBeLessThanOrEqual(3);
});

// #26: with per-tab kept-mounted editors, RAPID switching never moves the editor
// off its own line. Sweeps depth × observation-timing across many A->B->A cycles
// (both the TabStrip click and Ctrl+Tab paths), on narrow wrap-heavy non-uniform
// docs — the worst case for the OLD state-swap restore — and asserts the editor's
// raw scrollTop AND its synced line are PRESERVED at every observation delay,
// including 0 rAF, with NO recovery window.
test('split view: rapid tab switching preserves the editor scroll position exactly (#26)', async ({
  page,
}) => {
  await setupSplit(page, nonUniformDoc('Alpha', 22, 3), nonUniformDoc('Bravo', 60, 5));

  // Narrow the editor → maximal wrapping → the old restore's worst case.
  await narrowEditor(page);

  await tabByName(page, 'alpha.md').locator('.tab-label').click();
  await expect(activeTabName(page)).toHaveText('alpha.md');
  await settle(page);
  await previewLedDeepAndSync(page, 1_000_000); // saturate at the bottom → measure tail
  await settle(page);
  await settle(page);
  const maxScroll = await editorMaxScroll(page);
  expect(maxScroll, 'editor must be tall enough to sweep depths').toBeGreaterThan(3000);
  const clientH = await page.evaluate((sel) => document.querySelector<HTMLElement>(sel)!.clientHeight, VIS_ED);

  const DEPTHS: Array<{ label: string; target: number }> = [
    { label: 'shallow', target: Math.min(maxScroll, 1500) },
    { label: 'mid', target: Math.round(maxScroll * 0.45) },
    { label: 'deep', target: Math.round(maxScroll * 0.75) },
    { label: 'near-bottom', target: Math.max(0, maxScroll - Math.round(clientH * 1.5)) },
  ];

  const OBS: Array<{ rafs: number; ms: number }> = [
    { rafs: 0, ms: 0 }, // synchronous — must already be preserved
    { rafs: 1, ms: 0 },
    { rafs: 2, ms: 0 },
    { rafs: 4, ms: 0 },
    { rafs: 0, ms: 250 },
  ];
  const DWELL = [0, 50, 200];
  const CYCLES_PER_DEPTH = OBS.length;

  for (const depth of DEPTHS) {
    await previewLedDeepAndSync(page, depth.target);
    await settle(page);
    await settle(page);

    const aEditorRef = await editorTopLine(page);
    const aScrollRef = await editorScrollTop(page);
    const aPreviewRef = await previewTopLine(page);
    const near = `depth=${depth.label}(target≈${depth.target}/max=${maxScroll}) landedScroll=${aScrollRef} landedLine=${aEditorRef.toFixed(1)}`;
    expect(aEditorRef, `precondition: A scrolled deep — ${near}`).toBeGreaterThan(10);
    expect(
      Math.abs(aEditorRef - aPreviewRef),
      `precondition: A editor/preview synced — ${near}`,
    ).toBeLessThanOrEqual(3);

    for (let i = 0; i < CYCLES_PER_DEPTH; i++) {
      await settle(page);
      const beforeEditor = await editorTopLine(page);
      const beforeScroll = await editorScrollTop(page);

      const obs = OBS[i % OBS.length];
      const dwell = DWELL[i % DWELL.length];

      // A -> B (alternate click / Ctrl+Tab).
      if (i % 2 === 0) {
        await tabByName(page, 'bravo.md').locator('.tab-label').click();
      } else {
        await fireNextTab(page);
      }
      await expect(activeTabName(page)).toHaveText('bravo.md');
      if (dwell > 0) await page.waitForTimeout(dwell);

      // B -> A (the tab under test).
      if (i % 2 === 0) {
        await tabByName(page, 'alpha.md').locator('.tab-label').click();
      } else {
        await fireNextTab(page);
      }
      await expect(activeTabName(page)).toHaveText('alpha.md');

      await observeAfter(page, obs.rafs, obs.ms);

      const afterEditor = await editorTopLine(page);
      const afterPreview = await previewTopLine(page);
      const afterScroll = await editorScrollTop(page);

      const detail =
        `${near} cycle=${i} obs=${obs.rafs}raf+${obs.ms}ms dwellB=${dwell}ms path=${i % 2 === 0 ? 'click' : 'ctrlTab'} ` +
        `beforeEditor=${beforeEditor.toFixed(1)} afterEditor=${afterEditor.toFixed(1)} ` +
        `afterPreview=${afterPreview.toFixed(1)} aEditorRef=${aEditorRef.toFixed(1)} ` +
        `beforeScroll=${beforeScroll} afterScroll=${afterScroll} aScrollRef=${aScrollRef}`;

      // (a) The editor kept its OWN raw scrollTop (±25 for rounding).
      expect(
        Math.abs(afterScroll - aScrollRef),
        `editor scrollTop not preserved across the switch: ${detail}`,
      ).toBeLessThanOrEqual(25);
      // (b) ...on its own line (not snapped to top).
      expect(afterEditor, `editor snapped to top / too shallow: ${detail}`).toBeGreaterThan(10);
      expect(
        Math.abs(afterEditor - aEditorRef),
        `editor line not preserved across the switch: ${detail}`,
      ).toBeLessThanOrEqual(1);
      // (c) Editor and preview still agree.
      expect(
        Math.abs(afterEditor - afterPreview),
        `editor out of sync with preview after switch: ${detail}`,
      ).toBeLessThanOrEqual(2);
    }
  }
});

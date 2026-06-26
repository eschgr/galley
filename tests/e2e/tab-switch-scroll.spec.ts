import { test, expect, type Page } from '@playwright/test';

// REGRESSION (issue #18, split-view tab switch): in SPLIT view, switching tabs
// must restore the EDITOR (CM6) pane's scroll position for the newly-selected
// tab, and leave the editor and preview reporting the same top line (in sync,
// no pending "jump" that only resolves on the next user scroll).
//
// Root cause: App.switchTo() restores the target tab via editorRef.setState(),
// but a CM6 EditorState does NOT carry scrollTop (that lives on
// view.scrollDOM.scrollTop), so App stashes the editor's top LINE per tab and
// restores it with restoreEditorLine(line) = editorRef.alignTo(line) immediately
// + ONE requestAnimationFrame. alignTo computes the scrollTop from
// block.top = the cumulative sum of the ABOVE-line heights in CM6's height map.
// Right after setState that map is rebuilt with ESTIMATED off-viewport line
// heights — and the editor uses EditorView.lineWrapping, so a long line that
// wraps to many visual rows is estimated as ~one row until CM6 measures it.
// alignTo therefore lands on a pixel computed from UNDER-estimated above-line
// heights → the wrong visible line. CM6 then refines those heights over the next
// several measure cycles and the content DRIFTS off the intended line. The fixed
// 2-shot align (sync + 1 rAF) does not cover refinements that take more than one
// extra frame → a TIMING-DEPENDENT shift the user sees as "fast vs slow".
//
// These tests drive the real renderer (npm run devapp) through a MOCK bridge.
// The #18-editor-race test below MUST currently FAIL: the editor lands on a
// wrong line after a switch, drifting as CM6 refines its wrapped-line heights.

type MockFile = { path: string; content: string; hash: string };

// --- Mock main-process bridge ------------------------------------------------
// Mirrors tests/e2e/file.spec.ts, with one ADDITION (clearly marked): the
// onNextTab / onPrevTab subscriptions, so the keyboard Ctrl+Tab cycle path
// (App.cycle -> switchTo) is drivable from the test. These are part of the real
// MdtoolApi (src/shared/api.ts); file.spec.ts simply never needed them. This
// only wires existing IPC callbacks into the mock — it changes NO product
// behavior.
async function installMockBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const harness: {
      openCb: ((f: MockFile) => void) | null;
      nextTabCb: (() => void) | null; // ADDED for this spec (keyboard cycle)
      prevTabCb: (() => void) | null; // ADDED for this spec (keyboard cycle)
    } = { openCb: null, nextTabCb: null, prevTabCb: null };
    (window as unknown as { __mock: typeof harness }).__mock = harness;
    (window as unknown as { mdtool: unknown }).mdtool = {
      platform: 'win32',
      version: '0.0.0-test',
      openExternal: async () => {},
      openLocalFile: () => {},
      setSourceVisible: async () => {},
      setActiveDocPath: () => {},
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
    };
  });
}

async function openFile(page: Page, file: MockFile): Promise<void> {
  await page.evaluate(
    (f) => (window as unknown as { __mock: { openCb: (x: MockFile) => void } }).__mock.openCb(f),
    file,
  );
}

// Fire the Ctrl+Tab menu/accelerator the main process would post (#19).
async function fireNextTab(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { __mock: { nextTabCb: () => void } }).__mock.nextTabCb(),
  );
}

// --- Geometry helpers (same approach as view.spec.ts) ------------------------

/**
 * The editor's top visible 0-based source line. Prefer the read-only test seam
 * (__mdtoolTestEditorTopLine — CodeMirror's own getTopLine() over its live height
 * map), which is paint-independent and so valid even at 0 rAF right after a
 * switch, when the gutter DOM hasn't repainted and a scrape would be unreliable.
 * Falls back to scraping the gutter if the seam isn't present (e.g. against a
 * build without it).
 */
async function editorTopLine(page: Page): Promise<number> {
  return page.evaluate(() => {
    const probe = (window as unknown as { __mdtoolTestEditorTopLine?: () => number })
      .__mdtoolTestEditorTopLine;
    if (probe) return probe();
    const cm = document.querySelector<HTMLElement>('.pane-editor .cm-scroller');
    if (!cm) return -1;
    const cmTop = cm.getBoundingClientRect().top;
    let line = -1,
      best = Infinity;
    for (const g of document.querySelectorAll<HTMLElement>('.pane-editor .cm-gutterElement')) {
      const tx = (g.textContent || '').trim();
      if (!/^\d+$/.test(tx)) continue;
      const d = g.getBoundingClientRect().top - cmTop;
      if (d >= -3 && d < best) {
        best = d;
        line = +tx;
      }
    }
    return line - 1; // 1-based gutter -> 0-based source line
  });
}

/** The (fractional) 0-based source line shown at the top of the preview. */
async function previewTopLine(page: Page): Promise<number> {
  return page.evaluate(() => {
    const ps = document.querySelector<HTMLElement>('.preview-scroll');
    if (!ps) return 0;
    const base = ps.getBoundingClientRect().top - ps.scrollTop;
    const a = [...document.querySelectorAll<HTMLElement>('.markdown-preview [data-source-line]')]
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
  });
}

const editorScrollTop = (page: Page) =>
  page.evaluate(() => document.querySelector<HTMLElement>('.pane-editor .cm-scroller')!.scrollTop);

// Narrow the EDITOR pane hard (drag the divider toward the right edge, to the
// MAX_PCT=80 preview / MIN editor width). A narrow editor maximizes line
// WRAPPING — long source lines wrap to many visual rows — which is exactly where
// CM6's per-row height ESTIMATE for off-viewport lines is most wrong, so the
// restore lands far off. SplitView clamps editor width to [20%, 80%]; dragging
// to the far right gives the editor its 20% minimum.
async function narrowEditor(page: Page): Promise<void> {
  const box = await page.locator('.split-view').boundingBox();
  if (!box) throw new Error('split-view not laid out');
  const divider = page.locator('.split-divider');
  const db = await divider.boundingBox();
  if (!db) throw new Error('divider not laid out');
  // Drag the divider to ~82% across the container → editor pane clamps to its
  // 20% minimum (the narrowest, most-wrapped editor).
  await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.82, db.y + db.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.mouse.move(0, 0);
}

// Drive the PREVIEW (as the leader) to a deep line and let the editor follow,
// leaving both panes synced there. SplitView picks the leader from onPointerEnter
// (the pointer-over pane), so a synthetic WheelEvent wouldn't make a pane the
// leader — only a real pointer over the pane does. We lead with the PREVIEW for
// SETUP because the preview's anchor map is reliable, so the editor follows onto
// the CORRECT line and gets measured there — giving us a trustworthy synced
// reference (editor top line == preview top line) to stash. The bug under test is
// the editor restore AFTER a switch, not how we got here. `untilEditor` is the
// editor scrollTop to reach; deep enough that many above-lines (most long/wrapped
// and ESTIMATED while off-viewport) sit above the restored top.
async function previewLedDeepAndSync(page: Page, untilEditor: number): Promise<void> {
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('.preview-scroll')!.scrollTop = 0;
    document.querySelector<HTMLElement>('.pane-editor .cm-scroller')!.scrollTop = 0;
  });
  await page.locator('.pane-preview').hover(); // pointer-over preview → it leads
  // Wheel the preview (it leads; the editor follows by line). Coarse far away,
  // fine within a screenful of the target, so we land NEAR the requested editor
  // scrollTop rather than overshooting. Stop when ANY of:
  //   * the editor reached the requested depth, OR
  //   * the editor STALLED (scrollTop stops advancing — it's at its own max), OR
  //   * the PREVIEW reached (within a margin of) its OWN max — because the preview
  //     is the shorter pane, it bottoms out first, and past that point it can no
  //     longer scroll to share the editor's top line. Stopping here keeps the two
  //     panes genuinely SYNCED, which is the trustworthy reference we need. The
  //     editor lands as deep as the preview can still follow it to.
  // The caller reads the ACTUAL landed depth (it may be < untilEditor near bottom).
  let prev = -1;
  let stall = 0;
  await expect
    .poll(
      async () => {
        const g = await page.evaluate(() => {
          const cm = document.querySelector<HTMLElement>('.pane-editor .cm-scroller')!;
          const ps = document.querySelector<HTMLElement>('.preview-scroll')!;
          return {
            ed: cm.scrollTop,
            pTop: ps.scrollTop,
            pMax: ps.scrollHeight - ps.clientHeight,
            pClient: ps.clientHeight,
          };
        });
        const ed = g.ed;
        if (ed >= untilEditor) return ed; // reached the requested depth
        // The PREVIEW is the shorter pane and bottoms out first; once it is within
        // one (preview) screenful of its own max it can no longer scroll to share
        // the editor's deeper top line, so the two would desync. Stop here — this
        // is the deepest position where the panes stay genuinely in sync, which is
        // the trustworthy reference the test needs. Approach the editor target with
        // a SMALL step near the end so the leading preview doesn't overshoot this
        // boundary in one coarse wheel (its tall wrapped tail lines make the
        // preview→editor mapping steep near the bottom).
        if (g.pMax - g.pTop <= g.pClient * 1.5) return ed;
        if (ed > prev + 2) {
          stall = 0;
        } else {
          stall++;
        }
        prev = ed;
        if (stall >= 3) return ed; // editor saturated at its own max
        const remaining = untilEditor - ed;
        const near = remaining <= 1500 || g.pMax - g.pTop <= g.pClient * 2.5;
        await page.mouse.wheel(0, near ? 120 : 800);
        return -1; // keep polling
      },
      { timeout: 30_000, intervals: [50] },
    )
    .toBeGreaterThan(0);
  // Move the pointer off the preview so it doesn't lead during the tab switches.
  await page.mouse.move(0, 0);
}

// The editor pane's maximum scrollTop (scrollHeight - clientHeight), read from the
// DOM so depth targets adapt to whatever the doc actually renders to (rather than
// hardcoding a pixel that drifts if the doc or wrapping changes).
const editorMaxScroll = (page: Page) =>
  page.evaluate(() => {
    const cm = document.querySelector<HTMLElement>('.pane-editor .cm-scroller')!;
    return Math.max(0, cm.scrollHeight - cm.clientHeight);
  });

// Observe the editor after a switch at a chosen number of rAFs (0 = synchronous,
// before any measure settles) plus an optional ms tail. The 0-rAF point catches
// the bug at its worst (estimated heights, no refinement yet); the longer tails
// catch the post-refinement DRIFT that the fixed 2-shot align doesn't cover.
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

// Full settle: a couple frames + a healthy tail, so the reference reads are taken
// once CM6 has finished refining wrapped-line heights.
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  await page.waitForTimeout(300);
}

// --- Non-uniform, wrap-heavy docs (the EDITOR height-refinement race) ---------
// LONG source docs (300+ source lines) with HIGHLY non-uniform line lengths: very
// long lines (which wrap to MANY visual rows in the narrow editor) interleaved
// with short ones. Each content line is its OWN paragraph (a blank line between),
// so it carries its own data-source-line anchor in the preview AND a long line
// renders TALL in BOTH panes — keeping the editor and preview height profiles
// correlated enough that, when correct, the two stay in sync, while the editor
// alone suffers the wrapped-line ESTIMATE error that the buggy restore reads.
//
// Tab A and tab B get DIFFERENT length profiles (which lines are long, and how
// long), so the cumulative above-line height differs sharply between them: a
// restore that interpolates A's deep line against a still-estimated height map
// lands the editor on a clearly WRONG line, not a coincidentally-near-right one.
// The editor shows raw SOURCE TEXT (no images) — height variance comes purely
// from LINE LENGTH + WRAPPING, the real bug's source.
const PARAS = 170; // 170 paragraphs * 2 lines each + heading => 340+ source lines

// `bulk` words on a "long" paragraph; `period` = every Nth paragraph is long
// (the rest are short single-row paragraphs). Different (bulk, period) per tab.
function nonUniformDoc(label: string, bulk: number, period: number): string {
  const out: string[] = [`# ${label}`, ''];
  for (let i = 0; i < PARAS; i++) {
    if (i % period === 0) {
      // A very long paragraph: wraps to many visual rows in the narrow editor and
      // renders tall in the preview too.
      out.push(
        `P${i} ${label} ` +
          Array.from({ length: bulk }, (_, w) => `word${w}${label.toLowerCase()}`).join(' ') +
          ' end.',
      );
    } else {
      out.push(`P${i} ${label} short paragraph.`); // a short, single-row paragraph
    }
    out.push(''); // blank line → its own preview anchor
  }
  return out.join('\n') + '\n';
}

const tabByName = (page: Page, name: string) => page.locator('.tab', { hasText: name });
const activeTabName = (page: Page) => page.locator('.tab.is-active .tab-name');

// Long markdown so the legacy mouse/keyboard restore tests can scroll a screen.
const longDoc = (label: string) =>
  `# ${label}\n\n` + Array.from({ length: 120 }, (_, i) => `Paragraph ${i} of ${label}.`).join('\n\n') + '\n';

async function setupSplit(page: Page, aContent: string, bContent: string): Promise<void> {
  await openFile(page, { path: 'C:\\docs\\alpha.md', content: aContent, hash: 'ha' });
  await openFile(page, { path: 'C:\\docs\\bravo.md', content: bContent, hash: 'hb' });
  await page.locator('.source-toggle').click(); // Show Source
  await expect(page.locator('.pane-editor')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  // This spec sweeps depth × observation-timing across many A->B->A cycles, which
  // legitimately exceeds the 30s default — scope the larger budget to this spec
  // rather than the whole config (so a hang elsewhere still surfaces in ~30s).
  test.setTimeout(180_000);
  await installMockBridge(page);
  await page.goto('/');
});

test('split view: switching tabs restores the editor scroll position and keeps panes in sync (mouse)', async ({
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
  expect(Math.abs(aScrollAfter - aScrollBefore), detail).toBeLessThanOrEqual(60);
});

test('split view: Ctrl+Tab cycle restores the editor scroll position and keeps panes in sync (keyboard)', async ({
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

// REGRESSION (issue #18, INTERMITTENT — the EDITOR height-refinement race):
//
// In SPLIT view, switching tabs lands the SOURCE (CM6) editor at a WRONG line
// intermittently. App.switchTo() -> editorRef.setState(stashed) rebuilds CM6's
// height map with ESTIMATED off-viewport line heights — and the editor uses
// EditorView.lineWrapping, so a long line that wraps to many visual rows is
// estimated as ~one row until CM6 measures it. restoreEditorLine(line) =
// alignTo(line) (sync) + ONE rAF computes scrollTop from block.top = the
// cumulative sum of those ESTIMATED above-line heights → the wrong pixel → the
// wrong visible line. CM6 then refines those heights over the next several
// measure cycles and the content DRIFTS off the intended line. The fixed 2-shot
// align doesn't cover refinements that take more than one extra frame → a
// timing-dependent shift ("fast vs slow").
//
// This test makes the race near-certain to surface WITHOUT touching the preview:
//   * Tab A and tab B carry LONG (340+ line), HIGHLY non-uniform docs (very long
//     wrapped lines interleaved with short ones), with DIFFERENT length profiles,
//     so aligning A against B's stale/estimated height map lands on a clearly
//     wrong line rather than a coincidentally-near-right one.
//   * The EDITOR pane is narrowed to its 20% minimum to MAXIMIZE wrapping (where
//     the per-row height estimate is most wrong).
//   * Tab A is scrolled DEEP (many estimated above-lines) so the cumulative
//     height error is large.
//   * 30 A->B->A cycles sweep BOTH the dwell on B (≈0 .. a few hundred ms) AND the
//     OBSERVATION delay after returning to A (0 rAF / 1 / 2 / 4 / 100ms / 250ms /
//     400ms), so different iterations catch the bug at different settle stages —
//     the 0/1-rAF points catch it before measures settle; the longer tails catch
//     the post-refinement drift the 2-shot align can't hold.
//   * Each cycle asserts, FAIL-FAST: editor restored top line == tab A's stashed
//     top line (±1 line), AND editor top line == preview top line (±2). Cycle
//     index, observation delay, before/after line, and scrollTop are captured in
//     the failure detail.
//
// This targets the EDITOR's measure/height-refinement timing, NOT the preview —
// it needs no preview-anchor seam, because post-decouple the preview's anchor
// rebuild no longer touches the editor restore. A correct fix (CM6
// view.scrollSnapshot() stashed per tab and dispatched after setState, so the
// restore re-applies THROUGH the measure cycle and survives height refinement)
// makes the editor land on the right line at EVERY observation delay including
// 0 rAF, satisfying this test. (A bounded multi-measure re-align window would
// also pass, but only once settled — see the note on the 0-rAF assertions.)
test('split view: rapid tab switching never lands the editor on the wrong line — editor height-refinement race (#18)', async ({
  page,
}) => {
  // NO editor-timing seam is needed: this reproduces the real height-refinement
  // race on REALISTIC input alone (narrow, wrapping editor + non-uniform docs +
  // a deep scroll + 0/1-rAF observation points), which is exactly how the user
  // hits it by hand. The ONLY product touch is the READ-ONLY
  // __mdtoolTestEditorTopLine probe in Editor.tsx (paint-independent line read);
  // it never moves scroll or measures, so it cannot perturb the timing under test,
  // and it is inert in production (nothing calls it). No preview-anchor seam is
  // involved: post-decouple the preview's anchor rebuild no longer touches the
  // editor restore, so deferring it would test the wrong subsystem.

  // Different length profiles per tab: A has long lines every 3rd line (more,
  // shorter long-lines); B has very long lines every 5th line. The cumulative
  // above-line height differs sharply between the two, so restoring A's deep line
  // against a height map still carrying B's (or A's own estimated) geometry lands
  // the editor on a clearly wrong line.
  await setupSplit(page, nonUniformDoc('Alpha', 22, 3), nonUniformDoc('Bravo', 60, 5));

  // Narrow the editor → maximal wrapping → maximal per-row estimate error.
  await narrowEditor(page);

  // Land on tab A so the editor pane is laid out, then derive its MAX scrollTop
  // (scrollHeight - clientHeight) from the DOM — the depth targets below are
  // fractions of THIS, so they adapt to whatever the doc actually renders to
  // rather than hardcoding a pixel. (We scroll to the bottom once to force CM6 to
  // measure the tail so scrollHeight reflects the real, fully-wrapped height, then
  // reset.)
  await tabByName(page, 'alpha.md').locator('.tab-label').click();
  await expect(activeTabName(page)).toHaveText('alpha.md');
  await settle(page);
  await previewLedDeepAndSync(page, 1_000_000); // saturate at the bottom → measure tail
  await settle(page);
  await settle(page);
  const maxScroll = await editorMaxScroll(page);
  expect(maxScroll, 'editor must be tall enough to sweep depths').toBeGreaterThan(3000);
  const clientH = await page.evaluate(
    () => document.querySelector<HTMLElement>('.pane-editor .cm-scroller')!.clientHeight,
  );

  // The DEPTH sweep — the new axis. The #18 undershoot scales with the number of
  // ESTIMATED above-anchor lines, so deeper anchors stress the height-warming
  // sweep harder (it must warm more bands). Cover shallow → near-bottom. Near
  // bottom is expressed as "within ~1.5 screenfuls of max" so it sits genuinely
  // close to the editor's maximum scrollTop regardless of doc height.
  const DEPTHS: Array<{ label: string; target: number }> = [
    { label: 'shallow', target: Math.min(maxScroll, 1500) }, // ~line 30
    { label: 'mid', target: Math.round(maxScroll * 0.45) }, // ~45% of range
    { label: 'deep', target: Math.round(maxScroll * 0.75) }, // ~75% of range
    { label: 'near-bottom', target: Math.max(0, maxScroll - Math.round(clientH * 1.5)) },
  ];

  // Observation-delay sweep after returning to A: 0/1/2/4 rAF + ms tails. 0/1-rAF
  // catch the bug before measures settle; the ms tails catch post-refinement drift.
  const OBS: Array<{ rafs: number; ms: number }> = [
    { rafs: 0, ms: 0 }, // synchronous — estimates, no refinement yet
    { rafs: 1, ms: 0 }, // one frame — the 2-shot align's last shot
    { rafs: 2, ms: 0 },
    { rafs: 4, ms: 0 },
    { rafs: 0, ms: 250 }, // post-refinement drift, well past the 2-shot align
  ];
  const DWELL = [0, 50, 200]; // ms on B before switching back

  // A handful of cycles per depth (one per OBS entry, paths alternated), so the
  // obs sweep + both switch paths are exercised at EVERY depth without ballooning
  // runtime (4 depths * 5 cycles = 20 switch round-trips).
  const CYCLES_PER_DEPTH = OBS.length;

  for (const depth of DEPTHS) {
    // Scroll tab A to THIS depth (preview-led, synced), then settle so the
    // reference is read once CM6 has measured the now-visible region.
    await previewLedDeepAndSync(page, depth.target);
    await settle(page);
    await settle(page);

    const aEditorRef = await editorTopLine(page);
    const aScrollRef = await editorScrollTop(page);
    const aPreviewRef = await previewTopLine(page);
    if (process.env.DIAG) {
      const pv = await page.evaluate(() => {
        const ps = document.querySelector<HTMLElement>('.preview-scroll')!;
        const cm = document.querySelector<HTMLElement>('.pane-editor .cm-scroller')!;
        return {
          pTop: ps.scrollTop,
          pMax: ps.scrollHeight - ps.clientHeight,
          eTop: cm.scrollTop,
          eMax: cm.scrollHeight - cm.clientHeight,
        };
      });
      // eslint-disable-next-line no-console
      console.log(
        `[#18 PRECOND] depth=${depth.label} eLine=${aEditorRef.toFixed(1)} pLine=${aPreviewRef.toFixed(1)} eTop=${pv.eTop}/${pv.eMax} pTop=${pv.pTop}/${pv.pMax}`,
      );
    }
    const near = `depth=${depth.label}(target≈${depth.target}/max=${maxScroll}) landedScroll=${aScrollRef} landedLine=${aEditorRef.toFixed(1)}`;
    expect(aEditorRef, `precondition: A scrolled deep — ${near}`).toBeGreaterThan(10);
    expect(
      Math.abs(aEditorRef - aPreviewRef),
      `precondition: A editor/preview synced — ${near}`,
    ).toBeLessThanOrEqual(3);

    for (let i = 0; i < CYCLES_PER_DEPTH; i++) {
      // Start each cycle from a fully-settled tab A reference.
      await settle(page);
      const beforeEditor = await editorTopLine(page);
      const beforeScroll = await editorScrollTop(page);

      const obs = OBS[i % OBS.length];
      const dwell = DWELL[i % DWELL.length];

      // A -> B. Alternate the switch path: TabStrip click on even cycles, the
      // Ctrl+Tab onNextTab mock on odd cycles (covers BOTH paths into switchTo).
      if (i % 2 === 0) {
        await tabByName(page, 'bravo.md').locator('.tab-label').click();
      } else {
        await fireNextTab(page); // two tabs → next wraps A->B
      }
      await expect(activeTabName(page)).toHaveText('bravo.md');
      if (dwell > 0) await page.waitForTimeout(dwell);

      // B -> A (the tab under test).
      if (i % 2 === 0) {
        await tabByName(page, 'alpha.md').locator('.tab-label').click();
      } else {
        await fireNextTab(page); // wraps B->A
      }
      await expect(activeTabName(page)).toHaveText('alpha.md');

      // Observe at the swept delay — possibly synchronously (0 rAF), before CM6
      // has refined its wrapped-line height map.
      await observeAfter(page, obs.rafs, obs.ms);

      const afterEditor = await editorTopLine(page);
      const afterPreview = await previewTopLine(page);
      const afterScroll = await editorScrollTop(page);

      const detail =
        `${near} cycle=${i} obs=${obs.rafs}raf+${obs.ms}ms dwellB=${dwell}ms path=${i % 2 === 0 ? 'click' : 'ctrlTab'} ` +
        `beforeEditor=${beforeEditor.toFixed(1)} afterEditor=${afterEditor.toFixed(1)} ` +
        `afterPreview=${afterPreview.toFixed(1)} aEditorRef=${aEditorRef.toFixed(1)} ` +
        `beforeScroll=${beforeScroll} afterScroll=${afterScroll} aScrollRef=${aScrollRef} ` +
        `expectedScroll=${aScrollRef} receivedScroll=${afterScroll} expectedLine=${aEditorRef.toFixed(1)} receivedLine=${afterEditor.toFixed(1)}`;

      if (process.env.DIAG) {
        // eslint-disable-next-line no-console
        console.log(`[#18 DIAG] ${detail} | dLine=${(afterEditor - aEditorRef).toFixed(1)} dScroll=${afterScroll - aScrollRef}`);
        continue;
      }

      // Hard gate (compatible with the scrollSnapshot fix): once the editor is
      // restored it must be on the RIGHT PIXEL/line and IN SYNC with the preview.
      //
      // (a) The truest, most-direct signal of the height-refinement race: the
      // editor's RAW scrollTop must come back to its OWN stashed pixel. The
      // bounded warm sweep must warm every above-anchor band at THIS depth — at
      // near-bottom that is nearly the whole doc. ±25px tolerates rounding only.
      expect(
        Math.abs(afterScroll - aScrollRef),
        `editor scrollTop NOT restored — height-refinement undershoot: ${detail}`,
      ).toBeLessThanOrEqual(25);
      // (b) The editor must be on tab A's stashed top line (not snapped to top).
      expect(afterEditor, `editor snapped to top / too shallow: ${detail}`).toBeGreaterThan(10);
      expect(
        Math.abs(afterEditor - aEditorRef),
        `editor restored to the WRONG line (vs A's stashed top): ${detail}`,
      ).toBeLessThanOrEqual(1);
      // (c) Editor and preview agree — no pending jump a later scroll would heal.
      expect(
        Math.abs(afterEditor - afterPreview),
        `editor out of sync with preview after switch: ${detail}`,
      ).toBeLessThanOrEqual(2);
    }
  }
});

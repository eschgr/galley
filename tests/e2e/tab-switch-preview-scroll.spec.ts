import { test, expect, type Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';

// REGRESSION (issue #18, split-view tab switch — the PREVIEW pane jump):
//
// The user's real complaint is that in SPLIT view, switching tabs lands the
// rendered PREVIEW pane at the WRONG scroll position (the editor pane is fine).
// The prior suite (tab-switch-scroll.spec.ts) MISSED this: it only asserted the
// EDITOR, and used text-only fixtures whose preview height is final at HTML
// commit, so the preview never reflowed and the clamp never bit.
//
// Root cause (this test exercises it): the preview restore is a one-shot,
// synchronous `previewRef.setScrollTop(savedPx)` in App's [activeId]
// useLayoutEffect (App.tsx:388-397 -> Preview.tsx:107-109, a NATIVE
// `.preview-scroll` scrollTop assignment). On a tab switch the whole preview HTML
// is swapped (`dangerouslySetInnerHTML` on a new `source`), so the scroller's
// children are brand-new nodes. The restore fires in that SAME synchronous frame,
// BEFORE the newly-committed large images and KaTeX blocks have been laid out at
// their full height, so the scroller's scrollHeight is still SMALLER than its
// final height. The browser CLAMPS the assignment to (scrollHeight - clientHeight)
// — short of the saved px. Layout then settles and the content grows back to full
// height, but NOTHING re-asserts the saved px (SplitView.onPreviewLayout only
// re-aligns the EDITOR to the preview, never the preview to its own stash), so the
// preview is left STRANDED far ABOVE where it belongs. The miss is largest at deep
// / near-bottom positions (the clamp eats the most) and is visible at every
// observation delay because, once stranded, nothing recovers it.
//
// The fixtures below make the preview's height NOT-yet-final at the synchronous
// restore: several LARGE `data:image/png` images (a tall base64 PNG, default
// 2000x6000, with NO width/height attributes) interleaved THROUGH the doc — above
// and within the restored region — plus KaTeX display math. At that bitmap size
// the new <img> elements are not laid out at full height in the restore's frame,
// which is what triggers the clamp. (Small images lay out synchronously from cache
// and do NOT reproduce it — verified by probing; 2000x6000 reliably does.) The two
// tabs get DIFFERENT image/math placement so a clamp lands them on visibly
// different wrong positions.
//
// This test asserts the PREVIEW's OWN stashed scrollTop/top line is restored —
// NOT "editor matches preview". It MUST currently FAIL: the preview comes back
// clamped too high after a switch and stays there through the reflow window.
//
// A correct fix re-asserts the preview's OWN saved px through its reflow-settle
// window (image decode/onload + a bounded re-apply on each preview layout-settle
// until scrollHeight has grown enough that the px is no longer clamped), staying
// INDEPENDENT of the editor. That fix makes the preview land on the stashed px at
// every observation delay (once content has laid out) and stay there — satisfying
// the assertions below.

type MockFile = { path: string; content: string; hash: string };

// --- A tall base64 PNG with NO width/height attributes -----------------------
// Generated in-process (node:zlib, no extra deps). Intrinsic size 2000x6000 with
// max-width:100% in the preview => it scales to the pane width but stays THOUSANDS
// of px tall. It carries NO width/height attribute in the markdown, so its box
// height is only known once the bitmap is laid out. At this size the new <img>
// nodes created by the tab-switch HTML swap are not laid out at full height in the
// same synchronous frame as App's one-shot restore, so the scroller is briefly
// SHORT and the saved scrollTop is clamped — the bug under test.
function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}
// A distinct tall PNG per `seed` so the browser can't share one decoded image
// across all <img> tags (each must lay out independently). The images are LARGE
// (default 2000x6000) on purpose: at that bitmap size, when the preview's HTML is
// swapped on a tab switch the new <img> elements are not laid out at their full
// height in the SAME synchronous frame as App's one-shot setScrollTop(savedPx),
// so the scroller is briefly SHORT and the assignment is clamped too high. Smaller
// images (600x900) lay out synchronously from cache and do NOT reproduce the bug;
// 2000x6000 reliably does. (Probed empirically — see the spec history.)
function tallPngDataUrl(seed: number, w = 2000, h = 6000): string {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type 2 (RGB)
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = (x * 7 + seed * 53) % 256;
    row[1 + x * 3 + 1] = (x * 3 + seed * 17) % 256;
    row[1 + x * 3 + 2] = (seed * 101) % 256;
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const idat = deflateSync(raw);
  const png = Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

// --- Reflowing fixtures ------------------------------------------------------
// A long doc (scrolls a couple screens) whose PREVIEW grows after HTML commit:
//   * tall data: images on their OWN lines (block paragraphs → own anchor, and
//     each grows from ~0 to its full height on decode), placed at `imgEvery`
//     paragraphs — interleaved THROUGH the doc so growth happens both ABOVE and
//     WITHIN the restored region;
//   * KaTeX display-math blocks ($$...$$) at `mathEvery` paragraphs — these also
//     lay out after commit, adding height.
// Tab A and tab B use DIFFERENT image/math placement (different `imgSeed` start
// and cadence), so an identical clamped scrollTop maps to visibly different wrong
// reading positions per tab — a clamp can't coincidentally look right on both.
const PARAS = 40;
function reflowDoc(label: string, imgEvery: number, mathEvery: number, imgSeed: number): string {
  const out: string[] = [`# ${label}`, ''];
  let seed = imgSeed;
  for (let i = 0; i < PARAS; i++) {
    out.push(`P${i} ${label}: a paragraph of body text that anchors a source line for the preview.`);
    out.push('');
    if (i % imgEvery === 0) {
      // Image on its own line → its own block paragraph + data-source-line anchor.
      // NO width/height attribute → its box height is only set once the (large)
      // bitmap lays out, after the synchronous restore — which is what clamps it.
      out.push(`![fig ${label} ${i}](${tallPngDataUrl(seed++)})`);
      out.push('');
    }
    if (i % mathEvery === 0) {
      out.push('$$');
      out.push(`\\sum_{k=0}^{${i}} \\frac{x^k}{k!} = e^x \\quad (${label})`);
      out.push('$$');
      out.push('');
    }
  }
  return out.join('\n') + '\n';
}

// --- Mock main-process bridge (mirrors tab-switch-scroll.spec.ts) ------------
async function installMockBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const harness: {
      openCb: ((f: MockFile) => void) | null;
      nextTabCb: (() => void) | null;
      prevTabCb: (() => void) | null;
    } = { openCb: null, nextTabCb: null, prevTabCb: null };
    (window as unknown as { __mock: typeof harness }).__mock = harness;
    (window as unknown as { mdtool: unknown }).mdtool = {
      platform: 'win32',
      version: '0.0.0-test',
      openExternal: async () => {},
      openLocalFile: () => {},
      setSourceVisible: async () => {},
      setActiveDocPath: () => {},
      getStartupFile: async () => null,
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

async function fireNextTab(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { __mock: { nextTabCb: () => void } }).__mock.nextTabCb(),
  );
}

const tabByName = (page: Page, name: string) => page.locator('.tab', { hasText: name });
const activeTabName = (page: Page) => page.locator('.tab.is-active .tab-name');

async function setupSplit(page: Page, aContent: string, bContent: string): Promise<void> {
  await openFile(page, { path: 'C:\\docs\\alpha.md', content: aContent, hash: 'ha' });
  await openFile(page, { path: 'C:\\docs\\bravo.md', content: bContent, hash: 'hb' });
  await page.locator('.source-toggle').click(); // Show Source → split view
  await expect(page.locator('.pane-editor')).toBeVisible();
}

// --- PREVIEW geometry helpers ------------------------------------------------

/** Raw scroll offset of the rendered PREVIEW pane (what the bug strands). */
const previewScrollTop = (page: Page) =>
  page.evaluate(() => document.querySelector<HTMLElement>('.preview-scroll')!.scrollTop);

const previewScrollHeight = (page: Page) =>
  page.evaluate(() => document.querySelector<HTMLElement>('.preview-scroll')!.scrollHeight);

const previewMaxScroll = (page: Page) =>
  page.evaluate(() => {
    const ps = document.querySelector<HTMLElement>('.preview-scroll')!;
    return Math.max(0, ps.scrollHeight - ps.clientHeight);
  });

const previewClientHeight = (page: Page) =>
  page.evaluate(() => document.querySelector<HTMLElement>('.preview-scroll')!.clientHeight);

/** The (fractional) 0-based source line shown at the top of the PREVIEW. */
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

// Drive the PREVIEW (as the leader) to a target scrollTop with a real pointer
// hover + wheel (SplitView picks the leader from onPointerEnter, so a synthetic
// wheel wouldn't make a pane the leader). The editor follows; we don't care where
// the editor lands — only the preview is under test here. Stops when the preview
// reaches the requested scrollTop, saturates at its own max, or stalls.
async function previewLedTo(page: Page, targetPx: number): Promise<void> {
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('.preview-scroll')!.scrollTop = 0;
    const cm = document.querySelector<HTMLElement>('.pane-editor .cm-scroller');
    if (cm) cm.scrollTop = 0;
  });
  await page.locator('.pane-preview').hover(); // pointer-over preview → it leads
  let prev = -1;
  let stall = 0;
  await expect
    .poll(
      async () => {
        const g = await page.evaluate(() => {
          const ps = document.querySelector<HTMLElement>('.preview-scroll')!;
          return { top: ps.scrollTop, max: ps.scrollHeight - ps.clientHeight, client: ps.clientHeight };
        });
        if (g.top >= targetPx) return g.top;
        if (g.max - g.top <= 2) return g.top; // saturated at preview's own max
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
  await page.mouse.move(0, 0); // pointer off the preview so it doesn't lead during switches
}

// Observe at a chosen number of rAFs (0 = synchronous, before decode runs) plus
// an optional ms tail. 0/1/2 rAF catch the clamp at its worst (images not yet
// decoded); the ms tail catches whether the preview STAYS correct after reflow.
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

// Fully settle the PREVIEW: wait until its scrollHeight stops changing (all
// data: images decoded + KaTeX laid out), so a reference read reflects the
// fully-grown height.
async function settlePreview(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const h1 = await previewScrollHeight(page);
        await page.waitForTimeout(120);
        const h2 = await previewScrollHeight(page);
        return h1 === h2 ? h2 : -1;
      },
      { timeout: 15_000, intervals: [120] },
    )
    .toBeGreaterThan(0);
  await page.waitForTimeout(120);
}

test.beforeEach(async ({ page }) => {
  // This spec sweeps depth × observation-timing over LARGE data: images (async
  // decode + settle per cycle), which legitimately exceeds the 30s default —
  // scope the larger budget to this spec rather than the whole config.
  test.setTimeout(180_000);
  await installMockBridge(page);
  await page.goto('/');
});

// REGRESSION (issue #18 — the PREVIEW pane lands at the WRONG scroll position on
// tab switch). Sweeps depth × observation-timing across many A->B->A cycles via
// BOTH the TabStrip click and Ctrl+Tab paths, and asserts the PREVIEW returns to
// its OWN stashed scrollTop/top line — including a near-bottom depth (largest
// clamp miss) and pre-settle observations (0/1/2 rAF, ~16/50ms) plus a 250-400ms
// tail (must STAY correct after reflow, not land-then-drift).
test('split view: switching tabs restores the PREVIEW scroll position through image/math reflow (#18)', async ({
  page,
}) => {
  // DIFFERENT image/math placement per tab so a clamped scrollTop maps to
  // visibly different wrong positions on the two tabs.
  await setupSplit(page, reflowDoc('Alpha', 6, 9, 1), reflowDoc('Bravo', 4, 7, 500));

  // Land on tab A and FULLY settle so its preview reaches final (fully-decoded)
  // height; derive depth targets from that real max.
  await tabByName(page, 'alpha.md').locator('.tab-label').click();
  await expect(activeTabName(page)).toHaveText('alpha.md');
  await settlePreview(page);
  // Warm tab B's images too (open it once, settle, return), so the difference we
  // observe after a switch is the RESTORE clamp, not first-ever decode of B.
  await tabByName(page, 'bravo.md').locator('.tab-label').click();
  await expect(activeTabName(page)).toHaveText('bravo.md');
  await settlePreview(page);
  await tabByName(page, 'alpha.md').locator('.tab-label').click();
  await expect(activeTabName(page)).toHaveText('alpha.md');
  await settlePreview(page);

  const maxScroll = await previewMaxScroll(page);
  const clientH = await previewClientHeight(page);
  expect(maxScroll, 'preview must be tall enough to sweep depths').toBeGreaterThan(2000);

  const DEPTHS: Array<{ label: string; target: number }> = [
    { label: 'shallow', target: Math.min(maxScroll, 1200) },
    { label: 'mid', target: Math.round(maxScroll * 0.5) },
    { label: 'deep', target: Math.round(maxScroll * 0.78) },
    { label: 'near-bottom', target: Math.max(0, maxScroll - Math.round(clientH * 0.6)) },
  ];

  // Pre-settle observations (clamp worst, before decode) + a post-settle tail
  // (must STAY correct after reflow).
  const OBS: Array<{ rafs: number; ms: number }> = [
    { rafs: 0, ms: 0 },
    { rafs: 1, ms: 0 },
    { rafs: 2, ms: 0 },
    { rafs: 0, ms: 16 },
    { rafs: 0, ms: 50 },
    { rafs: 0, ms: 350 }, // post-reflow tail
  ];
  const DWELL = [0, 60, 200];
  const CYCLES_PER_DEPTH = OBS.length;

  for (const depth of DEPTHS) {
    // Scroll tab A to THIS depth (preview-led), then FULLY settle so the stashed
    // reference reflects the fully-decoded height.
    await previewLedTo(page, depth.target);
    await settlePreview(page);

    const refScroll = await previewScrollTop(page);
    const refLine = await previewTopLine(page);
    const refScrollHeight = await previewScrollHeight(page);
    const near = `depth=${depth.label}(target≈${depth.target}/max=${maxScroll}) refScroll=${refScroll} refLine=${refLine.toFixed(1)} refSH=${refScrollHeight}`;
    expect(refScroll, `precondition: A preview scrolled deep — ${near}`).toBeGreaterThan(200);

    for (let i = 0; i < CYCLES_PER_DEPTH; i++) {
      const obs = OBS[i % OBS.length];
      const dwell = DWELL[i % DWELL.length];

      // A -> B (alternate click / Ctrl+Tab).
      if (i % 2 === 0) await tabByName(page, 'bravo.md').locator('.tab-label').click();
      else await fireNextTab(page);
      await expect(activeTabName(page)).toHaveText('bravo.md');
      if (dwell > 0) await page.waitForTimeout(dwell);

      // B -> A (the tab under test).
      if (i % 2 === 0) await tabByName(page, 'alpha.md').locator('.tab-label').click();
      else await fireNextTab(page);
      await expect(activeTabName(page)).toHaveText('alpha.md');

      // Observe the PREVIEW at the swept delay.
      await observeAfter(page, obs.rafs, obs.ms);

      const afterScroll = await previewScrollTop(page);
      const afterLine = await previewTopLine(page);
      const afterSH = await previewScrollHeight(page);
      const afterMax = await previewMaxScroll(page);

      const detail =
        `${near} cycle=${i} obs=${obs.rafs}raf+${obs.ms}ms dwellB=${dwell}ms path=${i % 2 === 0 ? 'click' : 'ctrlTab'} ` +
        `expectedScroll=${refScroll} receivedScroll=${afterScroll} dScroll=${afterScroll - refScroll} ` +
        `expectedLine=${refLine.toFixed(1)} receivedLine=${afterLine.toFixed(1)} ` +
        `refScrollHeight=${refScrollHeight} afterScrollHeight=${afterSH} afterMaxScroll=${afterMax}`;

      // Diagnostic confirming the failure is the CLAMP, not a setup error. Two
      // shapes of the same one-shot-restore bug:
      //   * EARLY observations (0/1/2 rAF, ~16/50ms): scrollHeight has not yet
      //     grown to its reference height, so the saved px is clamped LIVE to a
      //     shorter (scrollHeight - clientHeight) — received ≈ afterMaxScroll here.
      //   * LATER/tail observations: the height has since grown back to reference,
      //     but the one-shot restore already landed at the earlier clamped px and
      //     NOTHING re-asserts the saved px, so it stays stranded BELOW reference.
      // Either way the preview is left short of its own stashed position.
      if (process.env.DIAG) {
        // eslint-disable-next-line no-console
        console.log(`[#18 DIAG] ${detail} dLine=${(afterLine - refLine).toFixed(1)}`);
      }
      if (afterScroll < refScroll - 10) {
        const liveClamped = afterMax < refScroll - 10 && Math.abs(afterScroll - afterMax) <= 30;
        // eslint-disable-next-line no-console
        console.log(
          `[#18 PREVIEW CLAMP] ${detail} => ` +
            (liveClamped
              ? `LIVE-CLAMP: scrollHeight not yet grown (afterMaxScroll ${afterMax} < reference ${refScroll}); ` +
                `received(${afterScroll}) pinned to current clampMax(${afterMax}).`
              : `STRANDED: height regrew (afterMaxScroll ${afterMax} >= reference ${refScroll}) but the one-shot restore ` +
                `was not re-asserted; received(${afterScroll}) left ${refScroll - afterScroll}px short of reference(${refScroll}).`),
        );
      }

      if (process.env.DIAG) continue; // DIAG: survey every cycle, don't fail-fast

      // (a) The PREVIEW must return to its OWN stashed px (±10), not a clamped-high
      // position. This is the bug's direct signal.
      expect(
        Math.abs(afterScroll - refScroll),
        `PREVIEW scrollTop NOT restored — clamped-too-high reflow jump: ${detail}`,
      ).toBeLessThanOrEqual(10);
      // (b) ...and on its OWN stashed top line (±1).
      expect(
        Math.abs(afterLine - refLine),
        `PREVIEW restored to the WRONG top line (vs its own stash): ${detail}`,
      ).toBeLessThanOrEqual(1);
    }
  }
});

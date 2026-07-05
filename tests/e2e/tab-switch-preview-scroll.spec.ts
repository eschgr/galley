import { test, expect, type Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';

// PREVIEW scroll across a tab switch (#26 — per-tab kept-mounted views).
//
// Originally (#18) this proved the single shared preview, whose HTML App swapped
// on every switch, landed at the WRONG scroll position: the one-shot restore was
// CLAMPED while the new tab's tall data: images / KaTeX were still laying out, and
// nothing re-asserted the saved px, so the preview was stranded too high.
//
// #26 removes that whole class of bug by construction: every open tab owns its OWN
// Preview, and all stay mounted (the inactive ones are display:none, not swapped).
// Switching tabs is just a visibility flip — the preview's scroller keeps its
// scrollTop the whole time, so there is no HTML re-swap to clamp and no restore to
// re-assert. This test now asserts that GUARANTEE directly: A's preview scroll
// survives A->B->A unchanged, at every observation delay, with NO settle/rAF
// recovery window (the old clamp-recovery assertions no longer apply).
//
// The wrap-/image-heavy fixtures are kept (and B is warmed once) so the assertion
// is meaningful: if a switch ever re-swapped or re-clamped the preview, these tall
// async-laying-out images would expose it. The position must simply be preserved.

type MockFile = { path: string; content: string; hash: string };

// --- A tall base64 PNG with NO width/height attributes -----------------------
// Intrinsic size 2000x6000 with max-width:100% in the preview => it scales to the
// pane width but stays THOUSANDS of px tall, and lays out asynchronously. Under
// the OLD shared-preview model that async growth is exactly what clamped the
// one-shot restore; under #26 it must not matter, because the scroller is never
// rebuilt on a switch.
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
const PARAS = 40;
function reflowDoc(label: string, imgEvery: number, mathEvery: number, imgSeed: number): string {
  const out: string[] = [`# ${label}`, ''];
  let seed = imgSeed;
  for (let i = 0; i < PARAS; i++) {
    out.push(`P${i} ${label}: a paragraph of body text that anchors a source line for the preview.`);
    out.push('');
    if (i % imgEvery === 0) {
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

const tabByName = (page: Page, name: string) => page.locator('.tab', { hasText: name });
const activeTabName = (page: Page) => page.locator('.tab.is-active .tab-name');

// The VISIBLE tab's preview scroller (each tab owns its own, #26).
const VIS = '.tab-view:not([hidden]) .preview-scroll';

async function setupSplit(page: Page, aContent: string, bContent: string): Promise<void> {
  await openFile(page, { path: 'C:\\docs\\alpha.md', content: aContent, hash: 'ha' });
  await openFile(page, { path: 'C:\\docs\\bravo.md', content: bContent, hash: 'hb' });
  await page.locator('.source-toggle').click(); // Show Source → split view
  // Scope to the VISIBLE tab: every open tab renders its own .pane-editor, but
  // only the active TabView is shown (#26). `.first()` could pick a hidden tab's.
  await expect(page.locator('.tab-view:not([hidden]) .pane-editor')).toBeVisible();
}

// --- PREVIEW geometry helpers (scoped to the visible tab) --------------------
const previewScrollTop = (page: Page) =>
  page.evaluate((sel) => document.querySelector<HTMLElement>(sel)!.scrollTop, VIS);

const previewScrollHeight = (page: Page) =>
  page.evaluate((sel) => document.querySelector<HTMLElement>(sel)!.scrollHeight, VIS);

const previewMaxScroll = (page: Page) =>
  page.evaluate((sel) => {
    const ps = document.querySelector<HTMLElement>(sel)!;
    return Math.max(0, ps.scrollHeight - ps.clientHeight);
  }, VIS);

const previewClientHeight = (page: Page) =>
  page.evaluate((sel) => document.querySelector<HTMLElement>(sel)!.clientHeight, VIS);

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
  }, VIS);
}

// Drive the VISIBLE preview (as the leader) to a target scrollTop with a real
// pointer hover + wheel. The editor follows; we only care about the preview here.
async function previewLedTo(page: Page, targetPx: number): Promise<void> {
  await page.evaluate((sel) => {
    document.querySelector<HTMLElement>(sel)!.scrollTop = 0;
    const cm = document.querySelector<HTMLElement>('.tab-view:not([hidden]) .cm-scroller');
    if (cm) cm.scrollTop = 0;
  }, VIS);
  await page.locator('.tab-view:not([hidden]) .pane-preview').hover(); // pointer-over → it leads
  let prev = -1;
  let stall = 0;
  await expect
    .poll(
      async () => {
        const g = await page.evaluate((sel) => {
          const ps = document.querySelector<HTMLElement>(sel)!;
          return { top: ps.scrollTop, max: ps.scrollHeight - ps.clientHeight, client: ps.clientHeight };
        }, VIS);
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
  await page.mouse.move(0, 0); // pointer off so it doesn't lead during switches
}

// Observe at a chosen number of rAFs (0 = synchronous) plus an optional ms tail.
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

// Fully settle the VISIBLE preview: wait until its scrollHeight stops changing.
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
  test.setTimeout(180_000);
  await installMockBridge(page);
  await page.goto('/');
});

// #26: switching tabs PRESERVES the preview's scroll position. With per-tab
// kept-mounted views the inactive preview keeps its scrollTop (display:none does
// not reset a scroll container in Chromium), so A's reading position survives
// A->B->A unchanged — at every observation delay, with NO settle/rAF recovery
// window. Swept across depths (incl. near-bottom) and both switch paths.
test('split view: switching tabs preserves the PREVIEW scroll position (kept-mounted views, #26)', async ({
  page,
}) => {
  // DIFFERENT image/math placement per tab, so if a switch ever re-swapped or
  // re-clamped the preview the two tabs would diverge visibly.
  await setupSplit(page, reflowDoc('Alpha', 6, 9, 1), reflowDoc('Bravo', 4, 7, 500));

  // Land on tab A and FULLY settle so its preview reaches final (fully-decoded)
  // height; derive depth targets from that real max.
  await tabByName(page, 'alpha.md').locator('.tab-label').click();
  await expect(activeTabName(page)).toHaveText('alpha.md');
  await settlePreview(page);
  // Warm tab B's images once (open it, settle, return) so any difference we see
  // after a switch is a scroll change, not first-ever decode of B.
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

  // Observe at 0/1/2 rAF and 16/50/350ms — preservation must hold immediately and
  // stay held; there is NO recovery window to wait for anymore.
  const OBS: Array<{ rafs: number; ms: number }> = [
    { rafs: 0, ms: 0 },
    { rafs: 1, ms: 0 },
    { rafs: 2, ms: 0 },
    { rafs: 0, ms: 16 },
    { rafs: 0, ms: 50 },
    { rafs: 0, ms: 350 },
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
    const near = `depth=${depth.label}(target≈${depth.target}/max=${maxScroll}) refScroll=${refScroll} refLine=${refLine.toFixed(1)}`;
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

      const detail =
        `${near} cycle=${i} obs=${obs.rafs}raf+${obs.ms}ms dwellB=${dwell}ms path=${i % 2 === 0 ? 'click' : 'ctrlTab'} ` +
        `expectedScroll=${refScroll} receivedScroll=${afterScroll} dScroll=${afterScroll - refScroll} ` +
        `expectedLine=${refLine.toFixed(1)} receivedLine=${afterLine.toFixed(1)}`;

      // (a) The PREVIEW kept its OWN scroll position (±10), immediately.
      expect(
        Math.abs(afterScroll - refScroll),
        `PREVIEW scroll not preserved across the switch: ${detail}`,
      ).toBeLessThanOrEqual(10);
      // (b) ...and the same top line (±1).
      expect(
        Math.abs(afterLine - refLine),
        `PREVIEW top line not preserved across the switch: ${detail}`,
      ).toBeLessThanOrEqual(1);
    }
  }
});

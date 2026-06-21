import { test, expect, type Page } from '@playwright/test';

// Helpers run in the page context to read scroll/line geometry the same way the
// app does (data-source-line anchors for the preview; the gutter for the editor).

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

/** The editor's top visible 0-based source line (from the gutter). */
async function editorTopLine(page: Page): Promise<number> {
  return page.evaluate(() => {
    const cm = document.querySelector<HTMLElement>('.pane-editor .cm-scroller');
    if (!cm) return -1;
    const cmTop = cm.getBoundingClientRect().top;
    let line = -1, best = Infinity;
    for (const g of document.querySelectorAll<HTMLElement>('.pane-editor .cm-gutterElement')) {
      const t = (g.textContent || '').trim();
      if (!/^\d+$/.test(t)) continue;
      const d = g.getBoundingClientRect().top - cmTop;
      if (d >= -3 && d < best) { best = d; line = +t; }
    }
    return line - 1; // 1-based gutter -> 0-based source line
  });
}

const editorPane = (page: Page) => page.locator('.pane-editor');
const previewPane = (page: Page) => page.locator('.pane-preview');
const toggle = (page: Page) => page.locator('.source-toggle');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.markdown-preview')).toBeVisible();
});

test('opens in reading mode with the source hidden', async ({ page }) => {
  await expect(toggle(page)).toHaveText('Show Source');
  await expect(editorPane(page)).toBeHidden();
  await expect(previewPane(page)).toBeVisible();
  await expect(page.locator('.split-divider')).toBeHidden();
});

test('Show Source reveals the editor on the right, view on the left', async ({ page }) => {
  await toggle(page).click();
  await expect(toggle(page)).toHaveText('Hide Source');
  await expect(editorPane(page)).toBeVisible();
  await expect(page.locator('.split-divider')).toBeVisible();

  const pv = await previewPane(page).boundingBox();
  const ed = await editorPane(page).boundingBox();
  expect(pv && ed).toBeTruthy();
  // Rendered view is to the LEFT of the source editor, with no overlap.
  expect(pv!.x).toBeLessThan(ed!.x);
  expect(Math.round(pv!.x + pv!.width)).toBeLessThanOrEqual(Math.round(ed!.x) + 8);
});

test('Hide Source returns to full-window reading', async ({ page }) => {
  await toggle(page).click();
  await expect(editorPane(page)).toBeVisible();
  await toggle(page).click();
  await expect(toggle(page)).toHaveText('Show Source');
  await expect(editorPane(page)).toBeHidden();
  await expect(page.locator('.split-divider')).toBeHidden();
});

test('renders GFM + math + highlighted code without errors', async ({ page }) => {
  const counts = await page.evaluate(() => ({
    katex: document.querySelectorAll('.markdown-preview .katex').length,
    hljs: document.querySelectorAll('.markdown-preview pre.hljs').length,
    checkboxes: document.querySelectorAll('.markdown-preview input[type="checkbox"]').length,
    errors: document.querySelectorAll('.markdown-preview .md-render-error').length,
    httpLinks: [...document.querySelectorAll('.markdown-preview a')]
      .filter((a) => /^https?:/.test(a.getAttribute('href') || '')).length,
  }));
  expect(counts.katex).toBeGreaterThan(0);
  expect(counts.hljs).toBeGreaterThan(0);
  expect(counts.checkboxes).toBeGreaterThan(0);
  expect(counts.httpLinks).toBeGreaterThan(0);
  expect(counts.errors).toBe(0);
});

test('scroll is synchronized both ways in split view (R18)', async ({ page }) => {
  await toggle(page).click();
  await expect(editorPane(page)).toBeVisible();

  // Preview leads: a wheel over it makes it the active pane (hover no longer
  // does — that let a hovered preview steal the lead while typing). Then scroll;
  // the editor should follow. Re-dispatch inside the poll so the assertion is
  // robust against the preview's anchor map still building (async ResizeObserver).
  await expect
    .poll(() =>
      page.evaluate(() => {
        const ps = document.querySelector<HTMLElement>('.preview-scroll')!;
        ps.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
        ps.scrollTop = Math.round(ps.scrollHeight * 0.5);
        ps.dispatchEvent(new Event('scroll'));
        return document.querySelector<HTMLElement>('.pane-editor .cm-scroller')!.scrollTop;
      }),
    )
    .toBeGreaterThan(50);

  // Editor leads: reset, then drive the editor; the preview should follow.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('.preview-scroll')!.scrollTop = 0;
    document.querySelector<HTMLElement>('.pane-editor .cm-scroller')!.scrollTop = 0;
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const cm = document.querySelector<HTMLElement>('.pane-editor .cm-scroller')!;
        cm.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
        cm.scrollTop = Math.round(cm.scrollHeight * 0.4);
        cm.dispatchEvent(new Event('scroll'));
        return document.querySelector<HTMLElement>('.preview-scroll')!.scrollTop;
      }),
    )
    .toBeGreaterThan(50);
});

test('keyboard-scrolling the reading pane syncs the editor (R18)', async ({ page }) => {
  await toggle(page).click();
  await expect(editorPane(page)).toBeVisible();
  // A keydown in the preview makes it the lead pane (like arrows / Page Down),
  // so scrolling it drives the editor. Re-dispatch inside the poll (see above).
  await expect
    .poll(() =>
      page.evaluate(() => {
        const ps = document.querySelector<HTMLElement>('.preview-scroll')!;
        ps.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
        ps.scrollTop = Math.round(ps.scrollHeight * 0.5);
        ps.dispatchEvent(new Event('scroll'));
        return document.querySelector<HTMLElement>('.pane-editor .cm-scroller')!.scrollTop;
      }),
    )
    .toBeGreaterThan(50);
});

test('revealing the source aligns the editor to the line being read (regression)', async ({ page }) => {
  // Scroll the reading view to a deep line while the source is hidden...
  await page.evaluate(() => {
    const ps = document.querySelector<HTMLElement>('.preview-scroll')!;
    ps.scrollTop = Math.round(ps.scrollHeight * 0.5);
    ps.dispatchEvent(new Event('scroll'));
  });
  const before = await previewTopLine(page);
  expect(before).toBeGreaterThan(5); // actually scrolled somewhere meaningful

  // ...then reveal it. The editor should open near that same line, not at the top.
  await toggle(page).click();
  await expect(editorPane(page)).toBeVisible();
  await page.waitForTimeout(400); // let measure + reflow + re-align settle

  const previewAfter = await previewTopLine(page);
  const editor = await editorTopLine(page);
  expect(editor).toBeGreaterThan(5); // not stuck at the top (the original bug)
  expect(Math.abs(editor - previewAfter)).toBeLessThanOrEqual(3);
});

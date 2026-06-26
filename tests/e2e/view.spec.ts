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

  // The new model picks the leader from a REAL pointer-over (onPointerEnter) or
  // focus — a synthetic WheelEvent no longer makes a pane the leader. So drive
  // each direction with a real hover + real wheel (page.mouse.wheel), the same
  // way tab-switch-scroll.spec.ts does. Wheel a moderate amount, well clear of
  // the bottom, so the #18 co-arrival blend doesn't skew the follower; poll
  // because the anchor map builds async (ResizeObserver) and the wheel is
  // incremental. Move the pointer off between directions so the prior leader
  // doesn't linger.

  // Editor leads: hover the editor pane, wheel it down; the preview should follow.
  await page.locator('.pane-editor').hover();
  await expect
    .poll(async () => {
      const ed = await page.evaluate(
        () => document.querySelector<HTMLElement>('.pane-editor .cm-scroller')!.scrollTop,
      );
      if (ed < 700) await page.mouse.wheel(0, 400);
      return page.evaluate(
        () => document.querySelector<HTMLElement>('.preview-scroll')!.scrollTop,
      );
    })
    .toBeGreaterThan(50);
  await page.mouse.move(0, 0);

  // Reset both panes to the top, then drive the OTHER direction.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('.preview-scroll')!.scrollTop = 0;
    document.querySelector<HTMLElement>('.pane-editor .cm-scroller')!.scrollTop = 0;
  });

  // Preview leads: hover the preview pane, wheel it down; the editor should follow.
  await page.locator('.pane-preview').hover();
  await expect
    .poll(async () => {
      const pv = await page.evaluate(
        () => document.querySelector<HTMLElement>('.preview-scroll')!.scrollTop,
      );
      if (pv < 700) await page.mouse.wheel(0, 400);
      return page.evaluate(
        () => document.querySelector<HTMLElement>('.pane-editor .cm-scroller')!.scrollTop,
      );
    })
    .toBeGreaterThan(50);
  await page.mouse.move(0, 0);
});

test('keyboard-scrolling the reading pane syncs the editor (R18)', async ({ page }) => {
  await toggle(page).click();
  await expect(editorPane(page)).toBeVisible();

  // The new model's focus-fallback leader: with the pointer over neither pane,
  // the leader is the FOCUSED pane. `.preview-scroll` is tabIndex=0, so giving
  // it real focus fires onFocusCapture on .pane-preview (focusedPane='preview')
  // and makes the reading pane keyboard-scrollable. A real keypress (Page Down)
  // then scrolls it for real, and onPreviewScroll drives the editor. Poll
  // because the anchor map builds async and each keypress advances incrementally.
  await page.locator('.preview-scroll').focus();
  await expect
    .poll(async () => {
      const pv = await page.evaluate(
        () => document.querySelector<HTMLElement>('.preview-scroll')!.scrollTop,
      );
      if (pv < 700) await page.keyboard.press('PageDown');
      return page.evaluate(
        () => document.querySelector<HTMLElement>('.pane-editor .cm-scroller')!.scrollTop,
      );
    })
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

test('clicking an in-page anchor link jumps to that heading (R4)', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 320 }); // short, so the target is below the fold
  await page.goto('/');
  await toggle(page).click(); // Show Source
  await expect(editorPane(page)).toBeVisible();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+a');
  const filler = Array.from({ length: 16 }, (_, i) => `Filler paragraph number ${i}.`).join('\n\n');
  await page.keyboard.type(`[jump to target](#target-heading)\n\n${filler}\n\n## Target heading\n`);

  const scrollTop = () => page.evaluate(() => document.querySelector<HTMLElement>('.preview-scroll')!.scrollTop);
  // Typing left the cursor (and the preview) at the bottom; reset to the top so
  // the link is in view and the target heading is below the fold. First take the
  // leader away from the editor — pointer off both panes, focus on the preview —
  // so a TRAILING editor scroll from the last keystroke can't re-run follow-sync
  // and drive the preview back off 0 after we reset it (a sub-1% race otherwise).
  await page.mouse.move(0, 0);
  await page.locator('.preview-scroll').focus();
  await page.evaluate(() => (document.querySelector<HTMLElement>('.preview-scroll')!.scrollTop = 0));
  expect(await scrollTop()).toBe(0);
  await page.locator('.markdown-preview a', { hasText: 'jump to target' }).click();
  await expect.poll(scrollTop).toBeGreaterThan(20); // jumped down to the heading
});

test('the preview pane fits within the window — no overflow past the bottom', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 500 });
  await page.goto('/');
  const { bottom, inner } = await page.evaluate(() => {
    const ps = document.querySelector('.preview-scroll')!;
    return { bottom: ps.getBoundingClientRect().bottom, inner: window.innerHeight };
  });
  expect(bottom).toBeLessThanOrEqual(inner + 1); // the scroll container's bottom edge is on-screen
});

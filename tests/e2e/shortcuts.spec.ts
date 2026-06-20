import { test, expect, type Page } from '@playwright/test';

// Formatting shortcuts (R23–R28) and the link dialog (R27), driven through the
// real renderer. These need no main-process bridge — they operate purely on the
// CodeMirror editor — so we use the built-in welcome sample, clear it, and type
// fresh content. Assertions read the raw editor lines (CodeMirror shows markdown
// source), which is the most direct check of what each shortcut produced.

const MOD = 'Control'; // CI/dev run on win/linux, where CodeMirror's Mod = Ctrl

async function setEditor(page: Page, content: string): Promise<void> {
  await page.goto('/');
  await page.locator('.source-toggle').click(); // Show Source
  await expect(page.locator('.pane-editor')).toBeVisible();
  const cm = page.locator('.cm-content');
  await cm.click();
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.type(content);
}

/** Raw text of editor line `i` (CodeMirror renders markdown source verbatim). */
function lineText(page: Page, i = 0): Promise<string> {
  return page.evaluate(
    (idx) => document.querySelectorAll('.cm-content .cm-line')[idx]?.textContent ?? '',
    i,
  );
}

async function selectAllText(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+a`);
}

test('bold wraps the selection and toggles back off (R24)', async ({ page }) => {
  await setEditor(page, 'bold');
  await selectAllText(page);
  await page.keyboard.press(`${MOD}+b`);
  await expect.poll(() => lineText(page)).toBe('**bold**');
  await selectAllText(page);
  await page.keyboard.press(`${MOD}+b`);
  await expect.poll(() => lineText(page)).toBe('bold');
});

test('the source editor highlights with colour only — no enlarged or bold tokens (R19)', async ({ page }) => {
  await setEditor(page, '# Heading with **bold**');
  const s = await page.evaluate(() => {
    const content = document.querySelector('.cm-content') as HTMLElement;
    const base = getComputedStyle(content);
    const spans = [...document.querySelectorAll('.cm-content .cm-line span')] as HTMLElement[];
    return {
      baseSize: base.fontSize,
      baseColor: base.color,
      sizes: spans.map((el) => getComputedStyle(el).fontSize),
      weights: spans.map((el) => getComputedStyle(el).fontWeight),
      colors: spans.map((el) => getComputedStyle(el).color),
    };
  });
  // No token is enlarged or bold (it reads as source, not rendered markdown)...
  for (const size of s.sizes) expect(size).toBe(s.baseSize);
  for (const weight of s.weights) expect(Number(weight)).toBeLessThan(700);
  // ...but colour highlighting is still applied (at least one token differs).
  expect(s.colors.some((c) => c !== s.baseColor)).toBe(true);
});

test('toggling from a bare cursor inside a span removes the whole span (R24)', async ({ page }) => {
  await setEditor(page, '**Hello world**');
  await page.keyboard.press('Home');
  for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight'); // "**Hello| world**"
  await page.keyboard.press(`${MOD}+b`);
  await expect.poll(() => lineText(page)).toBe('Hello world');

  // Same for inline code with the cursor in the middle.
  await setEditor(page, '`snippet`');
  await page.keyboard.press('Home');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press(`${MOD}+e`);
  await expect.poll(() => lineText(page)).toBe('snippet');
});

test('italic, inline code, and strikethrough wrap the selection (R23)', async ({ page }) => {
  await setEditor(page, 'word');
  await selectAllText(page);
  await page.keyboard.press(`${MOD}+i`);
  await expect.poll(() => lineText(page)).toBe('_word_'); // italic uses underscores

  await setEditor(page, 'word');
  await selectAllText(page);
  await page.keyboard.press(`${MOD}+e`);
  await expect.poll(() => lineText(page)).toBe('`word`');

  await setEditor(page, 'word');
  await selectAllText(page);
  await page.keyboard.press(`${MOD}+Shift+X`);
  await expect.poll(() => lineText(page)).toBe('~~word~~');
});

test('Ctrl+Shift+Z redoes, alongside the default Ctrl+Y (R20)', async ({ page }) => {
  await setEditor(page, 'base');
  await page.waitForTimeout(600); // break the undo grouping from setup
  await page.keyboard.press('End');
  await page.keyboard.type('X');
  await expect.poll(() => lineText(page)).toBe('baseX');

  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => lineText(page)).toBe('base');
  await page.keyboard.press(`${MOD}+y`); // default redo
  await expect.poll(() => lineText(page)).toBe('baseX');

  await page.keyboard.press(`${MOD}+z`);
  await expect.poll(() => lineText(page)).toBe('base');
  // A faithful Ctrl+Shift+Z carries key="Z" + keyCode 90; Playwright's press()
  // emits lowercase "z", which CodeMirror routes to the Ctrl+Z undo binding. So
  // dispatch the real-shaped event to exercise our redo binding.
  await page.evaluate(() => {
    document.querySelector('.cm-content')!.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Z', code: 'KeyZ', keyCode: 90, which: 90,
        ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }),
    );
  });
  await expect.poll(() => lineText(page)).toBe('baseX');
});

test('heading normalizes to the requested level, not stacking (R24)', async ({ page }) => {
  await setEditor(page, 'Title');
  await page.keyboard.press(`${MOD}+2`);
  await expect.poll(() => lineText(page)).toBe('## Title');
  await page.keyboard.press(`${MOD}+4`); // switch level, do not stack
  await expect.poll(() => lineText(page)).toBe('#### Title');
  await page.keyboard.press(`${MOD}+4`); // same level removes
  await expect.poll(() => lineText(page)).toBe('Title');
});

test('fenced code block wraps the line on its own fences (R23)', async ({ page }) => {
  await setEditor(page, 'x = 1');
  await selectAllText(page);
  await page.keyboard.press(`${MOD}+Shift+C`);
  await expect.poll(() => lineText(page, 0)).toBe('```');
  await expect.poll(() => lineText(page, 1)).toBe('x = 1');
  await expect.poll(() => lineText(page, 2)).toBe('```');
});

test('Tab indents a list item at the line start; Shift+Tab outdents (R26)', async ({ page }) => {
  await setEditor(page, '- item');
  await page.keyboard.press('Home'); // cursor at the start of the list line
  await page.keyboard.press('Tab');
  await expect.poll(() => lineText(page)).toBe('  - item');
  await page.keyboard.press('Shift+Tab');
  await expect.poll(() => lineText(page)).toBe('- item');
});

test('Tab nests a list item from anywhere on the line; numbered markers stay "1." (R26)', async ({ page }) => {
  await setEditor(page, '1. item'); // cursor ends inside the item text, not at line start
  await page.keyboard.press('Tab');
  await expect.poll(() => lineText(page)).toBe('  1. item'); // whole item nested, marker preserved
  await page.keyboard.press('Shift+Tab');
  await expect.poll(() => lineText(page)).toBe('1. item');
});

test('Enter continues an ordered list with a fresh "1."; an empty item exits (R26b)', async ({ page }) => {
  await setEditor(page, '1. first');
  await page.keyboard.press('Enter');
  await expect.poll(() => lineText(page, 1)).toBe('1. '); // a fresh "1. ", not "2. "
  await page.keyboard.type('second');
  await expect.poll(() => lineText(page, 1)).toBe('1. second');
  await page.keyboard.press('Enter');
  await expect.poll(() => lineText(page, 2)).toBe('1. '); // empty item
  await page.keyboard.press('Enter'); // Enter on the empty item ends the list
  await expect.poll(() => lineText(page, 2)).toBe('');
});

test('Tab nests an ordered item under its parent by its content column (R26)', async ({ page }) => {
  await setEditor(page, '1. line');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Home'); // clear any auto-indent on the new line
  await page.keyboard.press('Shift+End');
  await page.keyboard.press('Delete');
  await page.keyboard.type('1. stuff');
  await expect.poll(() => lineText(page, 1)).toBe('1. stuff'); // baseline: not yet nested
  await page.keyboard.press('Tab');
  await expect.poll(() => lineText(page, 1)).toBe('   1. stuff'); // 3 spaces, aligned under "1. "
  await expect.poll(() => lineText(page, 0)).toBe('1. line');
});

test('Tab in the middle of a paragraph inserts spaces at the cursor, not a line indent (R26)', async ({ page }) => {
  await setEditor(page, 'ab');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight'); // cursor between "a" and "b"
  await page.keyboard.press('Tab');
  await expect.poll(() => lineText(page)).toBe('a  b'); // spaces at the cursor, no leading indent
});

test('Ctrl+Shift+C a second time removes the fenced block (R23)', async ({ page }) => {
  await setEditor(page, 'x = 1');
  await selectAllText(page);
  await page.keyboard.press(`${MOD}+Shift+C`);
  await expect.poll(() => lineText(page, 0)).toBe('```');
  // Selection is now the inner line; pressing again must unwrap, not re-nest.
  await page.keyboard.press(`${MOD}+Shift+C`);
  await expect.poll(() => lineText(page, 0)).toBe('x = 1');
  await expect.poll(() => page.locator('.cm-content .cm-line').count()).toBe(1);
});

test('Cmd/Ctrl+K inserts a link via the dialog, prefilled from the selection (R27)', async ({ page }) => {
  await setEditor(page, 'anchor');
  await selectAllText(page);
  await page.keyboard.press(`${MOD}+k`);

  const dialog = page.locator('.modal');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.modal-title')).toHaveText('Insert link');
  // Text is prefilled from the selection; URL is focused — just type it.
  await expect(dialog.locator('.link-field', { hasText: 'Text' }).locator('input')).toHaveValue('anchor');
  await page.keyboard.type('https://example.com');
  await dialog.getByRole('button', { name: /Insert/ }).click();

  await expect(dialog).toBeHidden();
  await expect.poll(() => lineText(page)).toBe('[anchor](https://example.com)');
});

test('Cmd/Ctrl+K on an existing link opens prefilled; Remove link strips it (R27)', async ({ page }) => {
  await setEditor(page, '[anchor](https://example.com)');
  await page.keyboard.press('ArrowLeft'); // cursor inside the link span

  await page.keyboard.press(`${MOD}+k`);
  const dialog = page.locator('.modal');
  await expect(dialog.locator('.modal-title')).toHaveText('Edit link');
  await expect(dialog.locator('.link-field', { hasText: 'Text' }).locator('input')).toHaveValue('anchor');
  await expect(dialog.locator('.link-field', { hasText: 'URL' }).locator('input')).toHaveValue('https://example.com');

  await dialog.getByRole('button', { name: /Remove link/ }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => lineText(page)).toBe('anchor');
});

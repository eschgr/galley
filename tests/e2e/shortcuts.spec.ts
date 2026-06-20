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

test('italic, inline code, and strikethrough wrap the selection (R23)', async ({ page }) => {
  await setEditor(page, 'word');
  await selectAllText(page);
  await page.keyboard.press(`${MOD}+i`);
  await expect.poll(() => lineText(page)).toBe('*word*');

  await setEditor(page, 'word');
  await selectAllText(page);
  await page.keyboard.press(`${MOD}+e`);
  await expect.poll(() => lineText(page)).toBe('`word`');

  await setEditor(page, 'word');
  await selectAllText(page);
  await page.keyboard.press(`${MOD}+Shift+X`);
  await expect.poll(() => lineText(page)).toBe('~~word~~');
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

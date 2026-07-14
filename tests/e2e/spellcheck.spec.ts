import { test, expect, type Page } from '@playwright/test';
import {
  installMockBridge,
  getSpellMenuCalls,
  fireSpellReplace,
  fireDictionaryWordAdded,
  type MockFile,
} from './mockBridge';

// Whole-document spell-check (#132). These run against the real renderer (devapp),
// so the actual decoration checker loads the real ~540 KB dictionary and paints
// squiggles — the behaviour the native contenteditable checker could not deliver
// (it only flagged caret-local words, never untouched or off-screen lines).

const toggle = (page: Page) => page.locator('.source-toggle');
const editorPane = (page: Page) => page.locator('.pane-editor');
const misspelled = (page: Page) => page.locator('.pane-editor .cm-misspelled');

/** The words currently carrying a misspelled decoration in the editor viewport. */
async function misspelledWords(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.pane-editor .cm-misspelled')].map((el) => (el.textContent ?? '').trim()),
  );
}

// A short doc: prose typos across several UNTOUCHED paragraphs, a valid uncommon
// word, and a fenced code block whose "words" must be left alone.
const CODE_FENCE = '```';
const FIXTURE: MockFile = {
  path: 'C:\\docs\\spelling.md',
  content: [
    '# Spelling Review',
    '',
    'This paragraf has a mispeld word near the top.',
    '',
    'A second block with teh classic typo and a gud choice.',
    '',
    'The word obfuscate is uncommon but spelled correctly.',
    '',
    'Please recieve this note before you continue.',
    '',
    'Here is some code:',
    '',
    CODE_FENCE,
    'const helo = wrld;',
    CODE_FENCE,
    '',
    'Trailing prose with anotherr typo at the very bottom.',
    '',
  ].join('\n'),
  hash: 'h',
};

async function showSourceWithSquiggles(page: Page): Promise<void> {
  await toggle(page).click();
  await expect(editorPane(page)).toBeVisible();
  // Wait for the async engine load + first paint.
  await expect(misspelled(page).first()).toBeVisible({ timeout: 20000 });
}

test('flags misspellings across untouched lines on load, skipping code and valid words (#132)', async ({ page }) => {
  await installMockBridge(page, FIXTURE);
  await page.goto('/');
  await showSourceWithSquiggles(page);

  const flagged = await misspelledWords(page);
  // Typos on lines that were never edited or clicked into are flagged — including
  // the last paragraph — which the native checker never did.
  expect(flagged).toEqual(expect.arrayContaining(['paragraf', 'mispeld', 'teh', 'gud', 'anotherr']));
  // A valid (if uncommon) word is not a false positive...
  expect(flagged).not.toContain('obfuscate');
  // ...and words inside the fenced code block are skipped via the syntax tree.
  expect(flagged).not.toContain('helo');
  expect(flagged).not.toContain('wrld');
  expect(flagged).not.toContain('const');
});

test('checks newly revealed lines on scroll (#132)', async ({ page }) => {
  // A long doc so the tail is well off the initial viewport. An early typo gives
  // a near-top squiggle to wait on (the engine has loaded); the tail typo starts
  // off screen.
  const body: string[] = ['# Long Doc', '', 'An erly mispeld word sits up top.', ''];
  for (let i = 1; i <= 80; i++) body.push(`Line ${i} of ordinary correct prose here.`, '');
  body.push('At the very end sits a zzmispell that starts off screen.', '');
  await installMockBridge(page, { path: 'C:\\docs\\long.md', content: body.join('\n'), hash: 'h' });
  await page.goto('/');
  await showSourceWithSquiggles(page);

  // The off-screen typo isn't even rendered yet (CM mounts only the viewport).
  await expect(misspelled(page).filter({ hasText: 'zzmispell' })).toHaveCount(0);

  // Scroll to the bottom; the newly visible line gets checked.
  await page.evaluate(() => {
    const s = document.querySelector<HTMLElement>('.pane-editor .cm-scroller')!;
    s.scrollTop = s.scrollHeight;
  });
  await expect(misspelled(page).filter({ hasText: 'zzmispell' })).toHaveCount(1, { timeout: 20000 });
});

test('right-click sources suggestions from the engine and replacing fixes the word (#132)', async ({ page }) => {
  await installMockBridge(page, FIXTURE);
  await page.goto('/');
  await showSourceWithSquiggles(page);

  await page.locator('.pane-editor .cm-content').click(); // focus the editor
  const typo = misspelled(page).filter({ hasText: 'recieve' }).first();
  await typo.click({ button: 'right' });

  // The editor computed the menu params from the offline engine (not the native
  // checker), including the intended correction.
  const calls = await getSpellMenuCalls(page);
  const last = calls[calls.length - 1];
  expect(last.misspelledWord).toBe('recieve');
  expect(last.dictionarySuggestions).toContain('receive');

  // Choosing a suggestion from the (native) menu edits the word range in place.
  await fireSpellReplace(page, 'receive');
  await expect(page.locator('.pane-editor .cm-content')).toContainText('Please receive this note');
  await expect(misspelled(page).filter({ hasText: 'recieve' })).toHaveCount(0);
});

test('Add to Dictionary stops flagging the word (#132)', async ({ page }) => {
  await installMockBridge(page, FIXTURE);
  await page.goto('/');
  await showSourceWithSquiggles(page);

  await expect(misspelled(page).filter({ hasText: 'gud' })).toHaveCount(1);
  // Simulate the menu's Add to Dictionary → main persists + notifies the renderer.
  await fireDictionaryWordAdded(page, 'gud');
  await expect(misspelled(page).filter({ hasText: 'gud' })).toHaveCount(0);
});

test('words seeded from the persistent dictionary are not flagged (#132)', async ({ page }) => {
  const doc = {
    path: 'C:\\docs\\seeded.md',
    content: 'The token grumbolt is a mispeld neighbour.\n',
    hash: 'h',
  };
  // "grumbolt" was previously added to the dictionary; "mispeld" was not.
  await installMockBridge(page, doc, null, null, ['grumbolt']);
  await page.goto('/');
  await showSourceWithSquiggles(page);

  const flagged = await misspelledWords(page);
  expect(flagged).toContain('mispeld'); // proves the engine is running
  expect(flagged).not.toContain('grumbolt'); // seeded → accepted
});

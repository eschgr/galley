/**
 * Copy the bundled US-English Hunspell dictionary (affix rules + word list) out
 * of the `dictionary-en` package into `src/renderer/assets/`, where the source
 * editor's spell checker (#132) loads it at runtime via Vite's `?raw`. Run with:
 *
 *     node scripts/gen-spelldict.mjs
 *
 * `dictionary-en` is SCOWL-derived and permissively licensed (the same Kevin
 * Atkinson terms already carried for the autocomplete word list); it is a
 * devDependency used only here — the copied `en.aff` / `en.dic` are what ship.
 * The full license text lives in THIRD-PARTY-NOTICES.md.
 *
 * US English ONLY: the sibling variants in `dictionary-en`'s upstream (en-GB /
 * en-AU / en-CA) are GPL/LGPL/MPL tri-licensed, so they are deliberately not
 * pulled in — Galley is MIT and stays copyleft-free.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.join(root, 'node_modules', 'dictionary-en');
const outDir = path.join(root, 'src', 'renderer', 'assets');

// nspell ranks single-letter edits above transpositions, so the most common
// English typos (which are transpositions/doubles) fall far down the suggestion
// list — "teh" put "the" 8th. Hunspell's REP table is meant for exactly this: a
// replacement that yields a valid word is offered FIRST. The affix file already
// carries ~90 REP rules; we append these high-frequency typos so their fix leads
// the menu. Entries are unanchored `wrong right` pairs (nspell ignores ^/$
// anchors); REP only suggests when the substitution produces a real word, so
// short distinctive keys like these don't misfire on longer words.
// Only transpositions / 2-edit typos belong here: single-letter slips (recieve,
// seperate, accomodate…) already rank first by edit distance, so REP does nothing
// for them. These are the ones measured to bury their fix (rank >2 or missing).
const COMMON_TYPOS = [
  ['teh', 'the'], ['adn', 'and'], ['nad', 'and'], ['hte', 'the'],
  ['taht', 'that'], ['tehm', 'them'], ['thier', 'their'], ['wich', 'which'],
  ['becuase', 'because'], ['occured', 'occurred'], ['freind', 'friend'], ['beleive', 'believe'],
  ['basicly', 'basically'], ['peice', 'piece'], ['tounge', 'tongue'],
  ['arent', "aren't"], ['thats', "that's"], ['dont', "don't"],
];

/** Append the COMMON_TYPOS pairs to the affix file's REP table, bumping its count. */
function addRepRules(aff) {
  const extra = COMMON_TYPOS.map(([from, to]) => `REP ${from} ${to}`).join('\n');
  const patched = aff.replace(/^REP (\d+)$/m, (_m, count) => `REP ${Number(count) + COMMON_TYPOS.length}\n${extra}`);
  if (patched === aff) throw new Error('REP header not found in en.aff — cannot add typo rules');
  return patched;
}

mkdirSync(outDir, { recursive: true });

for (const [src, dest, transform] of [
  ['index.aff', 'en.aff', addRepRules],
  ['index.dic', 'en.dic', (s) => s],
]) {
  const data = transform(readFileSync(path.join(pkgDir, src), 'utf8'));
  const outPath = path.join(outDir, dest);
  writeFileSync(outPath, data, 'utf8');
  const kib = (Buffer.byteLength(data, 'utf8') / 1024).toFixed(1);
  console.log(`wrote ${outPath} (${kib} KiB)`);
}

// The .dic's first line is the entry count (Hunspell convention).
const wordCount = readFileSync(path.join(pkgDir, 'index.dic'), 'utf8').split('\n', 1)[0];
console.log(`dictionary entries: ${wordCount}`);

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

mkdirSync(outDir, { recursive: true });

for (const [src, dest] of [
  ['index.aff', 'en.aff'],
  ['index.dic', 'en.dic'],
]) {
  const data = readFileSync(path.join(pkgDir, src), 'utf8');
  const outPath = path.join(outDir, dest);
  writeFileSync(outPath, data, 'utf8');
  const kib = (Buffer.byteLength(data, 'utf8') / 1024).toFixed(1);
  console.log(`wrote ${outPath} (${kib} KiB)`);
}

// The .dic's first line is the entry count (Hunspell convention).
const wordCount = readFileSync(path.join(pkgDir, 'index.dic'), 'utf8').split('\n', 1)[0];
console.log(`dictionary entries: ${wordCount}`);

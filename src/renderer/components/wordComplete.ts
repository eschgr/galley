/**
 * Word autocomplete for the source editor (#120). A lightweight, offline,
 * heuristic completer — no model, no network: it suggests words the document
 * already uses (contextual) plus a bundled common-English dictionary (SCOWL,
 * ranked by frequency band), via CodeMirror's own autocomplete engine.
 *
 * The ranking is a pure function (rankWordMatches) so it's unit-tested without
 * CodeMirror; the rest is thin CM glue.
 */
import {
  autocompletion,
  acceptCompletion,
  moveCompletionSelection,
  startCompletion,
  closeCompletion,
  type CompletionContext,
  type CompletionResult,
  type Completion,
} from '@codemirror/autocomplete';
import { keymap, type KeyBinding } from '@codemirror/view';
import { Prec, type Extension } from '@codemirror/state';
import { WORDLIST_BY_BAND } from './wordlist.generated';

/** A dictionary word plus its SCOWL band (lower = more common). */
export interface DictEntry {
  readonly word: string;
  readonly band: number;
}

/** Don't pop up until the typed word is at least this long. */
export const MIN_PREFIX = 3;
/** Cap the suggestion list so the popup stays snappy. */
const MAX_SUGGESTIONS = 40;

/** True when `prefix` begins with an uppercase letter (so we match the case). */
function leadsUpper(prefix: string): boolean {
  const c = prefix[0];
  return !!c && c === c.toUpperCase() && c !== c.toLowerCase();
}

function capitalize(word: string): string {
  return word.length ? word[0].toUpperCase() + word.slice(1) : word;
}

/**
 * Rank word completions for `prefix`, best first. Words already in the document
 * come first (contextual), then dictionary words by SCOWL band (common first);
 * both alphabetical within a tier. A dictionary suggestion is capitalized when the
 * prefix is (typing "Doc" suggests "Documentation", not "documentation"). The
 * prefix itself and exact-length matches are excluded. Pure — no CodeMirror.
 */
export function rankWordMatches(
  prefix: string,
  docWords: Iterable<string>,
  dict: readonly DictEntry[],
  cap: number = MAX_SUGGESTIONS,
): string[] {
  const p = prefix.toLowerCase();
  if (!p) return [];
  const upper = leadsUpper(prefix);
  const seen = new Set<string>([p]);

  const doc: string[] = [];
  for (const w of docWords) {
    const lw = w.toLowerCase();
    if (lw.length > p.length && lw.startsWith(p) && !seen.has(lw)) {
      seen.add(lw);
      doc.push(w);
    }
  }
  doc.sort((a, b) => a.localeCompare(b));

  const hits: DictEntry[] = [];
  for (const e of dict) {
    if (e.word.length > p.length && e.word.startsWith(p) && !seen.has(e.word)) {
      seen.add(e.word);
      hits.push(e);
    }
  }
  hits.sort((a, b) => a.band - b.band || a.word.localeCompare(b.word));

  const out = [...doc, ...hits.map((e) => (upper ? capitalize(e.word) : e.word))];
  return out.slice(0, cap);
}

// --- CodeMirror glue --------------------------------------------------------

// The bundled dictionary, flattened once at module load.
const DICTIONARY: DictEntry[] = WORDLIST_BY_BAND.flatMap(([band, words]) =>
  words.split(' ').map((word) => ({ word, band })),
);

const WORD_BEFORE = /[A-Za-z][A-Za-z']*$/;

/** Collect the distinct words in the document (for contextual suggestions). */
function documentWords(text: string): Set<string> {
  const set = new Set<string>();
  const re = /[A-Za-z][A-Za-z']+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) set.add(m[0]);
  return set;
}

/** CodeMirror completion source backed by the doc words + SCOWL dictionary. */
export function wordCompletionSource(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(WORD_BEFORE);
  if (!before) return null;
  const prefix = before.text;
  // Auto-triggered: wait for a few characters. Explicit (Ctrl+Space): always try.
  if (!context.explicit && prefix.length < MIN_PREFIX) return null;

  const ranked = rankWordMatches(prefix, documentWords(context.state.doc.toString()), DICTIONARY);
  if (ranked.length === 0) return null;

  // Descending boost preserves our ranking through CodeMirror's own sort.
  const options: Completion[] = ranked.map((label, i) => ({ label, type: 'text', boost: ranked.length - i }));
  return { from: before.from, options, filter: false };
}

// Accept with Tab (never Enter — Enter stays a newline in prose). These commands
// no-op (return false) when the popup is closed, so they fall through to the list
// Tab / plain newline; hence they sit ABOVE the formatting keymap in precedence.
const completionKeys: readonly KeyBinding[] = [
  { key: 'Tab', run: acceptCompletion },
  { key: 'ArrowDown', run: moveCompletionSelection(true) },
  { key: 'ArrowUp', run: moveCompletionSelection(false) },
  { key: 'Mod-Space', run: startCompletion },
  { key: 'Escape', run: closeCompletion },
];

/** The full autocomplete extension: the engine + our source + the accept keymap. */
export function wordAutocomplete(): Extension {
  return [
    autocompletion({ override: [wordCompletionSource], activateOnTyping: true, defaultKeymap: false, icons: false }),
    Prec.highest(keymap.of(completionKeys)),
  ];
}

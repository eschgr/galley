/**
 * Pure word-scanning for the source editor's spell checker (#132): given the
 * document text, the ranges to CHECK (e.g. the CodeMirror viewport's visible
 * ranges), and the ranges to SKIP (e.g. fenced/inline code spans located via the
 * markdown syntax tree), it tokenizes words and returns the ranges of those the
 * injected `isCorrect` predicate rejects. No CodeMirror and no dictionary — both
 * are injected — so the tokenization, region clipping, skip-range subtraction,
 * and the short-word/acronym heuristics are all unit-tested in isolation.
 */

/** A half-open character range [from, to) in the document. */
export interface Range {
  readonly from: number;
  readonly to: number;
}

export interface MisspellOptions {
  /** Words shorter than this are never flagged (skips stray single letters). */
  readonly minLength?: number;
  /** Skip all-uppercase tokens (ACRONYMS, HTTP) — the usual editor heuristic. */
  readonly skipAllCaps?: boolean;
}

const DEFAULTS: Required<MisspellOptions> = { minLength: 2, skipAllCaps: true };

// A word: letters with internal apostrophes (don't, it's) but no leading or
// trailing ones, so a possessive plural's dangling ' isn't pulled into the token.
const WORD_RE = /[A-Za-z]+(?:'[A-Za-z]+)*/g;

/** True when `word` has an uppercase letter and no lowercase one (an ACRONYM). */
function isAllCaps(word: string): boolean {
  return word === word.toUpperCase() && word !== word.toLowerCase();
}

/**
 * Whether [from,to) overlaps any skip range. `skip` is assumed sorted ascending
 * by `from`, so once a skip range starts at/after `to` no later one can overlap.
 */
function overlapsSkip(from: number, to: number, skip: readonly Range[]): boolean {
  for (const s of skip) {
    if (s.from >= to) break;
    if (s.to > from) return true;
  }
  return false;
}

/**
 * Scan each region of `text` for words and return the ranges of those `isCorrect`
 * rejects, skipping words that fall inside any `skip` range and those filtered out
 * by the options. `regions` and `skip` are each assumed sorted ascending by `from`.
 */
export function computeMisspelledRanges(
  text: string,
  regions: readonly Range[],
  skip: readonly Range[],
  isCorrect: (word: string) => boolean,
  options: MisspellOptions = {},
): Range[] {
  const { minLength, skipAllCaps } = { ...DEFAULTS, ...options };
  const out: Range[] = [];
  for (const region of regions) {
    const slice = text.slice(region.from, region.to);
    WORD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD_RE.exec(slice))) {
      const word = m[0];
      if (word.length < minLength) continue;
      if (skipAllCaps && isAllCaps(word)) continue;
      const from = region.from + m.index;
      const to = from + word.length;
      if (overlapsSkip(from, to, skip)) continue;
      if (!isCorrect(word)) out.push({ from, to });
    }
  }
  return out;
}

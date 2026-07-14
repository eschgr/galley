import { describe, it, expect } from 'vitest';
import { computeMisspelledRanges, type Range } from './spellRanges';

// A fixed correct-word set stands in for the dictionary, so these tests exercise
// only the scanning/clipping/heuristics — never a real speller.
const KNOWN = new Set(['hello', 'world', 'code', "don't", 'the', 'a']);
const isCorrect = (w: string) => KNOWN.has(w.toLowerCase());

/** The whole string as a single region. */
const whole = (text: string): Range[] => [{ from: 0, to: text.length }];
/** The substrings the returned ranges cover — handy for readable assertions. */
const words = (text: string, ranges: Range[]) => ranges.map((r) => text.slice(r.from, r.to));

describe('computeMisspelledRanges', () => {
  it('flags a misspelling and leaves known words alone', () => {
    const text = 'helo world';
    const out = computeMisspelledRanges(text, whole(text), [], isCorrect);
    expect(out).toEqual([{ from: 0, to: 4 }]);
    expect(words(text, out)).toEqual(['helo']);
  });

  it('returns absolute document offsets, not region-relative ones', () => {
    const text = 'hello world helo';
    const region: Range[] = [{ from: 6, to: text.length }]; // skip the first word
    const out = computeMisspelledRanges(text, region, [], isCorrect);
    expect(words(text, out)).toEqual(['helo']);
    expect(out).toEqual([{ from: 12, to: 16 }]);
  });

  it('never checks words outside the given regions', () => {
    const text = 'helo world';
    // Region covers only "world"; the misspelling "helo" is out of scope.
    const out = computeMisspelledRanges(text, [{ from: 5, to: text.length }], [], isCorrect);
    expect(out).toEqual([]);
  });

  it('skips words inside a skip range (e.g. a code span)', () => {
    const text = 'the wrongword `wrongword` the';
    const codeStart = text.indexOf('`');
    const skip: Range[] = [{ from: codeStart, to: text.indexOf('`', codeStart + 1) + 1 }];
    const out = computeMisspelledRanges(text, whole(text), skip, isCorrect);
    // Only the first (prose) "wrongword" is flagged; the fenced one is skipped.
    expect(words(text, out)).toEqual(['wrongword']);
    expect(out).toEqual([{ from: 4, to: 13 }]);
  });

  it('ignores words shorter than minLength (default 2 skips single letters)', () => {
    const text = 'x helo'; // "x" is a lone letter
    const out = computeMisspelledRanges(text, whole(text), [], isCorrect);
    expect(words(text, out)).toEqual(['helo']);
  });

  it('honours a custom minLength', () => {
    const text = 'ab cd helo';
    const out = computeMisspelledRanges(text, whole(text), [], isCorrect, { minLength: 3 });
    expect(words(text, out)).toEqual(['helo']); // "ab"/"cd" are too short to check
  });

  it('skips ALL-CAPS tokens by default but flags them when asked', () => {
    const text = 'HTTP ZZZQ';
    expect(computeMisspelledRanges(text, whole(text), [], isCorrect)).toEqual([]);
    const flagged = computeMisspelledRanges(text, whole(text), [], isCorrect, { skipAllCaps: false });
    expect(words(text, flagged)).toEqual(['HTTP', 'ZZZQ']);
  });

  it('treats an internal apostrophe as part of one word', () => {
    const text = "don't didn't";
    const out = computeMisspelledRanges(text, whole(text), [], isCorrect);
    // "don't" is known; "didn't" is not — flagged as a single token.
    expect(words(text, out)).toEqual(["didn't"]);
  });

  it('does not pull a trailing possessive apostrophe into the token', () => {
    const text = "the dogs' bones"; // dogs' — apostrophe is not part of the word
    // The predicate accepts "dogs" but would reject "dogs'"; nothing is flagged,
    // proving the trailing apostrophe was left out of the token.
    const known = (w: string) => w === 'dogs' || w === 'bones' || KNOWN.has(w);
    const out = computeMisspelledRanges(text, whole(text), [], known);
    expect(out).toEqual([]);
  });
});

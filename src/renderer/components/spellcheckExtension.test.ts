import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { spellSkipRanges } from './spellcheckExtension';
import type { Range } from './spellRanges';

const stateFor = (doc: string) =>
  EditorState.create({ doc, extensions: [markdown({ extensions: GFM })] });

/** True when [from,to) sits entirely inside one skip range. */
const covered = (skip: Range[], from: number, to: number) => skip.some((s) => s.from <= from && s.to >= to);

/** The character span of `needle` in `doc` (first occurrence). */
const span = (doc: string, needle: string): [number, number] => {
  const i = doc.indexOf(needle);
  return [i, i + needle.length];
};

describe('spellSkipRanges', () => {
  it('skips inline code, fenced code, URLs, and HTML — but not prose', () => {
    const doc = [
      'Here is teh prose.',
      'Inline `codeword` and [visible](http://exampel.com/bad).',
      '```',
      'fencedd codee',
      '```',
      'Autolink <http://autolinkk.test> and <div>htmll</div>.',
    ].join('\n');
    const skip = spellSkipRanges(stateFor(doc), 0, doc.length);

    // Non-prose regions are covered:
    expect(covered(skip, ...span(doc, 'codeword'))).toBe(true); // inline code body
    expect(covered(skip, ...span(doc, 'fencedd codee'))).toBe(true); // fenced body
    expect(covered(skip, ...span(doc, 'http://exampel.com/bad'))).toBe(true); // link URL
    expect(covered(skip, ...span(doc, 'http://autolinkk.test'))).toBe(true); // autolink URL
    expect(covered(skip, ...span(doc, '<div>'))).toBe(true); // HTML tag

    // Prose — including a link's visible text — is NOT skipped:
    expect(covered(skip, ...span(doc, 'teh'))).toBe(false);
    expect(covered(skip, ...span(doc, 'visible'))).toBe(false);
  });

  it('returns ranges sorted ascending by from', () => {
    const doc = 'a `x` b `y` c `z`';
    const skip = spellSkipRanges(stateFor(doc), 0, doc.length);
    const froms = skip.map((s) => s.from);
    expect([...froms]).toEqual([...froms].sort((a, b) => a - b));
  });

  it('only reports ranges overlapping the requested window', () => {
    const doc = ['`early`', '', 'prose line', '', '`late`'].join('\n');
    const [, mid] = span(doc, 'prose line');
    // Window covering only the tail: the early inline code is out of scope.
    const skip = spellSkipRanges(stateFor(doc), mid, doc.length);
    expect(skip.some((s) => s.from < mid && s.to <= mid)).toBe(false);
    expect(covered(skip, ...span(doc, 'late'))).toBe(true);
  });
});

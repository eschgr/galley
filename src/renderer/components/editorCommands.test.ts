import { describe, it, expect } from 'vitest';
import { wrapEdit, headingEdit, fencedEdit, type EditResult } from './editorCommands';

/** Apply an EditResult to a doc and return the new doc + selection, for asserting. */
function apply(doc: string, r: EditResult): { doc: string; sel: [number, number] } {
  return { doc: doc.slice(0, r.from) + r.insert + doc.slice(r.to), sel: r.select };
}

describe('wrapEdit (R24/R25 — toggle + smart selection)', () => {
  it('wraps a selection in the marker', () => {
    const doc = 'make me bold';
    const { doc: out, sel } = apply(doc, wrapEdit(doc, 8, 12, '**')); // "bold"
    expect(out).toBe('make me **bold**');
    expect(out.slice(sel[0], sel[1])).toBe('bold'); // inner stays selected
  });

  it('unwraps when the markers sit just outside the selection', () => {
    const doc = 'make me **bold**';
    const { doc: out, sel } = apply(doc, wrapEdit(doc, 10, 14, '**')); // inner "bold"
    expect(out).toBe('make me bold');
    expect(out.slice(sel[0], sel[1])).toBe('bold');
  });

  it('unwraps when the markers sit inside the selection', () => {
    const doc = 'make me **bold**';
    const { doc: out } = apply(doc, wrapEdit(doc, 8, 16, '**')); // "**bold**"
    expect(out).toBe('make me bold');
  });

  it('with no selection inserts the markers and puts the cursor between them', () => {
    const doc = 'a b';
    const r = wrapEdit(doc, 2, 2, '**');
    const { doc: out, sel } = apply(doc, r);
    expect(out).toBe('a ****b'); // "**" + "**" inserted at the cursor
    expect(sel).toEqual([4, 4]); // collapsed between the two pairs
  });

  it('toggles off from an empty cursor sitting between markers', () => {
    const doc = 'a ** b'; // cursor between the two stars (offset 3)
    const { doc: out } = apply(doc, wrapEdit(doc, 3, 3, '*'));
    expect(out).toBe('a  b');
  });

  it('works for single-char markers (italic, inline code)', () => {
    const doc = 'word';
    expect(apply(doc, wrapEdit(doc, 0, 4, '*')).doc).toBe('*word*');
    expect(apply(doc, wrapEdit(doc, 0, 4, '`')).doc).toBe('`word`');
  });

  it('works for strikethrough', () => {
    const doc = 'gone';
    expect(apply(doc, wrapEdit(doc, 0, 4, '~~')).doc).toBe('~~gone~~');
  });
});

describe('headingEdit (R24 — normalize, not stack)', () => {
  it('adds a heading to a plain line', () => {
    const doc = 'Hello';
    expect(apply(doc, headingEdit(doc, 0, 5, 2)).doc).toBe('## Hello');
  });

  it('switches level instead of stacking', () => {
    const doc = '## Hello';
    expect(apply(doc, headingEdit(doc, 3, 8, 4)).doc).toBe('#### Hello');
  });

  it('removes the heading when applying the current level', () => {
    const doc = '## Hello';
    expect(apply(doc, headingEdit(doc, 3, 8, 2)).doc).toBe('Hello');
  });

  it('applies to every line the selection touches', () => {
    const doc = 'one\ntwo';
    expect(apply(doc, headingEdit(doc, 0, 7, 1)).doc).toBe('# one\n# two');
  });

  it('with a bare cursor leaves the cursor after the prefix, not selecting it', () => {
    // Regression: on an empty line, a heading must not select "## " — otherwise
    // the next keystroke overwrites the markers.
    const doc = '';
    const { doc: out, sel } = apply(doc, headingEdit(doc, 0, 0, 2));
    expect(out).toBe('## ');
    expect(sel).toEqual([3, 3]); // collapsed at end, ready to type the title
  });

  it('keeps the cursor on the same character when toggling on a non-empty line', () => {
    const doc = 'Hello';
    const r = headingEdit(doc, 2, 2, 2); // cursor on the first "l"
    expect(apply(doc, r).doc).toBe('## Hello');
    expect(r.select).toEqual([5, 5]); // still before the same "l" (shifted by "## ")
  });

  it('only the touched line changes', () => {
    const doc = 'keep\ntarget\nkeep';
    const target = doc.indexOf('target');
    expect(apply(doc, headingEdit(doc, target, target, 3)).doc).toBe('keep\n### target\nkeep');
  });
});

describe('fencedEdit (R23 — toggle fenced block)', () => {
  it('wraps the selected lines in fences', () => {
    const doc = 'let x = 1';
    expect(apply(doc, fencedEdit(doc, 0, 9)).doc).toBe('```\nlet x = 1\n```');
  });

  it('removes the fences when the lines are already a block', () => {
    const doc = '```\nlet x = 1\n```';
    expect(apply(doc, fencedEdit(doc, 0, doc.length)).doc).toBe('let x = 1');
  });

  it('wraps a multi-line selection', () => {
    const doc = 'a\nb';
    expect(apply(doc, fencedEdit(doc, 0, 3)).doc).toBe('```\na\nb\n```');
  });

  it('toggles off on a second press, when only the inner content is selected', () => {
    // Regression: after wrapping, the selection is the inner line — pressing
    // again must remove the block, not nest another pair of fences.
    const doc = 'x = 1';
    const wrap = fencedEdit(doc, 0, 5);
    const wrapped = apply(doc, wrap);
    expect(wrapped.doc).toBe('```\nx = 1\n```');
    const [a, b] = wrap.select; // the inner "x = 1"
    expect(apply(wrapped.doc, fencedEdit(wrapped.doc, a, b)).doc).toBe('x = 1');
  });
});

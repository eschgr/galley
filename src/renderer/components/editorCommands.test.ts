import { describe, it, expect } from 'vitest';
import {
  wrapEdit,
  unwrapSpan,
  headingEdit,
  fencedEdit,
  listIndentEdit,
  listContinueEdit,
  type EditResult,
} from './editorCommands';

/** Apply an EditResult to a doc and return the new doc + selection, for asserting. */
function apply(doc: string, r: EditResult): { doc: string; sel: [number, number] } {
  return { doc: doc.slice(0, r.from) + r.insert + doc.slice(r.to), sel: r.select };
}

describe('wrapEdit (formatting toggle + smart selection)', () => {
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

describe('unwrapSpan (formatting toggle off from a cursor inside the span)', () => {
  it('removes the markers of the enclosing span, keeping the cursor in place', () => {
    const doc = '**Hello world**';
    const cursor = 7; // "**Hello| world**"
    const r = unwrapSpan(doc, 0, doc.length, 2, cursor);
    const { doc: out, sel } = apply(doc, r);
    expect(out).toBe('Hello world');
    expect(out.slice(0, sel[0])).toBe('Hello'); // cursor still after "Hello"
  });

  it('handles a single-char marker', () => {
    const doc = '`code`';
    expect(apply(doc, unwrapSpan(doc, 0, doc.length, 1, 3)).doc).toBe('code');
  });
});

describe('headingEdit (formatting toggle — normalize, not stack)', () => {
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

describe('fencedEdit (formatting shortcut — toggle fenced block)', () => {
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

describe('listIndentEdit (list indent / outdent — CommonMark-correct nesting)', () => {
  // cursor at the end of line `n` (0-based)
  const atEndOfLine = (doc: string, n: number) => {
    const lines = doc.split('\n');
    return lines.slice(0, n).reduce((sum, l) => sum + l.length + 1, 0) + lines[n].length;
  };
  const nestEnd = (doc: string, n: number, dir: 'in' | 'out') => {
    const r = listIndentEdit(doc, atEndOfLine(doc, n), dir);
    return r ? apply(doc, r).doc : null;
  };

  it('nests an ordered item to its parent content column (3 spaces under "1. ")', () => {
    expect(nestEnd('1. line\n1. stuff', 1, 'in')).toBe('1. line\n   1. stuff');
  });

  it('nests a bullet item by 2 spaces (content column of "- ")', () => {
    expect(nestEnd('- a\n- b', 1, 'in')).toBe('- a\n  - b');
  });

  it('aligns under a wide marker (4 spaces under "10. ")', () => {
    expect(nestEnd('10. line\n1. b', 1, 'in')).toBe('10. line\n    1. b');
  });

  it('leaves the marker untouched — lazy "1." survives nesting', () => {
    expect(nestEnd('1. a\n1. b\n1. c', 2, 'in')).toBe('1. a\n1. b\n   1. c');
  });

  it('un-nests back to the parent item column', () => {
    expect(nestEnd('1. a\n   1. b', 1, 'out')).toBe('1. a\n1. b');
  });

  it('returns null off a list line (caller falls back to plain indent)', () => {
    expect(listIndentEdit('just a paragraph', 4, 'in')).toBeNull();
  });

  it('returns null when outdenting a top-level item', () => {
    expect(listIndentEdit('1. top', 5, 'out')).toBeNull();
  });
});

describe('listContinueEdit (list continuation on Enter — Enter continues a list with "1.")', () => {
  const end = (doc: string, n: number) => {
    const lines = doc.split('\n');
    return lines.slice(0, n).reduce((s, l) => s + l.length + 1, 0) + lines[n].length;
  };
  const cont = (doc: string, n: number) => {
    const r = listContinueEdit(doc, end(doc, n));
    return r ? apply(doc, r).doc : null;
  };

  it('continues an ordered list with a fresh "1." (never the next number)', () => {
    expect(cont('1. a', 0)).toBe('1. a\n1. ');
    expect(cont('1. a\n1. b', 1)).toBe('1. a\n1. b\n1. ');
  });

  it('continues a bullet list with the same marker', () => {
    expect(cont('- a', 0)).toBe('- a\n- ');
    expect(cont('* a', 0)).toBe('* a\n* ');
  });

  it('preserves indentation when continuing a nested item', () => {
    expect(cont('1. a\n   1. b', 1)).toBe('1. a\n   1. b\n   1. ');
  });

  it('keeps the delimiter style (1) stays "1)")', () => {
    expect(cont('1) a', 0)).toBe('1) a\n1) ');
  });

  it('ends the list when Enter is pressed on an empty item', () => {
    expect(cont('1. a\n1. ', 1)).toBe('1. a\n');
  });

  it('returns null off a list line (plain newline)', () => {
    expect(listContinueEdit('a paragraph', 4)).toBeNull();
  });
});

/**
 * Pure markdown-formatting transforms for the source editor (PRD R23–R25).
 *
 * Each function takes the whole document plus a selection range [from, to) and
 * returns a single contiguous replacement plus the resulting selection:
 *   { from, to, insert, select: [anchor, head] }
 * Keeping these free of CodeMirror makes the toggle/normalize rules (the fiddly
 * part) unit-testable; the thin CM `Command` wrappers in Editor.tsx just turn an
 * EditResult into a transaction.
 */

export interface EditResult {
  /** Start of the replaced span. */
  from: number;
  /** End of the replaced span. */
  to: number;
  /** Replacement text. */
  insert: string;
  /** Selection after applying, as absolute [anchor, head] offsets. */
  select: [number, number];
}

/** Expand [from, to) to cover whole lines; returns the line span offsets. */
function lineSpan(doc: string, from: number, to: number): { start: number; end: number } {
  const start = doc.lastIndexOf('\n', from - 1) + 1; // 0 when no preceding newline
  let end = doc.indexOf('\n', to);
  if (end === -1) end = doc.length;
  return { start, end };
}

/**
 * Toggle a symmetric wrapping marker (`**`, `*`, `` ` ``, `~~`) around the
 * selection (R24). Markers just outside the selection or just inside it are
 * removed; otherwise the selection is wrapped. With no selection the markers are
 * inserted with the cursor between them so the user can type (R25).
 */
export function wrapEdit(doc: string, from: number, to: number, marker: string): EditResult {
  const mlen = marker.length;
  const sel = doc.slice(from, to);

  // Already wrapped, markers sit OUTSIDE the selection → unwrap.
  if (
    from - mlen >= 0 &&
    doc.slice(from - mlen, from) === marker &&
    doc.slice(to, to + mlen) === marker
  ) {
    return { from: from - mlen, to: to + mlen, insert: sel, select: [from - mlen, to - mlen] };
  }

  // Already wrapped, markers sit INSIDE the selection → unwrap.
  if (sel.length >= 2 * mlen && sel.startsWith(marker) && sel.endsWith(marker)) {
    const inner = sel.slice(mlen, sel.length - mlen);
    return { from, to, insert: inner, select: [from, from + inner.length] };
  }

  // Not wrapped → wrap. Empty selection drops the cursor between the markers.
  if (from === to) {
    return { from, to, insert: marker + marker, select: [from + mlen, from + mlen] };
  }
  return { from, to, insert: marker + sel + marker, select: [from + mlen, to + mlen] };
}

/**
 * Set the heading level of every line the selection touches (R24). Headings
 * normalize rather than stack: applying a different level switches to it;
 * applying the line's current level removes the heading.
 */
export function headingEdit(doc: string, from: number, to: number, level: number): EditResult {
  const { start, end } = lineSpan(doc, from, to);
  const headingRe = /^(#{1,6}) +/;
  const lines = doc.slice(start, end).split('\n');
  const out = lines.map((line) => {
    const m = headingRe.exec(line);
    const current = m ? m[1].length : 0;
    const base = m ? line.slice(m[0].length) : line;
    if (current === level) return base; // same level removes
    return '#'.repeat(level) + ' ' + base;
  });
  const insert = out.join('\n');
  return { from: start, to: end, insert, select: [start, start + insert.length] };
}

/**
 * Toggle a fenced code block around the line(s) the selection touches (R23). If
 * those lines are already a ``` … ``` block, the fences are removed.
 */
export function fencedEdit(doc: string, from: number, to: number): EditResult {
  const { start, end } = lineSpan(doc, from, to);
  const block = doc.slice(start, end);
  const lines = block.split('\n');

  if (lines.length >= 2 && lines[0].trim() === '```' && lines[lines.length - 1].trim() === '```') {
    const inner = lines.slice(1, -1).join('\n');
    return { from: start, to: end, insert: inner, select: [start, start + inner.length] };
  }

  const wrapped = '```\n' + block + '\n```';
  const innerStart = start + 4; // past the opening "```\n"
  return { from: start, to: end, insert: wrapped, select: [innerStart, innerStart + block.length] };
}

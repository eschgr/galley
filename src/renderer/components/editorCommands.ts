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
  // With a real selection, keep the modified block selected. With a bare cursor,
  // collapse to where the cursor was, shifted by the net prefix change — so an
  // empty line that became "## " doesn't end up fully selected (which would make
  // the next keystroke overwrite the markers).
  if (from === to) {
    const shifted = clampOffset(from + (insert.length - (end - start)), start, start + insert.length);
    return { from: start, to: end, insert, select: [shifted, shifted] };
  }
  return { from: start, to: end, insert, select: [start, start + insert.length] };
}

function clampOffset(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Toggle a fenced code block around the line(s) the selection touches (R23). If
 * those lines are already a ``` … ``` block, the fences are removed.
 */
export function fencedEdit(doc: string, from: number, to: number): EditResult {
  const { start, end } = lineSpan(doc, from, to);
  const block = doc.slice(start, end);
  const lines = block.split('\n');

  // Toggle off — the fences are the first and last selected lines.
  if (lines.length >= 2 && lines[0].trim() === '```' && lines[lines.length - 1].trim() === '```') {
    const inner = lines.slice(1, -1).join('\n');
    return { from: start, to: end, insert: inner, select: [start, start + inner.length] };
  }

  // Toggle off — the fences sit on the lines just *outside* the selection (the
  // common case: after wrapping, only the inner content is selected, so a second
  // press should still remove the block rather than nest another one).
  if (start > 0 && end < doc.length) {
    const prevStart = doc.lastIndexOf('\n', start - 2) + 1;
    const prevLine = doc.slice(prevStart, start - 1);
    const nextStart = end + 1;
    let nextEnd = doc.indexOf('\n', nextStart);
    if (nextEnd === -1) nextEnd = doc.length;
    const nextLine = doc.slice(nextStart, nextEnd);
    if (prevLine.trim() === '```' && nextLine.trim() === '```') {
      return { from: prevStart, to: nextEnd, insert: block, select: [prevStart, prevStart + block.length] };
    }
  }

  const wrapped = '```\n' + block + '\n```';
  const innerStart = start + 4; // past the opening "```\n"
  return { from: start, to: end, insert: wrapped, select: [innerStart, innerStart + block.length] };
}

const LIST_ITEM_RE = /^(\s*)(\d+[.)]|[-*+])(\s+)/;

interface ListInfo {
  /** Leading-space count. */
  indent: number;
  /** Column where the item's content begins (indent + marker + spaces). */
  contentCol: number;
}

function parseListInfo(line: string): ListInfo | null {
  const m = LIST_ITEM_RE.exec(line);
  return m ? { indent: m[1].length, contentCol: m[1].length + m[2].length + m[3].length } : null;
}

/**
 * Nest ('in') or un-nest ('out') the list item on the line containing `pos`,
 * matching CommonMark's indentation rule: a nested item must align with the
 * parent item's **content column** (3 for `1. `, 2 for `- `, 4 for `10. `), not
 * a flat two spaces — otherwise the renderer flattens or merges the list. Nest
 * indents to the nearest preceding item at the same-or-shallower level; un-nest
 * drops to the parent item's column. Returns null when the line isn't a list
 * item or there's nothing to do, so the caller can fall back to plain indent.
 */
export function listIndentEdit(doc: string, pos: number, dir: 'in' | 'out'): EditResult | null {
  const lineStart = doc.lastIndexOf('\n', pos - 1) + 1;
  let lineEnd = doc.indexOf('\n', pos);
  if (lineEnd === -1) lineEnd = doc.length;
  const cur = parseListInfo(doc.slice(lineStart, lineEnd));
  if (!cur) return null;

  const prevLines = lineStart === 0 ? [] : doc.slice(0, lineStart - 1).split('\n');

  let target: number;
  if (dir === 'in') {
    // Align under the nearest preceding item at the same or a shallower level.
    target = cur.indent + 2; // fallback: one level, when there's no such item
    for (let i = prevLines.length - 1; i >= 0; i--) {
      const info = parseListInfo(prevLines[i]);
      if (info) {
        if (info.indent <= cur.indent) {
          if (info.contentCol > cur.indent) target = info.contentCol;
          break;
        }
        // a deeper item — keep scanning up for the sibling/parent
      } else if (prevLines[i].trim() !== '') {
        break; // a non-list line ends the list context
      }
    }
  } else {
    if (cur.indent === 0) return null; // already at the top level
    target = Math.max(0, cur.indent - 2); // fallback
    for (let i = prevLines.length - 1; i >= 0; i--) {
      const info = parseListInfo(prevLines[i]);
      if (info) {
        if (info.indent < cur.indent) {
          target = info.indent;
          break;
        }
      } else if (prevLines[i].trim() !== '') {
        break;
      }
    }
  }

  if (target === cur.indent) return null;
  const cursor = Math.max(lineStart, pos + (target - cur.indent));
  return { from: lineStart, to: lineStart + cur.indent, insert: ' '.repeat(target), select: [cursor, cursor] };
}

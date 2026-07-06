/**
 * Pure match-finding logic for the preview find bar (#57). Kept DOM-free so it is
 * unit-testable: the component walks the rendered preview's text nodes into one
 * flat string, asks findMatches() for the [start,end) ranges, then maps each range
 * back onto DOM Ranges for the CSS Custom Highlight API. The stepping/wraparound
 * for next/previous also lives here so it can be tested without a browser.
 */
export interface FindMatch {
  /** Inclusive start index into the haystack. */
  start: number;
  /** Exclusive end index into the haystack. */
  end: number;
}

/**
 * Every non-overlapping occurrence of `query` in `haystack`, left to right, as
 * [start,end) index ranges. An empty query yields none. Case-insensitive unless
 * `caseSensitive`. Overlapping candidates (e.g. "aa" in "aaa") are matched the way
 * find-in-page does — non-overlapping, so "aaa" has one "aa" match, not two.
 */
export function findMatches(haystack: string, query: string, caseSensitive: boolean): FindMatch[] {
  if (!query) return [];
  const hay = caseSensitive ? haystack : haystack.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: FindMatch[] = [];
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    out.push({ start: i, end: i + needle.length });
    from = i + needle.length; // advance past the whole match — no overlaps
  }
  return out;
}

/**
 * Step the active match index with wraparound. `forward` advances (next), else
 * goes back (previous). A negative `current` (no active match yet) lands on the
 * first match going forward, or the last going back. Returns -1 when there are no
 * matches at all.
 */
export function stepMatch(current: number, total: number, forward: boolean): number {
  if (total <= 0) return -1;
  if (current < 0) return forward ? 0 : total - 1;
  return forward ? (current + 1) % total : (current - 1 + total) % total;
}

/** The human "n of N" label: 1-based active position, or "0 of 0" when empty. */
export function matchLabel(index: number, total: number): string {
  if (total <= 0) return '0 of 0';
  const shown = Math.min(Math.max(index, 0), total - 1) + 1;
  return `${shown} of ${total}`;
}

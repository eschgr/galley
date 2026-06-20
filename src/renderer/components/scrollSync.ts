/**
 * Pure scroll-sync interpolation (PRD R18), extracted so it can be unit-tested
 * without a DOM. An "anchor" maps a source line to a vertical offset (px) within
 * the preview's scroll container; the preview builds them from the
 * `data-source-line` elements. These functions convert between a scroll offset
 * and a (fractional) source line by linear interpolation between bracketing
 * anchors.
 */
export interface Anchor {
  /** 0-based source line. */
  line: number;
  /** Vertical offset (px) of this line within the scroll container's content. */
  top: number;
}

/** The (fractional) source line shown at a given scrollTop. */
export function topLineFrom(anchors: Anchor[], scrollTop: number): number {
  if (anchors.length === 0) return 0;
  if (scrollTop <= anchors[0].top) return anchors[0].line;
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (scrollTop < b.top) {
      const span = b.top - a.top;
      // span > 0 is guaranteed when this returns (the guards above rule out the
      // zero-span case); the `: 0` arm is a defensive guard against
      // non-monotonic anchors and is unreachable via these functions.
      /* v8 ignore next */
      const f = span > 0 ? (scrollTop - a.top) / span : 0;
      return a.line + f * (b.line - a.line);
    }
  }
  return anchors[anchors.length - 1].line;
}

/** The scrollTop that puts a (fractional) source line at the top. */
export function scrollTopFor(anchors: Anchor[], line: number): number {
  if (anchors.length === 0) return 0;
  if (line <= anchors[0].line) return anchors[0].top;
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (line < b.line) {
      const span = b.line - a.line;
      // See the note in topLineFrom: the `: 0` arm is an unreachable defensive
      // guard (span > 0 is guaranteed here).
      /* v8 ignore next */
      const f = span > 0 ? (line - a.line) / span : 0;
      return a.top + f * (b.top - a.top);
    }
  }
  return anchors[anchors.length - 1].top;
}

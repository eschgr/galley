/**
 * Pure scroll-sync interpolation, extracted so it can be unit-tested
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

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Blend the follower's line-anchored scroll target toward the follower's OWN max
 * scroll as the leader approaches its end, so the two panes CO-ARRIVE at the
 * bottom (#18). In the middle, top-line→top-line alignment is exact; but at the
 * leader's bottom that alignment can leave the follower's tail hidden when the
 * follower's content past that line is taller (e.g. math renders taller than its
 * source) or shorter.
 *
 * Over the leader's final `blendPx` of scroll, a weight `w` ramps 0→1; the target
 * is `lineAnchoredTop + w*(followerMax - lineAnchoredTop)`. So in the middle
 * (w=0) the line-anchored position is unchanged, and at the leader's exact end
 * (w=1) the follower lands exactly at `followerMax`. If the follower is shorter,
 * `followerMax` is small and it simply stays clamped at its own end.
 *
 * @param lineAnchoredTop The px scrollTop the follower's line-anchoring would set.
 * @param followerMax     The follower's max scrollTop (scrollHeight - clientHeight).
 * @param leaderTop       The leader's current scrollTop.
 * @param leaderMax       The leader's max scrollTop.
 * @param blendPx         Width of the convergence window, in px of leader scroll.
 */
export function blendedFollowerTop(
  lineAnchoredTop: number,
  followerMax: number,
  leaderTop: number,
  leaderMax: number,
  blendPx: number,
): number {
  const anchored = clamp(lineAnchoredTop, 0, Math.max(followerMax, 0));
  if (leaderMax <= 0) return 0;
  if (blendPx <= 0) return anchored;
  const w = clamp((leaderTop - (leaderMax - blendPx)) / blendPx, 0, 1);
  return anchored + w * (followerMax - anchored);
}

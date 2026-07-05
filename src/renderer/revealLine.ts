// Pure helpers for the "open at a specific line" reveal. The DOM scroll +
// highlight lives in Preview; these are the unit-testable decisions it rests on:
// clamping an out-of-range target, and choosing which anchored block to reveal.

/**
 * Convert a 1-based, possibly out-of-range target line to a 0-based line clamped
 * to the document's bounds. `totalLines` is the document's line count (>= 1). A
 * line past the end clamps to the last line; a line below 1 clamps to the first.
 */
export function clampTargetLine(line1: number, totalLines: number): number {
  const total = Math.max(1, Math.floor(totalLines) || 1);
  const line = Math.floor(line1) || 1;
  return Math.max(0, Math.min(line, total) - 1);
}

/**
 * Choose which anchored block to reveal for a 0-based target line, given the
 * blocks' `data-source-line` values in document order. Returns the index of the
 * block with the greatest source line that is still `<= target0` (the block
 * containing, or just before, the target); if every block starts after the
 * target, the first block is chosen; an empty list yields -1.
 */
export function pickRevealIndex(lines: readonly number[], target0: number): number {
  if (lines.length === 0) return -1;
  let best = -1;
  let bestLine = -Infinity;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line <= target0 && line > bestLine) {
      bestLine = line;
      best = i;
    }
  }
  return best === -1 ? 0 : best;
}

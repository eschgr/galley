/**
 * Pure insertion-index math for drag-to-reorder tabs (issue #20).
 *
 * Given a STABLE SNAPSHOT of each tab's resting midpoint (the x of its centre,
 * in original left-to-right order, captured once at drag start) and the cursor's
 * current x, returns the insertion index (0..n): how many tabs the dragged tab
 * should sit after.
 *
 * Why a snapshot, not the live layout: during a drag the strip renders a PREVIEW
 * order (the dragged tab is spliced to its landing slot and the others shift to
 * make room). Reading each tab's LIVE rect while iterating in original order
 * yields midpoints that are no longer spatially monotonic, so a first-match scan
 * fires on the wrong tab — and because the chosen index changes the very layout
 * the next measurement reads, it forms a feedback loop (a stable 2-cycle for
 * unequal-width tabs). Computing purely from a fixed snapshot breaks that loop:
 * the same cursor x always maps to the same index.
 *
 * The snapshot is ascending (original layout is left-to-right), so the insertion
 * index is simply the count of midpoints strictly less than `clientX` — i.e. the
 * index of the first midpoint > clientX, or `length` if the cursor is past all
 * of them. A cursor exactly on a midpoint is treated as just past it (counts
 * that tab to the cursor's left, so the drop lands after it), so boundaries map
 * to a single deterministic index.
 */
export function insertIndexFromMidpoints(midpoints: number[], clientX: number): number {
  for (let i = 0; i < midpoints.length; i++) {
    if (clientX < midpoints[i]) return i;
  }
  return midpoints.length;
}

/**
 * Pure tab-reorder helper for drag-and-drop. Moves the tab with
 * `draggedId` so that it lands at insertion index `insertIndex` (0..n) in the
 * resulting array, shifting the others to make room.
 *
 * `insertIndex` is an INSERTION position in the ORIGINAL array (0..n): 0 means
 * "before the first tab", n means "after the last tab". This is more precise
 * than drop-on-target because it can place the tab at either edge and in any
 * gap unambiguously.
 *
 * The active tab is tracked by id elsewhere, so reordering the array never
 * changes which tab is active — the active tab simply lands at its new index.
 *
 * No-op cases (unknown dragged id, or the move would leave the order unchanged)
 * return the SAME array reference so callers can skip a needless state commit.
 */
import type { Tab } from './App';

export function reorderToIndex(tabs: Tab[], draggedId: string, insertIndex: number): Tab[] {
  const from = tabs.findIndex((t) => t.id === draggedId);
  if (from === -1) return tabs;

  // Clamp into the valid insertion range [0, n].
  let to = insertIndex;
  if (to < 0) to = 0;
  if (to > tabs.length) to = tabs.length;

  // Inserting at the dragged tab's own index — or the slot immediately after it
  // — leaves the order unchanged once the tab is spliced out. No-op: same ref.
  if (to === from || to === from + 1) return tabs;

  // Translate the original-array insertion index into the index within the
  // array AFTER the dragged tab is removed: positions past `from` shift left 1.
  const target = to > from ? to - 1 : to;
  const next = tabs.slice();
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

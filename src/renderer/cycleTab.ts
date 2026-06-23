/**
 * Pure index math for Ctrl+Tab / Ctrl+Shift+Tab tab cycling (issue #19).
 * Kept separate from App.tsx so the wraparound logic is unit-testable in
 * isolation. Given the ordered tab ids, the currently active id, and a
 * direction, return the id to switch to — or null when it's a no-op (fewer
 * than 2 tabs, or the active id isn't in the list).
 */
export type CycleDirection = 'next' | 'prev';

export function cycleTabTarget(
  ids: readonly string[],
  activeId: string | null,
  direction: CycleDirection,
): string | null {
  if (ids.length < 2 || activeId == null) return null;
  const cur = ids.indexOf(activeId);
  if (cur < 0) return null;
  const step = direction === 'next' ? 1 : -1;
  const target = (cur + step + ids.length) % ids.length;
  return ids[target];
}

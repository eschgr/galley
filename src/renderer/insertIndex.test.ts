import { describe, it, expect } from 'vitest';
import { insertIndexFromMidpoints } from './insertIndex';

describe('insertIndexFromMidpoints (drag-reorder index stability)', () => {
  // UNEQUAL-width tabs (the norm — Galley sizes tabs to filename length). With
  // equal widths the old live-rect scan was coincidentally stable; unequal
  // widths are what exposed the 2-cycle, so the snapshot here is non-uniform.
  // Tabs span [0,40], [40,140], [140,160], [160,260]; midpoints below.
  const mids = [20, 90, 150, 210];

  it('cursor left of every midpoint → 0', () => {
    expect(insertIndexFromMidpoints(mids, -100)).toBe(0);
    expect(insertIndexFromMidpoints(mids, 19)).toBe(0);
  });

  it('cursor right of every midpoint → length', () => {
    expect(insertIndexFromMidpoints(mids, 211)).toBe(4);
    expect(insertIndexFromMidpoints(mids, 9999)).toBe(4);
  });

  it('cursor between two midpoints → the index of the first midpoint to its right', () => {
    expect(insertIndexFromMidpoints(mids, 21)).toBe(1); // past mid[0]=20
    expect(insertIndexFromMidpoints(mids, 100)).toBe(2); // past mid[0],mid[1]
    expect(insertIndexFromMidpoints(mids, 160)).toBe(3); // past mid[0..2]
  });

  it('cursor exactly on a midpoint is deterministic (lands AFTER that tab)', () => {
    // clientX < midpoint is strict, so x == a midpoint does NOT return at that
    // tab — the cursor is treated as just past it. x == mid[i] therefore yields
    // index i+1 (it counts that tab as to the cursor's left), the same for
    // every call. The exactness never lands "between" two answers.
    expect(insertIndexFromMidpoints(mids, 20)).toBe(1); // == mid[0]
    expect(insertIndexFromMidpoints(mids, 90)).toBe(2); // == mid[1]
    expect(insertIndexFromMidpoints(mids, 150)).toBe(3); // == mid[2]
    expect(insertIndexFromMidpoints(mids, 210)).toBe(4); // == mid[3]
  });

  it('the SAME cursor x always maps to the SAME index (no feedback loop)', () => {
    // The regression: dragging a narrow tab across a wider one used to flip
    // 2→0→2→0 at a fixed x. From a fixed snapshot the result is a pure function
    // of clientX, so repeated calls are identical.
    const x = 95;
    const first = insertIndexFromMidpoints(mids, x);
    for (let i = 0; i < 10; i++) {
      expect(insertIndexFromMidpoints(mids, x)).toBe(first);
    }
    expect(first).toBe(2);
  });

  it('empty snapshot → 0 (only insertion slot)', () => {
    expect(insertIndexFromMidpoints([], 50)).toBe(0);
  });

  it('single tab: left of midpoint → 0, right → 1', () => {
    expect(insertIndexFromMidpoints([50], 49)).toBe(0);
    expect(insertIndexFromMidpoints([50], 51)).toBe(1);
  });
});

import { describe, it, expect } from 'vitest';
import { cycleTabTarget } from './cycleTab';

describe('cycleTabTarget (Ctrl+Tab cycling)', () => {
  const ids = ['a', 'b', 'c'];

  it('moves right and wraps last → first', () => {
    expect(cycleTabTarget(ids, 'a', 'next')).toBe('b');
    expect(cycleTabTarget(ids, 'b', 'next')).toBe('c');
    expect(cycleTabTarget(ids, 'c', 'next')).toBe('a');
  });

  it('moves left and wraps first → last', () => {
    expect(cycleTabTarget(ids, 'c', 'prev')).toBe('b');
    expect(cycleTabTarget(ids, 'b', 'prev')).toBe('a');
    expect(cycleTabTarget(ids, 'a', 'prev')).toBe('c');
  });

  it('no-ops with fewer than 2 tabs', () => {
    expect(cycleTabTarget([], null, 'next')).toBeNull();
    expect(cycleTabTarget(['a'], 'a', 'next')).toBeNull();
    expect(cycleTabTarget(['a'], 'a', 'prev')).toBeNull();
  });

  it('no-ops when there is no active tab or it is unknown', () => {
    expect(cycleTabTarget(ids, null, 'next')).toBeNull();
    expect(cycleTabTarget(ids, 'zzz', 'next')).toBeNull();
  });
});

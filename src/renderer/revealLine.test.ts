import { describe, it, expect } from 'vitest';
import { clampTargetLine, pickRevealIndex } from './revealLine';

describe('clampTargetLine (1-based → 0-based, clamped)', () => {
  it('converts an in-range line to 0-based', () => {
    expect(clampTargetLine(1, 10)).toBe(0);
    expect(clampTargetLine(5, 10)).toBe(4);
    expect(clampTargetLine(10, 10)).toBe(9);
  });

  it('clamps a line past the end to the last line', () => {
    expect(clampTargetLine(999, 10)).toBe(9);
  });

  it('clamps a line below 1 to the first line', () => {
    expect(clampTargetLine(0, 10)).toBe(0);
    expect(clampTargetLine(-4, 10)).toBe(0);
  });

  it('handles a degenerate document (0 lines) as a single line', () => {
    expect(clampTargetLine(3, 0)).toBe(0);
  });

  it('floors a fractional line', () => {
    expect(clampTargetLine(4.9, 10)).toBe(3);
  });
});

describe('pickRevealIndex (which data-source-line block to reveal)', () => {
  const lines = [0, 2, 4, 7];

  it('picks the block with the greatest source line <= the target', () => {
    expect(pickRevealIndex(lines, 5)).toBe(2); // line 4 is the last <= 5
    expect(pickRevealIndex(lines, 4)).toBe(2); // exact match
    expect(pickRevealIndex(lines, 0)).toBe(0);
  });

  it('clamps a target past the last block to the last block', () => {
    expect(pickRevealIndex(lines, 100)).toBe(3);
  });

  it('falls back to the first block when every block starts after the target', () => {
    expect(pickRevealIndex([3, 5, 8], 1)).toBe(0);
  });

  it('keeps the first block on a source-line tie (outermost)', () => {
    expect(pickRevealIndex([4, 4, 6], 5)).toBe(0);
  });

  it('returns -1 for no blocks', () => {
    expect(pickRevealIndex([], 3)).toBe(-1);
  });
});

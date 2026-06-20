import { describe, it, expect } from 'vitest';
import { type Anchor, topLineFrom, scrollTopFor } from './scrollSync';

// A small monotonic anchor map: source line -> px offset.
const anchors: Anchor[] = [
  { line: 0, top: 0 },
  { line: 10, top: 100 },
  { line: 20, top: 400 }, // taller block between 10 and 20 (300px / 10 lines)
  { line: 30, top: 500 },
];

describe('topLineFrom', () => {
  it('returns 0 for an empty anchor set', () => {
    expect(topLineFrom([], 123)).toBe(0);
  });

  it('clamps to the first line at/above the top', () => {
    expect(topLineFrom(anchors, -50)).toBe(0);
    expect(topLineFrom(anchors, 0)).toBe(0);
  });

  it('clamps to the last line past the end', () => {
    expect(topLineFrom(anchors, 9999)).toBe(30);
  });

  it('lands exactly on an anchor', () => {
    expect(topLineFrom(anchors, 100)).toBe(10);
    expect(topLineFrom(anchors, 400)).toBe(20);
  });

  it('interpolates linearly between anchors', () => {
    // Halfway (px) between line 0@0 and line 10@100 -> line 5.
    expect(topLineFrom(anchors, 50)).toBeCloseTo(5, 6);
    // 1/3 of the way (px) between line 10@100 and line 20@400 -> line 13.33.
    expect(topLineFrom(anchors, 200)).toBeCloseTo(13.333, 2);
  });
});

describe('scrollTopFor', () => {
  it('returns 0 for an empty anchor set', () => {
    expect(scrollTopFor([], 12)).toBe(0);
  });

  it('clamps below the first / above the last line', () => {
    expect(scrollTopFor(anchors, -5)).toBe(0);
    expect(scrollTopFor(anchors, 999)).toBe(500);
  });

  it('lands exactly on an anchor', () => {
    expect(scrollTopFor(anchors, 10)).toBe(100);
    expect(scrollTopFor(anchors, 20)).toBe(400);
  });

  it('interpolates linearly between anchors', () => {
    expect(scrollTopFor(anchors, 5)).toBeCloseTo(50, 6);
    expect(scrollTopFor(anchors, 15)).toBeCloseTo(250, 6);
  });
});

describe('round-trip', () => {
  it('topLineFrom and scrollTopFor are mutual inverses on the interior', () => {
    for (const px of [25, 50, 150, 250, 350, 450]) {
      const line = topLineFrom(anchors, px);
      expect(scrollTopFor(anchors, line)).toBeCloseTo(px, 4);
    }
  });
});

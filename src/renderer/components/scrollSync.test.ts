import { describe, it, expect } from 'vitest';
import { type Anchor, topLineFrom, scrollTopFor, blendedFollowerTop } from './scrollSync';

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

describe('blendedFollowerTop', () => {
  // Leader: max 1000, viewport-width blend window of 200px (last screenful).
  const leaderMax = 1000;
  const blendPx = 200;
  const followerMax = 1500; // follower taller than leader

  it('is unchanged in the middle (w=0 → line-anchored)', () => {
    // leaderTop well before the blend window start (leaderMax - blendPx = 800).
    expect(blendedFollowerTop(600, followerMax, 400, leaderMax, blendPx)).toBe(600);
  });

  it('returns exactly followerMax at the leader end (w=1)', () => {
    expect(blendedFollowerTop(900, followerMax, leaderMax, leaderMax, blendPx)).toBe(followerMax);
  });

  it('interpolates monotonically within the blend window', () => {
    const anchored = 900;
    const a = blendedFollowerTop(anchored, followerMax, 850, leaderMax, blendPx); // w=0.25
    const b = blendedFollowerTop(anchored, followerMax, 900, leaderMax, blendPx); // w=0.5
    const c = blendedFollowerTop(anchored, followerMax, 950, leaderMax, blendPx); // w=0.75
    expect(a).toBeGreaterThan(anchored);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(c).toBeLessThan(followerMax);
    // w=0.5 → anchored + 0.5*(1500-900) = 1200
    expect(b).toBeCloseTo(1200, 6);
  });

  it('clamps the line-anchored input to [0, followerMax]', () => {
    // Negative anchored clamps to 0 in the middle.
    expect(blendedFollowerTop(-50, followerMax, 400, leaderMax, blendPx)).toBe(0);
    // Over-max anchored clamps to followerMax.
    expect(blendedFollowerTop(9999, followerMax, 400, leaderMax, blendPx)).toBe(followerMax);
  });

  it('keeps a SHORTER follower at its own end', () => {
    // Follower max is tiny; at the leader end it sits at its end, not beyond.
    expect(blendedFollowerTop(40, 50, leaderMax, leaderMax, blendPx)).toBe(50);
    // Even mid-window it never exceeds the small followerMax.
    expect(blendedFollowerTop(40, 50, 900, leaderMax, blendPx)).toBeLessThanOrEqual(50);
  });

  it('returns 0 when leaderMax <= 0', () => {
    expect(blendedFollowerTop(900, followerMax, 0, 0, blendPx)).toBe(0);
    expect(blendedFollowerTop(900, followerMax, 0, -10, blendPx)).toBe(0);
  });

  it('returns the line-anchored value when blendPx <= 0', () => {
    expect(blendedFollowerTop(700, followerMax, leaderMax, leaderMax, 0)).toBe(700);
    expect(blendedFollowerTop(700, followerMax, leaderMax, leaderMax, -5)).toBe(700);
  });

  it('does not pull the follower off its top when blendPx == leaderMax', () => {
    // SplitView caps blendPx at leaderMax (Fix #18): a leader whose content
    // barely exceeds its viewport has clientHeight > maxScroll, so the cap makes
    // blendPx == leaderMax and the blend window spans the whole range. At the
    // leader's top (leaderTop=0) the weight must be 0 — w = (0-(max-max))/max = 0
    // — so the follower stays line-anchored at its top rather than being dragged
    // toward followerMax.
    expect(blendedFollowerTop(0, followerMax, 0, leaderMax, leaderMax)).toBe(0);
    // And at the leader's end it still co-arrives at followerMax (w=1).
    expect(blendedFollowerTop(0, followerMax, leaderMax, leaderMax, leaderMax)).toBe(followerMax);
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

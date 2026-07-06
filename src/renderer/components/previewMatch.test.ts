import { describe, it, expect } from 'vitest';
import { findMatches, stepMatch, matchLabel } from './previewMatch';

describe('findMatches (preview find)', () => {
  it('returns nothing for an empty query', () => {
    expect(findMatches('the quick brown fox', '', false)).toEqual([]);
  });

  it('returns nothing when the query is absent', () => {
    expect(findMatches('the quick brown fox', 'zebra', false)).toEqual([]);
  });

  it('locates a single match with correct [start,end)', () => {
    expect(findMatches('the quick brown fox', 'quick', false)).toEqual([{ start: 4, end: 9 }]);
  });

  it('finds every occurrence, left to right', () => {
    const hay = 'aXaXa';
    expect(findMatches(hay, 'a', false)).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
      { start: 4, end: 5 },
    ]);
  });

  it('is case-insensitive by default', () => {
    expect(findMatches('Foo foo FOO', 'foo', false)).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);
  });

  it('respects case-sensitivity when asked', () => {
    expect(findMatches('Foo foo FOO', 'foo', true)).toEqual([{ start: 4, end: 7 }]);
  });

  it('matches non-overlapping like find-in-page ("aa" in "aaaa" → 2)', () => {
    expect(findMatches('aaaa', 'aa', false)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it('handles multi-word queries with spaces', () => {
    expect(findMatches('brown fox brown fox', 'brown fox', false)).toEqual([
      { start: 0, end: 9 },
      { start: 10, end: 19 },
    ]);
  });
});

describe('stepMatch (next/previous wraparound)', () => {
  it('advances forward and wraps past the end', () => {
    expect(stepMatch(0, 3, true)).toBe(1);
    expect(stepMatch(1, 3, true)).toBe(2);
    expect(stepMatch(2, 3, true)).toBe(0); // wrap
  });

  it('goes back and wraps past the start', () => {
    expect(stepMatch(2, 3, false)).toBe(1);
    expect(stepMatch(1, 3, false)).toBe(0);
    expect(stepMatch(0, 3, false)).toBe(2); // wrap
  });

  it('lands on the first match forward / last match back when none is active', () => {
    expect(stepMatch(-1, 4, true)).toBe(0);
    expect(stepMatch(-1, 4, false)).toBe(3);
  });

  it('returns -1 when there are no matches', () => {
    expect(stepMatch(0, 0, true)).toBe(-1);
    expect(stepMatch(-1, 0, false)).toBe(-1);
  });
});

describe('matchLabel', () => {
  it('shows the 1-based position of the active match', () => {
    expect(matchLabel(0, 3)).toBe('1 of 3');
    expect(matchLabel(2, 3)).toBe('3 of 3');
  });

  it('reads "0 of 0" with no matches', () => {
    expect(matchLabel(-1, 0)).toBe('0 of 0');
  });

  it('clamps an out-of-range index into the count', () => {
    expect(matchLabel(9, 3)).toBe('3 of 3');
  });
});

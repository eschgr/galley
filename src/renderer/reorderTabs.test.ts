import { describe, it, expect } from 'vitest';
import { reorderToIndex } from './reorderTabs';
import type { Tab } from './App';

function tab(id: string): Tab {
  return {
    id,
    path: `/${id}.md`,
    text: '',
    saved: '',
    dirty: false,
    edited: false,
    conflict: null,
    noticed: false,
    showModal: false,
    docVersion: 0,
  };
}

function ids(tabs: Tab[]): string[] {
  return tabs.map((t) => t.id);
}

describe('reorderToIndex (drag-reorder, #20)', () => {
  // Insertion index is a position in the ORIGINAL array: 0..n.
  const base = () => [tab('a'), tab('b'), tab('c'), tab('d')];

  it('moves a tab right (insert at a later index)', () => {
    // Move 'b' (index 1) to sit after 'd' → insertIndex 4.
    expect(ids(reorderToIndex(base(), 'b', 4))).toEqual(['a', 'c', 'd', 'b']);
  });

  it('moves a tab left (insert at an earlier index)', () => {
    // Move 'd' (index 3) to sit before 'b' → insertIndex 1.
    expect(ids(reorderToIndex(base(), 'd', 1))).toEqual(['a', 'd', 'b', 'c']);
  });

  it('inserts at index 0 (move to front)', () => {
    expect(ids(reorderToIndex(base(), 'c', 0))).toEqual(['c', 'a', 'b', 'd']);
  });

  it('inserts at the end (move to last)', () => {
    expect(ids(reorderToIndex(base(), 'a', 4))).toEqual(['b', 'c', 'd', 'a']);
  });

  it('drop in place (own index) is a no-op and returns the same reference', () => {
    const tabs = base();
    expect(reorderToIndex(tabs, 'b', 1)).toBe(tabs);
  });

  it('drop in the slot just after itself is also a no-op (same reference)', () => {
    const tabs = base();
    // 'b' is at index 1; inserting at index 2 resolves to the same order.
    expect(reorderToIndex(tabs, 'b', 2)).toBe(tabs);
  });

  it('unknown dragged id is a no-op (same reference)', () => {
    const tabs = base();
    expect(reorderToIndex(tabs, 'zzz', 0)).toBe(tabs);
  });

  it('clamps an out-of-range index to the end', () => {
    expect(ids(reorderToIndex(base(), 'a', 99))).toEqual(['b', 'c', 'd', 'a']);
  });

  it('clamps a negative index to the front', () => {
    expect(ids(reorderToIndex(base(), 'd', -5))).toEqual(['d', 'a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const tabs = base();
    reorderToIndex(tabs, 'a', 4);
    expect(ids(tabs)).toEqual(['a', 'b', 'c', 'd']);
  });
});

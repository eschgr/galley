import { describe, it, expect } from 'vitest';
import { decideStartupAction } from './startup';
import type { ClaimResult } from './platform/project';

const owner = { pid: 1, startedAt: 0, host: 'h', project: 'p', dropDir: '/tmp/p' };
const owned: ClaimResult = { owned: true, owner, dropDir: '/tmp/p' };
const notOwned: ClaimResult = { owned: false, owner, dropDir: '/tmp/p' };

describe('decideStartupAction', () => {
  it('owns the window when we won the claim', () => {
    expect(decideStartupAction(owned, ['/a.md', '/b.md'])).toEqual({ kind: 'own' });
  });

  it('hands files off when a live owner already exists', () => {
    expect(decideStartupAction(notOwned, ['/a.md', '/b.md'])).toEqual({
      kind: 'handoff',
      files: ['/a.md', '/b.md'],
    });
  });

  it('hands off even with no files (no duplicate window opens)', () => {
    expect(decideStartupAction(notOwned, [])).toEqual({ kind: 'handoff', files: [] });
  });

  it('owning with no files is still own (empty window bound to the project)', () => {
    expect(decideStartupAction(owned, [])).toEqual({ kind: 'own' });
  });
});

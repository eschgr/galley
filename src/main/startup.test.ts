import { describe, it, expect } from 'vitest';
import { decideStartupAction } from './startup';
import type { ClaimResult } from './platform/project';
import { PROTOCOL, PROTOCOL_VERSION } from './platform/protocol';

function ownerWith(protocol: string) {
  return { pid: 1, startedAt: 0, id: '1-0', protocol, host: 'h', project: 'p', dropDir: '/tmp/p' };
}
const owned: ClaimResult = { owned: true, owner: ownerWith(PROTOCOL_VERSION), dropDir: '/tmp/p' };
const liveCompatible: ClaimResult = { owned: false, owner: ownerWith(PROTOCOL_VERSION), dropDir: '/tmp/p' };
// same major, newer minor — still compatible
const liveNewerMinor: ClaimResult = {
  owned: false,
  owner: ownerWith(`${PROTOCOL.major}.${PROTOCOL.minor + 3}`),
  dropDir: '/tmp/p',
};
// different major — incompatible
const liveIncompatible: ClaimResult = {
  owned: false,
  owner: ownerWith(`${PROTOCOL.major + 1}.0`),
  dropDir: '/tmp/p',
};

describe('decideStartupAction', () => {
  it('owns the window when we won the claim', () => {
    expect(decideStartupAction(owned, [{ path: '/a.md' }, { path: '/b.md' }])).toEqual({ kind: 'own' });
  });

  it('hands files off to a compatible live owner, carrying any reveal line', () => {
    expect(decideStartupAction(liveCompatible, [{ path: '/a.md', line: 12 }, { path: '/b.md' }])).toEqual({
      kind: 'handoff',
      files: [{ path: '/a.md', line: 12 }, { path: '/b.md' }],
    });
  });

  it('hands off to an owner with a newer minor (same major is compatible)', () => {
    expect(decideStartupAction(liveNewerMinor, [{ path: '/a.md' }])).toEqual({
      kind: 'handoff',
      files: [{ path: '/a.md' }],
    });
  });

  it('hands off even with no files (no duplicate window opens)', () => {
    expect(decideStartupAction(liveCompatible, [])).toEqual({ kind: 'handoff', files: [] });
  });

  it('refuses to hand off to an incompatible-major owner', () => {
    expect(decideStartupAction(liveIncompatible, [{ path: '/a.md' }])).toEqual({
      kind: 'incompatible',
      ownerProtocol: `${PROTOCOL.major + 1}.0`,
    });
  });

  it('owning with no files is still own (empty window bound to the project)', () => {
    expect(decideStartupAction(owned, [])).toEqual({ kind: 'own' });
  });
});

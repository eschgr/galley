import { describe, it, expect, vi } from 'vitest';
import { isUpdateAvailable, fetchLatestReleaseTag, checkForUpdate } from './updateCheck';

describe('isUpdateAvailable (version compare)', () => {
  it('is true when the latest tag is a newer major/minor/patch', () => {
    expect(isUpdateAvailable('v0.5.0', '0.4.4')).toBe(true);
    expect(isUpdateAvailable('v0.4.5', '0.4.4')).toBe(true);
    expect(isUpdateAvailable('v1.0.0', '0.9.9')).toBe(true);
  });

  it('is false when equal or older', () => {
    expect(isUpdateAvailable('v0.4.4', '0.4.4')).toBe(false);
    expect(isUpdateAvailable('v0.4.3', '0.4.4')).toBe(false);
    expect(isUpdateAvailable('v0.3.9', '0.4.0')).toBe(false);
  });

  it('tolerates a missing "v" prefix on either side', () => {
    expect(isUpdateAvailable('0.4.5', 'v0.4.4')).toBe(true);
  });

  it('ignores a prerelease suffix (numeric core only)', () => {
    expect(isUpdateAvailable('v0.4.4-beta.1', '0.4.4')).toBe(false);
  });

  it('is false for an unparseable tag', () => {
    expect(isUpdateAvailable('latest', '0.4.4')).toBe(false);
    expect(isUpdateAvailable('v0.4.5', 'nightly')).toBe(false);
  });
});

describe('fetchLatestReleaseTag', () => {
  const ok = (tag: unknown) =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ tag_name: tag }) } as Response);

  it('returns the tag_name from a successful response', async () => {
    const fetchImpl = vi.fn().mockReturnValue(ok('v0.5.0'));
    await expect(fetchLatestReleaseTag(fetchImpl)).resolves.toBe('v0.5.0');
  });

  it('returns null on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false } as Response);
    await expect(fetchLatestReleaseTag(fetchImpl)).resolves.toBeNull();
  });

  it('returns null when the body has no string tag_name', async () => {
    await expect(fetchLatestReleaseTag(vi.fn().mockReturnValue(ok(undefined)))).resolves.toBeNull();
  });

  it('returns null (never throws) when the request rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(fetchLatestReleaseTag(fetchImpl)).resolves.toBeNull();
  });
});

describe('checkForUpdate', () => {
  const base = { currentVersion: '0.4.4', fetchLatestTag: () => Promise.resolve('v0.5.0') };

  it('notifies on a packaged build when a newer release exists', async () => {
    const notify = vi.fn();
    await checkForUpdate({ ...base, packaged: true, notify });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does NOT notify on a dev (unpackaged) build, even when newer', async () => {
    const notify = vi.fn();
    await checkForUpdate({ ...base, packaged: false, notify });
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not notify when the latest is not newer', async () => {
    const notify = vi.fn();
    await checkForUpdate({ currentVersion: '0.5.0', fetchLatestTag: () => Promise.resolve('v0.5.0'), packaged: true, notify });
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not notify (and does not throw) when the fetch yields null', async () => {
    const notify = vi.fn();
    await expect(
      checkForUpdate({ ...base, fetchLatestTag: () => Promise.resolve(null), packaged: true, notify }),
    ).resolves.toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { readStartupFiles } from './startupFiles';
import type { FileSnapshot } from './platform';

const snap = (p: string): FileSnapshot => ({ path: p, content: `content of ${p}`, hash: `h:${p}` });

describe('readStartupFiles (the file:getStartup path)', () => {
  it('reads every path and returns snapshots in command-line order', async () => {
    const read = vi.fn(async (p: string) => snap(p));
    const watch = vi.fn();
    const onError = vi.fn();

    const out = await readStartupFiles(['/a.md', '/b.md', '/c.md'], read, watch, onError);

    expect(out.map((s) => s.path)).toEqual(['/a.md', '/b.md', '/c.md']);
    expect(out[0].content).toBe('content of /a.md');
    expect(onError).not.toHaveBeenCalled();
  });

  it('watches each successfully-read file (in order)', async () => {
    const watch = vi.fn();
    await readStartupFiles(['/a.md', '/b.md'], async (p) => snap(p), watch, vi.fn());
    expect(watch.mock.calls.map((c) => c[0])).toEqual(['/a.md', '/b.md']);
  });

  it('skips an unreadable path (reports it) and still returns + watches the rest, in order', async () => {
    const read = vi.fn(async (p: string) => {
      if (p === '/bad.md') throw new Error('ENOENT');
      return snap(p);
    });
    const watch = vi.fn();
    const onError = vi.fn();

    const out = await readStartupFiles(['/a.md', '/bad.md', '/c.md'], read, watch, onError);

    expect(out.map((s) => s.path)).toEqual(['/a.md', '/c.md']); // bad one dropped, order kept
    expect(watch.mock.calls.map((c) => c[0])).toEqual(['/a.md', '/c.md']); // unreadable not watched
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe('/bad.md');
    expect(onError.mock.calls[0][1]).toBeInstanceOf(Error);
  });

  it('returns an empty array (and touches nothing) for no paths', async () => {
    const read = vi.fn();
    const watch = vi.fn();
    const out = await readStartupFiles([], read, watch, vi.fn());
    expect(out).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
  });
});

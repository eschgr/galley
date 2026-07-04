import { describe, it, expect } from 'vitest';
import {
  decideCrashReload,
  materializeRestore,
  RELOAD_CAP,
  RELOAD_WINDOW_MS,
} from './crashReload';
import type { OpenedFile } from '../shared/api';

// --- decideCrashReload (FIX 1) ---------------------------------------------
// Time is injected via `now`, so these are deterministic — never real clock.
describe('decideCrashReload', () => {
  const base = { closing: false, destroyed: false, recentReloads: [] as number[], now: 1_000 };

  it('does not reload on a clean exit, and leaves history untouched', () => {
    const r = decideCrashReload({ ...base, reason: 'clean-exit', recentReloads: [500] });
    expect(r.reload).toBe(false);
    expect(r.gaveUp).toBe(false);
    expect(r.recentReloads).toEqual([500]);
  });

  it('does not reload while the window is closing', () => {
    const r = decideCrashReload({ ...base, reason: 'crashed', closing: true });
    expect(r).toEqual({ reload: false, recentReloads: [], gaveUp: false });
  });

  it('does not reload when the window is destroyed', () => {
    const r = decideCrashReload({ ...base, reason: 'crashed', destroyed: true });
    expect(r).toEqual({ reload: false, recentReloads: [], gaveUp: false });
  });

  it('reloads on a single crash and records the timestamp', () => {
    const r = decideCrashReload({ ...base, reason: 'crashed' });
    expect(r.reload).toBe(true);
    expect(r.gaveUp).toBe(false);
    expect(r.recentReloads).toEqual([1_000]);
  });

  // The FIX 1 regression guard: crash-during-reload modeled as N consecutive
  // crashes. The old stuck-`reloading`-flag logic would reload once then swallow
  // every later crash forever (blank window). The cap reloads up to RELOAD_CAP,
  // then gives up cleanly — it neither hangs blank nor loops.
  it('reloads up to the cap across consecutive crashes, then gives up cleanly', () => {
    let recentReloads: number[] = [];
    const reloads: number[] = [];
    // Same instant each time — a deterministic mount-time crash storm.
    const now = 5_000;
    for (let i = 0; i < RELOAD_CAP; i++) {
      const r = decideCrashReload({ reason: 'crashed', closing: false, destroyed: false, recentReloads, now });
      expect(r.reload).toBe(true);
      expect(r.gaveUp).toBe(false);
      recentReloads = r.recentReloads;
      reloads.push(now);
    }
    expect(reloads).toHaveLength(RELOAD_CAP);
    // The (RELOAD_CAP + 1)-th crash within the window: stop, don't loop or hang.
    const giveUp = decideCrashReload({ reason: 'crashed', closing: false, destroyed: false, recentReloads, now });
    expect(giveUp.reload).toBe(false);
    expect(giveUp.gaveUp).toBe(true);
    expect(giveUp.recentReloads).toHaveLength(RELOAD_CAP);
  });

  it('ages out timestamps older than the window so a later lone crash reloads again', () => {
    // A full cap's worth of reloads, all long in the past.
    const old = Array.from({ length: RELOAD_CAP }, (_, i) => i);
    const later = RELOAD_WINDOW_MS + 100; // beyond the window from every old timestamp
    const r = decideCrashReload({
      reason: 'crashed',
      closing: false,
      destroyed: false,
      recentReloads: old,
      now: later,
    });
    expect(r.reload).toBe(true);
    expect(r.gaveUp).toBe(false);
    // The stale timestamps are pruned; only the fresh one remains.
    expect(r.recentReloads).toEqual([later]);
  });
});

// --- materializeRestore (FIX 2) --------------------------------------------
describe('materializeRestore', () => {
  const file = (p: string): OpenedFile => ({ path: p, content: `content:${p}`, hash: `h:${p}` });
  // A fake readFile: returns null for any path in `missing`, else a snapshot.
  const reader = (missing: Set<string>) => async (p: string): Promise<OpenedFile | null> =>
    missing.has(p) ? null : file(p);

  it('loads all tabs and preserves activeIndex when every file is present', async () => {
    const decision = { files: ['a', 'b', 'c'], activeIndex: 1 };
    const result = await materializeRestore(decision, reader(new Set()));
    expect(result).toEqual({ files: ['a', 'b', 'c'].map(file), activeIndex: 1 });
  });

  it('decrements activeIndex when a file BEFORE the active tab is missing', async () => {
    const decision = { files: ['a', 'b', 'c'], activeIndex: 2 };
    const result = await materializeRestore(decision, reader(new Set(['a'])));
    // 'c' was index 2; dropping 'a' (before it) shifts it to index 1.
    expect(result).toEqual({ files: ['b', 'c'].map(file), activeIndex: 1 });
  });

  it('clamps to a valid tab when the ACTIVE file itself is missing', async () => {
    const decision = { files: ['a', 'b', 'c'], activeIndex: 1 };
    const result = await materializeRestore(decision, reader(new Set(['b'])));
    // The active tab ('b') was skipped → clamp to the first restored tab.
    expect(result).toEqual({ files: ['a', 'c'].map(file), activeIndex: 0 });
  });

  it('returns null when ALL files are missing', async () => {
    const decision = { files: ['a', 'b'], activeIndex: 0 };
    const result = await materializeRestore(decision, reader(new Set(['a', 'b'])));
    expect(result).toBeNull();
  });
});

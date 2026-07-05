import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlatformBridge, type ExternalChangeEvent } from './index';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('platform watcher (watch open files, self-write detection, debounce)', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it(
    'ignores the app own saves and forwards genuine external changes',
    async () => {
      const bridge = createPlatformBridge({ projectsHome: () => path.join(os.tmpdir(), 'galley-projects-test') });
      const dir = await mkdtemp(path.join(os.tmpdir(), 'galley-watch-'));
      dirs.push(dir);
      const file = path.join(dir, 'doc.md');
      await bridge.writeFile(file, 'initial\n');

      const events: ExternalChangeEvent[] = [];
      bridge.watch(file, (e) => events.push(e));
      await wait(400); // let chokidar become ready

      // Self-write detection: the app's own save must NOT be forwarded.
      await bridge.writeFile(file, 'app save\n');
      await wait(600);
      expect(events.length).toBe(0);

      // A genuine external write (bypassing the bridge) IS forwarded.
      await fsWriteFile(file, '# external\n\nchanged on disk\n', 'utf8');
      for (let i = 0; i < 40 && events.length === 0; i++) await wait(100);
      bridge.unwatch(file);

      expect(events.length).toBeGreaterThanOrEqual(1);
      const last = events[events.length - 1];
      expect(last.path).toBe(file);
      expect(last.content).toContain('changed on disk');
      expect(last.hash).toHaveLength(64); // sha256 hex
    },
    20_000,
  );

  it(
    'ignores a burst of consecutive app saves, even ones the watcher surfaces out of order',
    async () => {
      // Only the LATEST written hash lives in the single `knownHash` slot, so if a
      // watcher event surfaces a slightly-stale read of an earlier save in the
      // burst, self-write detection must still recognize it (via the recent-write
      // set) and forward nothing. This is the regression guard for the CI flake.
      const bridge = createPlatformBridge({ projectsHome: () => path.join(os.tmpdir(), 'galley-projects-test') });
      const dir = await mkdtemp(path.join(os.tmpdir(), 'galley-watch-'));
      dirs.push(dir);
      const file = path.join(dir, 'doc.md');
      await bridge.writeFile(file, 'v0\n');

      const events: ExternalChangeEvent[] = [];
      bridge.watch(file, (e) => events.push(e));
      await wait(400); // let chokidar become ready

      // A rapid burst of our own saves — each a distinct hash; only the last
      // matches `knownHash`, the rest must be caught by the recent-write set.
      for (let i = 1; i <= 5; i++) {
        await bridge.writeFile(file, `v${i}\n`);
        await wait(60);
      }
      await wait(600);
      expect(events.length).toBe(0);

      bridge.unwatch(file);
    },
    20_000,
  );
});

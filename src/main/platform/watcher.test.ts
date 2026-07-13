import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm, rename, unlink, writeFile as fsWriteFile } from 'node:fs/promises';
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
    'does not surface a rapid burst of the app own saves as external changes',
    async () => {
      // Real-filesystem smoke check that a rapid burst of our own saves does not
      // reach the renderer as spurious external changes. The AUTHORITATIVE guarantee
      // — that every hash in a burst, not just the latest `knownHash`, is recognized
      // as ours via the recent-write set — is covered deterministically (clock-
      // injected, no real timers) in selfWriteTracker.test.ts. Here chokidar's
      // awaitWriteFinish coalesces the burst and typically surfaces only the settled
      // final save (which matches `knownHash`), so nothing is forwarded. On a heavily
      // loaded runner chokidar can occasionally emit one transient read mid-swap of a
      // content the app never wrote; a lone such blip is tolerated. A genuine self-
      // write regression (earlier burst saves leaking through) surfaces several, and
      // is caught deterministically by the unit test regardless of this count.
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
      expect(events.length).toBeLessThanOrEqual(1);

      bridge.unwatch(file);
    },
    20_000,
  );

  it(
    'forwards a removal (delete) instead of silently swallowing it (file gone)',
    async () => {
      const bridge = createPlatformBridge({ projectsHome: () => path.join(os.tmpdir(), 'galley-projects-test') });
      const dir = await mkdtemp(path.join(os.tmpdir(), 'galley-watch-'));
      dirs.push(dir);
      const file = path.join(dir, 'doc.md');
      await bridge.writeFile(file, 'here for now\n');

      const changes: ExternalChangeEvent[] = [];
      const removed: string[] = [];
      bridge.watch(
        file,
        (e) => changes.push(e),
        (p) => removed.push(p),
      );
      await wait(400); // let chokidar become ready

      await unlink(file);
      for (let i = 0; i < 40 && removed.length === 0; i++) await wait(100);
      bridge.unwatch(file);

      expect(removed).toContain(file); // the removal is surfaced...
      expect(changes.length).toBe(0); // ...and never mistaken for a content change
    },
    20_000,
  );

  it(
    'forwards a move (rename away) as a removal at the old path',
    async () => {
      const bridge = createPlatformBridge({ projectsHome: () => path.join(os.tmpdir(), 'galley-projects-test') });
      const dir = await mkdtemp(path.join(os.tmpdir(), 'galley-watch-'));
      dirs.push(dir);
      const file = path.join(dir, 'doc.md');
      const moved = path.join(dir, 'moved.md');
      await bridge.writeFile(file, 'about to move\n');

      const removed: string[] = [];
      bridge.watch(file, () => undefined, (p) => removed.push(p));
      await wait(400);

      await rename(file, moved); // a move surfaces as unlink at the old path
      for (let i = 0; i < 40 && removed.length === 0; i++) await wait(100);
      bridge.unwatch(file);

      expect(removed).toContain(file);
    },
    20_000,
  );
});

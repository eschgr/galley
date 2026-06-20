import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlatformBridge, type ExternalChangeEvent } from './index';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('platform watcher (R32/R33/R37)', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it(
    'ignores the app own saves and forwards genuine external changes',
    async () => {
      const bridge = createPlatformBridge();
      const dir = await mkdtemp(path.join(os.tmpdir(), 'galley-watch-'));
      dirs.push(dir);
      const file = path.join(dir, 'doc.md');
      await bridge.writeFile(file, 'initial\n');

      const events: ExternalChangeEvent[] = [];
      bridge.watch(file, (e) => events.push(e));
      await wait(400); // let chokidar become ready

      // R33: the app's own save must NOT be forwarded.
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
});

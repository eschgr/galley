import { describe, it, expect, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlatformBridge } from './index';
import { projectPaths, readSession, SESSION_FILE } from './projectStore';

// Bridge-level session persistence (#61 clean-vs-crash invariant, §8.6, PF19).
//
// The file-layer (projectStore.writeSession/readSession/parseSessionRecord) is
// covered by projectStore.test.ts; here we exercise the BRIDGE methods on
// createPlatformBridge — claimProject → writeSession → markCleanExit — which
// wire the retained claimed-project home into the session record and stamp the
// cleanExit flag. Hermetic: a fresh temp dir per test as the injected
// projectsHome, cleaned up; nothing touches the real userData.
const roots: string[] = [];
function freshProjectsHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'galley-bridge-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Every `session.json` anywhere under `dir` (recursive) — for the no-op assertion. */
function findSessionFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === SESSION_FILE) found.push(full);
    }
  };
  walk(dir);
  return found;
}

describe('platform bridge session persistence (#61, §8.6, PF19)', () => {
  it('is a no-op with no claimed project — writeSession/markCleanExit write nothing', () => {
    const home = freshProjectsHome();
    const bridge = createPlatformBridge({ projectsHome: () => home });

    // Projectless window (PF27): no claimProject, so no home to persist to.
    bridge.writeSession({ files: ['/x/a.md'], activeIndex: 0 });
    bridge.markCleanExit();

    // Nothing was written anywhere under the projects-home.
    expect(findSessionFiles(home)).toEqual([]);
  });

  it(
    'writeSession stamps cleanExit:false and records files/activeIndex in order',
    async () => {
      const home = freshProjectsHome();
      const bridge = createPlatformBridge({ projectsHome: () => home });

      await bridge.claimProject('TestProj');
      bridge.writeSession({ files: ['/x/a.md', '/x/b.md'], activeIndex: 1 });

      const record = readSession(projectPaths(home, 'TestProj').homeDir);
      expect(record).not.toBeNull();
      expect(record?.cleanExit).toBe(false); // running — the crash-safety-net state
      expect(record?.files).toEqual(['/x/a.md', '/x/b.md']); // order preserved
      expect(record?.activeIndex).toBe(1);
    },
    15_000,
  );

  it(
    'markCleanExit flips cleanExit to true while PRESERVING files/activeIndex (regression guard)',
    async () => {
      const home = freshProjectsHome();
      const bridge = createPlatformBridge({ projectsHome: () => home });

      await bridge.claimProject('TestProj');
      bridge.writeSession({ files: ['/x/a.md', '/x/b.md'], activeIndex: 1 });
      bridge.markCleanExit();

      const record = readSession(projectPaths(home, 'TestProj').homeDir);
      expect(record).not.toBeNull();
      expect(record?.cleanExit).toBe(true); // clean shutdown flagged
      // The open-set MUST survive the flip. A bug that rewrote a fresh
      // { cleanExit:true } (losing files) fails here.
      expect(record?.files).toEqual(['/x/a.md', '/x/b.md']);
      expect(record?.activeIndex).toBe(1);
    },
    15_000,
  );

  it(
    'markCleanExit is a no-op when no session was ever written — does not throw, disk stays null',
    async () => {
      const home = freshProjectsHome();
      const bridge = createPlatformBridge({ projectsHome: () => home });

      await bridge.claimProject('OtherProj');
      // No prior writeSession: nothing to mark. Must not throw or create a record.
      expect(() => bridge.markCleanExit()).not.toThrow();

      expect(readSession(projectPaths(home, 'OtherProj').homeDir)).toBeNull();
    },
    15_000,
  );
});

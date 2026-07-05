import { describe, it, expect, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlatformBridge } from './index';
import { projectPaths, readSession, SESSION_FILE } from './projectStore';

// Bridge-level session persistence (clean-vs-crash invariant).
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

describe('platform bridge session persistence', () => {
  it('is a no-op with no claimed project — writeSession/markCleanExit write nothing', () => {
    const home = freshProjectsHome();
    const bridge = createPlatformBridge({ projectsHome: () => home });

    // Projectless window: no claimProject, so no home to persist to.
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

// The restore DECISION. getRestoreSession is the pure
// dirty-vs-clean gate: it returns the persisted paths+active only when a claimed
// project's session is a dirty shutdown (cleanExit:false) with a non-empty open-set,
// and null in every other branch. Loading the paths from disk is main's job (not
// here). Each branch is exercised hermetically against a fresh temp projects-home.
describe('platform bridge session restore decision', () => {
  it(
    'returns the session when dirty (cleanExit:false) with a non-empty open-set + a claimed project',
    async () => {
      const home = freshProjectsHome();
      const bridge = createPlatformBridge({ projectsHome: () => home });

      await bridge.claimProject('TestProj');
      // writeSession stamps cleanExit:false — the running / crash-safety-net state.
      bridge.writeSession({ files: ['/x/a.md', '/x/b.md'], activeIndex: 1 });

      expect(bridge.getRestoreSession()).toEqual({
        files: ['/x/a.md', '/x/b.md'],
        activeIndex: 1,
      });
    },
    15_000,
  );

  it(
    'returns null after a CLEAN shutdown (cleanExit:true) — the whole point of the flag',
    async () => {
      const home = freshProjectsHome();
      const bridge = createPlatformBridge({ projectsHome: () => home });

      await bridge.claimProject('TestProj');
      bridge.writeSession({ files: ['/x/a.md'], activeIndex: 0 });
      bridge.markCleanExit(); // flips cleanExit:true — a clean quit starts fresh

      expect(bridge.getRestoreSession()).toBeNull();
    },
    15_000,
  );

  it(
    'returns null when session.json is absent (no session ever written)',
    async () => {
      const home = freshProjectsHome();
      const bridge = createPlatformBridge({ projectsHome: () => home });

      await bridge.claimProject('TestProj');
      // No writeSession — nothing on disk to restore.
      expect(bridge.getRestoreSession()).toBeNull();
    },
    15_000,
  );

  it(
    'returns null when the open-set is empty even though the shutdown was dirty',
    async () => {
      const home = freshProjectsHome();
      const bridge = createPlatformBridge({ projectsHome: () => home });

      await bridge.claimProject('TestProj');
      bridge.writeSession({ files: [], activeIndex: -1 }); // dirty, but nothing open

      expect(bridge.getRestoreSession()).toBeNull();
    },
    15_000,
  );

  it('returns null when projectless (no claim) — projectless never restores', () => {
    const home = freshProjectsHome();
    const bridge = createPlatformBridge({ projectsHome: () => home });

    // No claimProject: a projectless window has no home, so nothing to restore —
    // even though writeSession is a no-op, the decision must be null regardless.
    bridge.writeSession({ files: ['/x/a.md'], activeIndex: 0 });
    expect(bridge.getRestoreSession()).toBeNull();
  });
});

// Project identity getter. projectName surfaces the claimed project's
// name for the title bar; null before a claim (and in projectless mode) and the
// name afterwards.
describe('platform bridge project identity', () => {
  it('projectName is null before any claim (projectless)', () => {
    const home = freshProjectsHome();
    const bridge = createPlatformBridge({ projectsHome: () => home });

    expect(bridge.projectName()).toBeNull();
  });

  it(
    'after a successful claim, projectName is the claimed name',
    async () => {
      const home = freshProjectsHome();
      const bridge = createPlatformBridge({ projectsHome: () => home });

      await bridge.claimProject('TestProj');

      expect(bridge.projectName()).toBe('TestProj');
    },
    15_000,
  );
});

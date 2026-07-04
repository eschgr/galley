import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deriveDirName,
  projectPaths,
  parseProjectRecord,
  readProjectRecord,
  materializeProjectRecord,
  createOrAdoptRecord,
  parseSessionRecord,
  readSession,
  writeSession,
  PROJECT_SCHEMA_VERSION,
  SESSION_SCHEMA_VERSION,
  SESSION_FILE,
  RUNTIME_DIR,
  PROJECT_FILE,
  type ProjectRecord,
  type SessionRecord,
} from './projectStore';

// projectStore owns home-path derivation (§8.4), the §7 layout, and the durable
// project.json record. Hermetic: a temp baseDir per test, cleaned up; nothing
// touches the real userData.
const roots: string[] = [];
function freshBaseDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'galley-store-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('deriveDirName (§8.4 home derivation)', () => {
  it('is deterministic — same name ⇒ same token', () => {
    expect(deriveDirName('My Project')).toBe(deriveDirName('My Project'));
  });

  it('is collision-free — different names ⇒ different tokens (even same slug)', () => {
    // "A B" and "a-b" both sanitize to the slug "a-b"; the hash suffix separates them.
    expect(deriveDirName('A B')).not.toBe(deriveDirName('a-b'));
  });

  it('is filesystem-safe for a name with spaces', () => {
    const token = deriveDirName('My Notes 2026');
    expect(token).toMatch(/^[a-z0-9._-]+-[0-9a-f]{8}$/);
    expect(token).not.toContain(' ');
    expect(token).toContain('my-notes-2026');
  });

  it('is filesystem-safe for a name with unsafe/unusual characters', () => {
    const token = deriveDirName('Réémval: draft #1!');
    expect(token).toMatch(/^[a-z0-9._-]+-[0-9a-f]{8}$/); // only safe chars survive
  });

  it('falls back to "p" when the name sanitizes to empty', () => {
    const token = deriveDirName('!!!');
    expect(token).toMatch(/^p-[0-9a-f]{8}$/);
  });

  it('trims leading dots so the slug alone is never "."/".."/"..." (defense-in-depth)', () => {
    // "..." is a legal launch key (not "." or ".."), but its sanitized slug must
    // not itself be a dot-run — even before the hash suffix keeps the token safe.
    const token = deriveDirName('...');
    const slug = token.replace(/-[0-9a-f]{8}$/, '');
    expect(['.', '..', '...']).not.toContain(slug);
    expect(token).toMatch(/^[a-z0-9._-]*-?[0-9a-f]{8}$/);
    // A dotted prefix on a real name keeps the readable tail, not the dots.
    expect(deriveDirName('...draft')).toMatch(/^draft-[0-9a-f]{8}$/);
  });

  it('bounds the directory component for a pathologically long name (no ENAMETOOLONG)', () => {
    const token = deriveDirName('x'.repeat(5000));
    // slug capped at 64 + '-' + 8 hex = 73 chars, well under the 255-char limit.
    expect(token.length).toBeLessThanOrEqual(64 + 1 + 8);
    expect(token).toMatch(/^x{64}-[0-9a-f]{8}$/);
  });

  it('stays deterministic and collision-free even when slugs are truncated alike', () => {
    const a = 'y'.repeat(200) + '-alpha';
    const b = 'y'.repeat(200) + '-beta';
    // Both truncate to the same 64-'y' slug, but the hash is over the full name.
    expect(deriveDirName(a)).toBe(deriveDirName(a)); // deterministic
    expect(deriveDirName(a)).not.toBe(deriveDirName(b)); // collision-free
  });

  it('keeps allowed characters and trims leading/trailing dashes', () => {
    expect(deriveDirName('  hello_world.md  ')).toMatch(/^hello_world\.md-[0-9a-f]{8}$/);
  });

  it('rejects traversal / separators / control chars', () => {
    expect(() => deriveDirName('.')).toThrow();
    expect(() => deriveDirName('..')).toThrow();
    expect(() => deriveDirName('a/b')).toThrow();
    expect(() => deriveDirName('a\\b')).toThrow();
    expect(() => deriveDirName('bad\x00name')).toThrow();
    expect(() => deriveDirName('')).toThrow();
  });
});

describe('projectPaths (§7 layout)', () => {
  it('places home under baseDir with runtime/ and project.json inside', () => {
    const base = '/tmp/base';
    const p = projectPaths(base, 'Proj');
    expect(p.homeDir).toBe(path.join(base, deriveDirName('Proj')));
    expect(p.runtimeDir).toBe(path.join(p.homeDir, RUNTIME_DIR));
    expect(p.recordPath).toBe(path.join(p.homeDir, PROJECT_FILE));
  });
});

describe('parseProjectRecord (tolerant, versioned)', () => {
  it('round-trips a full record', () => {
    const rec = { schemaVersion: 1, name: 'Doc set', createdAt: 123, appVersion: '1.2.3' };
    expect(parseProjectRecord(rec)).toEqual(rec);
  });

  it('ignores unknown fields and defaults missing ones', () => {
    const parsed = parseProjectRecord({ name: 'Only name', future: { x: 1 } });
    expect(parsed?.name).toBe('Only name');
    expect(parsed?.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(typeof parsed?.createdAt).toBe('number');
    expect(parsed).not.toHaveProperty('future');
  });

  it('rejects a record with no usable name', () => {
    expect(parseProjectRecord({ createdAt: 1 })).toBeNull();
    expect(parseProjectRecord({ name: '' })).toBeNull();
    expect(parseProjectRecord(null)).toBeNull();
    expect(parseProjectRecord('nope')).toBeNull();
  });
});

describe('readProjectRecord', () => {
  it('returns null when absent or corrupt', () => {
    const base = freshBaseDir();
    const p = projectPaths(base, 'missing');
    expect(readProjectRecord(p.recordPath)).toBeNull();
    fs.mkdirSync(p.homeDir, { recursive: true });
    fs.writeFileSync(p.recordPath, '{not json');
    expect(readProjectRecord(p.recordPath)).toBeNull();
  });
});

describe('materializeProjectRecord (PF3 materialize-or-reuse)', () => {
  it('creates project.json on first materialization', () => {
    const base = freshBaseDir();
    const p = projectPaths(base, 'New One');
    const rec = materializeProjectRecord(p, 'New One', { appVersion: '2.0.0' });
    expect(rec.name).toBe('New One');
    expect(rec.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(rec.appVersion).toBe('2.0.0');
    expect(fs.existsSync(p.recordPath)).toBe(true);
    // Round-trips through disk to the same record.
    expect(readProjectRecord(p.recordPath)).toEqual(rec);
  });

  it('reuses an existing record and preserves its createdAt (no clobber)', () => {
    const base = freshBaseDir();
    const p = projectPaths(base, 'Reused');
    const first = materializeProjectRecord(p, 'Reused');
    const originalCreatedAt = first.createdAt;

    // A later launch must NOT overwrite createdAt.
    const second = materializeProjectRecord(p, 'Reused', { appVersion: '9.9.9' });
    expect(second.createdAt).toBe(originalCreatedAt);
    expect(readProjectRecord(p.recordPath)?.createdAt).toBe(originalCreatedAt);
  });

  it('does not clobber createdAt via the CREATE path when the record already exists', () => {
    // The reuse test above short-circuits at the `if (existing) return` guard, so
    // it never exercises the create/race path. This one drives the create path
    // directly: `createOrAdoptRecord` must ADOPT the existing on-disk record, not
    // overwrite it. It would FAIL against the old rename-over implementation,
    // which silently overwrites the target on Windows (fs.renameSync does not
    // throw there), clobbering the earlier writer's createdAt.
    const base = freshBaseDir();
    const p = projectPaths(base, 'Racer');
    fs.mkdirSync(p.homeDir, { recursive: true });

    // Simulate the winner having already materialized project.json (older createdAt).
    const winner: ProjectRecord = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      name: 'Racer',
      createdAt: 1000,
      appVersion: '1.0.0',
    };
    fs.writeFileSync(p.recordPath, JSON.stringify(winner, null, 2));

    // A loser reaches the create step with its own (newer) record. It must adopt
    // the winner's record wholesale, NOT overwrite createdAt/appVersion.
    const loser: ProjectRecord = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      name: 'Racer',
      createdAt: 2000,
      appVersion: '9.9.9',
    };
    const adopted = createOrAdoptRecord(p.recordPath, loser);
    expect(adopted).toEqual(winner);
    expect(adopted.createdAt).toBe(1000);
    // And disk is untouched — still the winner's record.
    expect(readProjectRecord(p.recordPath)).toEqual(winner);
  });

  it('createOrAdoptRecord writes the record when the file is absent (create path)', () => {
    const base = freshBaseDir();
    const p = projectPaths(base, 'FreshCreate');
    fs.mkdirSync(p.homeDir, { recursive: true });
    const record: ProjectRecord = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      name: 'FreshCreate',
      createdAt: 4242,
    };
    const written = createOrAdoptRecord(p.recordPath, record);
    expect(written).toEqual(record);
    expect(readProjectRecord(p.recordPath)).toEqual(record);
  });

  it('does not create the runtime/ dir (that is the ownership layer job)', () => {
    const base = freshBaseDir();
    const p = projectPaths(base, 'JustRecord');
    materializeProjectRecord(p, 'JustRecord');
    expect(fs.existsSync(p.runtimeDir)).toBe(false);
  });
});

describe('session record (§8.6, PF19 — write side only)', () => {
  const full: SessionRecord = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    files: ['/a/one.md', '/b/two.md'],
    activeIndex: 1,
    cleanExit: false,
  };

  describe('parseSessionRecord (tolerant, versioned)', () => {
    it('round-trips a full record', () => {
      expect(parseSessionRecord({ ...full })).toEqual(full);
    });

    it('ignores unknown fields and defaults missing ones', () => {
      const parsed = parseSessionRecord({ files: ['/x.md'], future: { y: 2 } });
      expect(parsed?.files).toEqual(['/x.md']);
      expect(parsed?.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
      expect(parsed?.activeIndex).toBe(-1); // missing → no active tab
      expect(parsed?.cleanExit).toBe(true); // missing flag defaults to clean, never a false crash
      expect(parsed).not.toHaveProperty('future');
    });

    it('preserves cleanExit true AND false (the load-bearing shutdown flag)', () => {
      expect(parseSessionRecord({ files: [], cleanExit: false })?.cleanExit).toBe(false);
      expect(parseSessionRecord({ files: [], cleanExit: true })?.cleanExit).toBe(true);
    });

    it('accepts an empty open set', () => {
      const parsed = parseSessionRecord({ files: [], activeIndex: -1, cleanExit: false });
      expect(parsed?.files).toEqual([]);
      expect(parsed?.activeIndex).toBe(-1);
    });

    it('rejects garbage — non-object, or files not a string array', () => {
      expect(parseSessionRecord(null)).toBeNull();
      expect(parseSessionRecord('nope')).toBeNull();
      expect(parseSessionRecord({})).toBeNull(); // no files array
      expect(parseSessionRecord({ files: 'x.md' })).toBeNull(); // files not an array
      expect(parseSessionRecord({ files: [1, 2] })).toBeNull(); // not all strings
    });
  });

  describe('writeSession / readSession (atomic round-trip)', () => {
    it('round-trips a record through disk', () => {
      const home = freshBaseDir();
      writeSession(home, full);
      expect(readSession(home)).toEqual(full);
    });

    it('creates the home dir if absent', () => {
      const base = freshBaseDir();
      const home = path.join(base, 'nested', 'home'); // does not exist yet
      writeSession(home, full);
      expect(fs.existsSync(path.join(home, SESSION_FILE))).toBe(true);
      expect(readSession(home)).toEqual(full);
    });

    it('persists cleanExit false then true across rewrites', () => {
      const home = freshBaseDir();
      writeSession(home, { ...full, cleanExit: false });
      expect(readSession(home)?.cleanExit).toBe(false);
      writeSession(home, { ...full, cleanExit: true });
      expect(readSession(home)?.cleanExit).toBe(true);
    });

    it('leaves a valid, parseable JSON file (atomic write, no stray .swap temp)', () => {
      const home = freshBaseDir();
      writeSession(home, full);
      const onDisk = fs.readFileSync(path.join(home, SESSION_FILE), 'utf8');
      expect(() => JSON.parse(onDisk)).not.toThrow();
      // The atomic temp file is renamed away, never left behind.
      const leftovers = fs.readdirSync(home).filter((f) => f.includes('.swap'));
      expect(leftovers).toEqual([]);
    });

    it('readSession returns null when absent or corrupt', () => {
      const home = freshBaseDir();
      expect(readSession(home)).toBeNull(); // absent
      fs.writeFileSync(path.join(home, SESSION_FILE), '{not json');
      expect(readSession(home)).toBeNull(); // garbage
    });
  });
});

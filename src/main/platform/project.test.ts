import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  isProcessAlive,
  queryProcessStartTime,
  parseWmicCreationDate,
  parseFileTimeUtc,
  parsePsLstart,
  readProjectOwner,
  isProjectLive,
  acquireProject,
  releaseProject,
  reassertOwner,
  OWNER_FILE,
  type ProjectOwner,
} from './project';

// Ownership + liveness now operate on a plain `runtime/` dir (derived by
// projectStore from the durable home). Each test mints a hermetic temp dir under
// os.tmpdir() and cleans it up — nothing touches the real userData.
const roots: string[] = [];
function freshRuntimeDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'galley-proj-'));
  roots.push(root);
  return path.join(root, 'runtime');
}
function writeOwner(runtimeDir: string, owner: Partial<ProjectOwner>): void {
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, OWNER_FILE), JSON.stringify({ host: os.hostname(), ...owner }));
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A pid that is guaranteed dead: spawn a node that exits immediately, then reuse its pid. */
function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    if (child.pid === undefined) return reject(new Error('spawn failed'));
    const pid = child.pid;
    child.on('exit', () => setTimeout(() => resolve(pid), 50));
  });
}

describe('isProcessAlive', () => {
  it('is true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });
  it('is false for a process that has exited', async () => {
    expect(isProcessAlive(await deadPid())).toBe(false);
  });
  it('is false for nonsense pids', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(NaN)).toBe(false);
  });
});

describe('readProjectOwner', () => {
  it('returns null when there is no record', () => {
    expect(readProjectOwner(freshRuntimeDir())).toBeNull();
  });
  it('reads back a written record', () => {
    const dir = freshRuntimeDir();
    writeOwner(dir, { pid: 4242 });
    expect(readProjectOwner(dir)?.pid).toBe(4242);
  });
  it('returns null for a corrupt record', () => {
    const dir = freshRuntimeDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, OWNER_FILE), '{not json');
    expect(readProjectOwner(dir)).toBeNull();
  });
});

describe('acquireProject', () => {
  const alwaysAlive = () => true;
  const neverAlive = () => false;
  // Realistic canonical start-times: UTC epoch-ms as decimal strings (what the
  // canonicalizers now emit), not opaque toy tokens.
  const OWNER_START = '1783107891272'; // the value recorded in owner.json (see writeOwner)
  const OTHER_START = '1783107999999'; // a different process instant
  // A start-time query that returns the owner's recorded value ⇒ still the real, live owner.
  const startMatches = () => OWNER_START;
  // A start-time query that returns a DIFFERENT value than the record ⇒ the pid was
  // recycled to an unrelated process ⇒ the recorded owner is dead.
  const startMismatch = () => OTHER_START;
  const startNever = () => null; // process gone / unqueryable

  it('claims a fresh project (owned, owner.json = our pid)', async () => {
    const dir = freshRuntimeDir();
    const r = await acquireProject('fresh', dir, {}, { queryStartTime: startMatches });
    expect(r.owned).toBe(true);
    expect(readProjectOwner(dir)?.pid).toBe(process.pid);
  });

  it('records our own OS start-time in the owner (the reuse guard)', async () => {
    const dir = freshRuntimeDir();
    await acquireProject('mystart', dir, {}, { queryStartTime: startMatches });
    expect(readProjectOwner(dir)?.startTime).toBe(OWNER_START);
  });

  it('defers to a live owner whose start-time MATCHES (handoff path)', async () => {
    const dir = freshRuntimeDir();
    writeOwner(dir, { pid: 999999, startTime: OWNER_START });
    const r = await acquireProject('live', dir, {}, { alive: alwaysAlive, queryStartTime: startMatches });
    expect(r.owned).toBe(false);
    expect(r.owner.pid).toBe(999999); // unchanged — we did not take over
    expect(readProjectOwner(dir)?.pid).toBe(999999);
  });

  it('takes over when the recorded PID is alive but start-time MISMATCHES (PID reuse)', async () => {
    // The crux: owner.json left by a hard-killed instance, its PID since recycled
    // to an unrelated live process. alive() is true, but the OS start-time differs.
    const dir = freshRuntimeDir();
    writeOwner(dir, { pid: 999999, startTime: OWNER_START });
    const r = await acquireProject('reused', dir, {}, { alive: alwaysAlive, queryStartTime: startMismatch });
    expect(r.owned).toBe(true);
    expect(readProjectOwner(dir)?.pid).toBe(process.pid); // we took over
  });

  it('DEFERS (does not take over) when the live start-time query returns null (transient-failure safety)', async () => {
    // pid is provably alive but the OS start-time query failed / timed out this time.
    // A false take-over here would reopen the duplicate window, so we must hand off.
    const dir = freshRuntimeDir();
    writeOwner(dir, { pid: 999999, startTime: OWNER_START });
    const r = await acquireProject('unqueryable', dir, {}, { alive: alwaysAlive, queryStartTime: startNever });
    expect(r.owned).toBe(false); // deferred to the live owner
    expect(readProjectOwner(dir)?.pid).toBe(999999); // record untouched
  });

  it('takes over a dead PID without querying its start-time', async () => {
    const dir = freshRuntimeDir();
    writeOwner(dir, { pid: 999999, startTime: OWNER_START });
    let queriedForExisting = false;
    const r = await acquireProject('stale', dir, {}, {
      alive: neverAlive,
      queryStartTime: (pid) => {
        if (pid === 999999) queriedForExisting = true;
        return OWNER_START;
      },
    });
    expect(r.owned).toBe(true);
    expect(queriedForExisting).toBe(false); // dead PID short-circuits — no start-time query for it
  });

  it('defers to a live legacy record with no recorded start-time (cannot disambiguate)', async () => {
    // A record written before startTime existed: nothing to compare, pid alive ⇒ defer.
    const dir = freshRuntimeDir();
    writeOwner(dir, { pid: 999999 }); // no startTime field
    const r = await acquireProject('legacy', dir, {}, { alive: alwaysAlive, queryStartTime: startNever });
    expect(r.owned).toBe(false);
  });

  it('re-claims its own prior record', async () => {
    const dir = freshRuntimeDir();
    writeOwner(dir, { pid: process.pid, startTime: OWNER_START });
    const r = await acquireProject('self', dir, {}, { alive: alwaysAlive, queryStartTime: startMatches });
    expect(r.owned).toBe(true); // our own pid is not a foreign live owner
  });

  it('records appVersion, host, channel id, and protocol in the owner', async () => {
    const dir = freshRuntimeDir();
    await acquireProject('meta', dir, { appVersion: '9.9.9' }, { queryStartTime: startMatches });
    const owner = readProjectOwner(dir);
    expect(owner?.appVersion).toBe('9.9.9');
    expect(owner?.host).toBe(os.hostname());
    expect(owner?.id).toBe(`${process.pid}-${owner?.startedAt}`); // channel name = pid-startedAt
    expect(owner?.protocol).toMatch(/^\d+\.\d+$/); // protocol version, separate from app version
  });

  it('queries the start-time of the EXISTING owner pid, not ours', async () => {
    const dir = freshRuntimeDir();
    writeOwner(dir, { pid: 999999, startedAt: 5, id: '999999-5', startTime: OWNER_START });
    const queried: number[] = [];
    await acquireProject('addr', dir, {}, {
      alive: alwaysAlive,
      queryStartTime: (pid) => {
        queried.push(pid);
        return OWNER_START;
      },
    });
    expect(queried).toContain(999999); // probed the recorded owner's pid
  });
});

describe('isProjectLive', () => {
  it('is false with no record', () => {
    expect(isProjectLive(freshRuntimeDir())).toBe(false);
  });
  it('reflects the injected liveness of the recorded pid (legacy record, no start-time)', () => {
    const dir = freshRuntimeDir();
    writeOwner(dir, { pid: 999999 }); // no startTime → falls back to pid-alive alone
    expect(isProjectLive(dir, () => true)).toBe(true);
    expect(isProjectLive(dir, () => false)).toBe(false);
  });
  it('requires the recorded start-time to still match (reuse guard)', () => {
    const dir = freshRuntimeDir();
    writeOwner(dir, { pid: 999999, startTime: '1783107891272' });
    expect(isProjectLive(dir, () => true, () => '1783107891272')).toBe(true); // alive + match
    expect(isProjectLive(dir, () => true, () => '1783107999999')).toBe(false); // alive but recycled pid
    expect(isProjectLive(dir, () => false, () => '1783107891272')).toBe(false); // pid dead
  });
  it('treats an unqueryable live pid as live (defers), not recycled', () => {
    // A record WITH a start-time whose live query returns null (failed/timed out):
    // the pid is alive, so we must NOT read it as a recycled/dead pid.
    const dir = freshRuntimeDir();
    writeOwner(dir, { pid: 999999, startTime: '1783107891272' });
    expect(isProjectLive(dir, () => true, () => null)).toBe(true);
  });
});

describe('queryProcessStartTime — output parsing (the only per-OS code)', () => {
  it('parses a wmic CreationDate block to canonical UTC epoch-ms', () => {
    // wmic prints a header line, then the WMI datetime (local wall-clock + offset), then blanks.
    const out = 'CreationDate\r\n20260703124451.272290-420\r\n\r\n';
    // 2026-07-03 12:44:51.272 local, offset -420 min (UTC-07:00) ⇒ 19:44:51.272 UTC.
    expect(parseWmicCreationDate(out)).toBe('1783107891272');
  });
  it('applies the UTC offset when canonicalizing wmic (offset changes the instant)', () => {
    // Same wall-clock, different offsets ⇒ different UTC instants.
    const utcZero = parseWmicCreationDate('20260703194451.272290+000');
    const minus420 = parseWmicCreationDate('20260703124451.272290-420');
    expect(utcZero).toBe('1783107891272'); // 19:44:51.272 at +00:00
    expect(minus420).toBe('1783107891272'); // 12:44:51.272 at -07:00 == same instant
  });
  it('returns null for wmic output with no datetime (process gone)', () => {
    expect(parseWmicCreationDate('CreationDate\r\n\r\n')).toBeNull();
    expect(parseWmicCreationDate('No Instance(s) Available.')).toBeNull();
  });
  it('parses a PowerShell ToFileTimeUtc value to canonical UTC epoch-ms', () => {
    // FileTime 134275814912722900 (100-ns ticks since 1601) ⇒ epoch-ms 1783107891272.
    expect(parseFileTimeUtc('134275814912722900\r\n')).toBe('1783107891272');
  });
  it('returns null for a non-numeric FileTime value', () => {
    expect(parseFileTimeUtc('')).toBeNull();
    expect(parseFileTimeUtc('not-a-number')).toBeNull();
  });

  // The two Windows query paths report the SAME process instant
  // in different encodings. Canonicalizing both to epoch-ms MUST make them equal,
  // else an owner claimed via wmic and re-queried via CIM (or vice-versa) reads as a
  // recycled pid ⇒ false take-over ⇒ duplicate window. This asserts they agree; it
  // FAILS against the old source-tagged impl (`wmi:…` !== `ft:…`) and passes now.
  it('canonicalizes wmic and FileTimeUtc of the SAME instant to the SAME value (cross-path)', () => {
    const viaWmic = parseWmicCreationDate('CreationDate\r\n20260703124451.272290-420\r\n');
    const viaFileTime = parseFileTimeUtc('134275814912722900');
    expect(viaWmic).not.toBeNull();
    expect(viaWmic).toBe(viaFileTime); // same instant ⇒ same canonical epoch-ms
  });

  it('parses a macOS ps lstart string to canonical UTC epoch-ms', () => {
    // Anchored to UTC via a "GMT" token so the test is timezone-independent.
    expect(parsePsLstart('Thu Jul  3 19:44:51 GMT 2026')).toBe('1783107891000');
    // ps pads to fixed width — the collapsed runs of spaces still parse the same.
    expect(parsePsLstart('Thu Jul 3 19:44:51 GMT 2026')).toBe('1783107891000');
  });
  it('returns null for an empty or unparseable lstart', () => {
    expect(parsePsLstart('   ')).toBeNull();
    expect(parsePsLstart('not a date')).toBeNull();
  });

  // Live smoke test: query THIS process's start-time. Guarded so CI on a platform
  // without the query command (or a locked-down box) skips instead of failing.
  it('returns a stable non-null start-time for the current process (smoke)', () => {
    const first = queryProcessStartTime(process.pid);
    if (first === null) {
      // Query command unavailable on this host — nothing to assert.
      console.warn('[test] queryProcessStartTime unavailable on this platform; skipping smoke assertions');
      return;
    }
    expect(first).not.toBe('');
    expect(queryProcessStartTime(process.pid)).toBe(first); // identical across two calls
  });
  it('returns null for a nonsense pid', () => {
    expect(queryProcessStartTime(-1)).toBeNull();
    expect(queryProcessStartTime(0)).toBeNull();
  });
});

describe('reassertOwner (re-assertion)', () => {
  it('recreates owner.json verbatim after an external delete', async () => {
    const dir = freshRuntimeDir();
    const claim = await acquireProject('reassert', dir, {}, {});
    const owner = claim.owner;

    fs.rmSync(path.join(dir, OWNER_FILE)); // external removal of the record
    expect(readProjectOwner(dir)).toBeNull();

    reassertOwner(dir, owner);
    const restored = readProjectOwner(dir);
    expect(restored?.id).toBe(owner.id); // SAME identity — senders addressing it still land
    expect(restored?.pid).toBe(owner.pid);
    expect(restored?.startedAt).toBe(owner.startedAt);
  });

  it('recreates the runtime dir if it was removed entirely', async () => {
    const dir = freshRuntimeDir();
    const claim = await acquireProject('reassert-dir', dir, {}, {});
    const owner = claim.owner;

    fs.rmSync(dir, { recursive: true, force: true }); // whole runtime dir gone
    expect(fs.existsSync(dir)).toBe(false);

    reassertOwner(dir, owner);
    expect(fs.existsSync(dir)).toBe(true);
    expect(readProjectOwner(dir)?.id).toBe(owner.id);
  });
});

describe('releaseProject (ownership guard, non-destructive)', () => {
  it('does NOT remove a runtime dir owned by another instance', () => {
    const dir = freshRuntimeDir();
    writeOwner(dir, { pid: 999999 }); // someone else owns it
    expect(releaseProject(dir)).toBe(false);
    expect(fs.existsSync(dir)).toBe(true);
  });
  it('removes the runtime dir when we own it', async () => {
    const dir = freshRuntimeDir();
    await acquireProject('mine', dir, {}, {});
    expect(releaseProject(dir)).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });
  it('removes ONLY runtime/, leaving the durable home (incl. project.json) intact', async () => {
    // The data-safety guarantee: release clears coordination state, never
    // durable data. Model the layout with a home containing project.json + runtime/.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'galley-home-'));
    roots.push(home);
    const runtimeDir = path.join(home, 'runtime');
    const recordPath = path.join(home, 'project.json');
    fs.writeFileSync(recordPath, JSON.stringify({ schemaVersion: 1, name: 'mine', createdAt: 1 }));
    await acquireProject('mine', runtimeDir, {}, {});

    expect(releaseProject(runtimeDir)).toBe(true);
    expect(fs.existsSync(runtimeDir)).toBe(false); // runtime gone
    expect(fs.existsSync(home)).toBe(true); // home preserved
    expect(fs.existsSync(recordPath)).toBe(true); // project.json preserved
  });
});

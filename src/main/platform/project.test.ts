import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  isProcessAlive,
  readProjectOwner,
  isProjectLive,
  acquireProject,
  releaseProject,
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
  const pingTrue = async () => true; // a live owner acks the handshake
  const pingFalse = async () => false; // nothing is consuming the channel
  const alwaysAlive = () => true;
  const neverAlive = () => false;

  it('claims a fresh project (owned, owner.json = our pid)', async () => {
    const dir = freshRuntimeDir();
    const r = await acquireProject('fresh', dir, {}, { ping: pingTrue });
    expect(r.owned).toBe(true);
    expect(readProjectOwner(dir)?.pid).toBe(process.pid);
  });

  it('defers to a live owner that acks the handshake (handoff path)', async () => {
    const dir = freshRuntimeDir();
    writeOwner(dir, { pid: 999999 });
    const r = await acquireProject('live', dir, {}, { ping: pingTrue, alive: alwaysAlive });
    expect(r.owned).toBe(false);
    expect(r.owner.pid).toBe(999999); // unchanged — we did not take over
    expect(readProjectOwner(dir)?.pid).toBe(999999);
  });

  it('takes over when the recorded PID is alive but NOT consuming (PID reuse)', async () => {
    // The crux: owner.json left by a hard-killed instance, its PID since recycled
    // to an unrelated live process. alive() is true, but the handshake fails.
    const dir = freshRuntimeDir();
    writeOwner(dir, { pid: 999999 });
    const r = await acquireProject('reused', dir, {}, { ping: pingFalse, alive: alwaysAlive });
    expect(r.owned).toBe(true);
    expect(readProjectOwner(dir)?.pid).toBe(process.pid); // we took over
  });

  it('takes over a dead PID without bothering to handshake', async () => {
    const dir = freshRuntimeDir();
    writeOwner(dir, { pid: 999999 });
    let pinged = false;
    const r = await acquireProject('stale', dir, {}, { ping: async () => ((pinged = true), true), alive: neverAlive });
    expect(r.owned).toBe(true);
    expect(pinged).toBe(false); // dead PID short-circuits — no handshake needed
  });

  it('re-claims its own prior record', async () => {
    const dir = freshRuntimeDir();
    writeOwner(dir, { pid: process.pid });
    const r = await acquireProject('self', dir, {}, { ping: pingTrue, alive: alwaysAlive });
    expect(r.owned).toBe(true); // our own pid is not a foreign live owner
  });

  it('records appVersion, host, channel id, and protocol in the owner', async () => {
    const dir = freshRuntimeDir();
    await acquireProject('meta', dir, { appVersion: '9.9.9' }, { ping: pingTrue });
    const owner = readProjectOwner(dir);
    expect(owner?.appVersion).toBe('9.9.9');
    expect(owner?.host).toBe(os.hostname());
    expect(owner?.id).toBe(`${process.pid}-${owner?.startedAt}`); // channel name = pid-startedAt
    expect(owner?.protocol).toMatch(/^\d+\.\d+$/); // protocol version, separate from app version
  });

  it('addresses the handshake to the existing owner id', async () => {
    const dir = freshRuntimeDir();
    writeOwner(dir, { pid: 999999, startedAt: 5, id: '999999-5' });
    let pingedId: string | undefined;
    await acquireProject(
      'addr',
      dir,
      {},
      { ping: async (id) => ((pingedId = id), true), alive: alwaysAlive },
    );
    expect(pingedId).toBe('999999-5'); // probed the recorded owner's channel, not ours
  });
});

describe('isProjectLive', () => {
  it('is false with no record', () => {
    expect(isProjectLive(freshRuntimeDir())).toBe(false);
  });
  it('reflects the injected liveness of the recorded pid', () => {
    const dir = freshRuntimeDir();
    writeOwner(dir, { pid: 999999 });
    expect(isProjectLive(dir, () => true)).toBe(true);
    expect(isProjectLive(dir, () => false)).toBe(false);
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
    await acquireProject('mine', dir, {}, { ping: async () => true });
    expect(releaseProject(dir)).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });
  it('removes ONLY runtime/, leaving the durable home (incl. project.json) intact', async () => {
    // The #60 data-safety guarantee: release clears coordination state, never
    // durable data. Model the layout with a home containing project.json + runtime/.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'galley-home-'));
    roots.push(home);
    const runtimeDir = path.join(home, 'runtime');
    const recordPath = path.join(home, 'project.json');
    fs.writeFileSync(recordPath, JSON.stringify({ schemaVersion: 1, name: 'mine', createdAt: 1 }));
    await acquireProject('mine', runtimeDir, {}, { ping: async () => true });

    expect(releaseProject(runtimeDir)).toBe(true);
    expect(fs.existsSync(runtimeDir)).toBe(false); // runtime gone
    expect(fs.existsSync(home)).toBe(true); // home preserved
    expect(fs.existsSync(recordPath)).toBe(true); // project.json preserved
  });
});

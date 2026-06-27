import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  projectDir,
  isProcessAlive,
  readProjectOwner,
  isProjectLive,
  acquireProject,
  releaseProject,
  OWNER_FILE,
  type ProjectOwner,
} from './project';

// Each test uses a unique project name so the real temp-dir scratch dirs never
// collide; we remove them afterwards. Names are restricted to the sanitized
// charset projectDir() accepts.
let seq = 0;
const made: string[] = [];
function freshName(tag: string): string {
  const name = `vt-${tag}-${process.pid}-${seq++}`;
  made.push(name);
  return name;
}
function writeOwner(name: string, owner: Partial<ProjectOwner>): void {
  const dir = projectDir(name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, OWNER_FILE), JSON.stringify({ host: os.hostname(), ...owner }));
}
afterEach(() => {
  for (const name of made.splice(0)) fs.rmSync(projectDir(name), { recursive: true, force: true });
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

describe('projectDir (sanitization)', () => {
  it('maps a safe name to a temp-dir scratch path', () => {
    expect(projectDir('proj_1-a.b')).toBe(path.join(os.tmpdir(), 'mdtool-proj_1-a.b'));
  });
  it('rejects path traversal and separators', () => {
    expect(() => projectDir('../evil')).toThrow();
    expect(() => projectDir('a/b')).toThrow();
    expect(() => projectDir('a\\b')).toThrow();
    expect(() => projectDir('..')).toThrow();
    expect(() => projectDir('.')).toThrow();
    expect(() => projectDir('')).toThrow();
  });
});

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
    expect(readProjectOwner(freshName('noowner'))).toBeNull();
  });
  it('reads back a written record', () => {
    const name = freshName('read');
    writeOwner(name, { pid: 4242, project: name });
    expect(readProjectOwner(name)?.pid).toBe(4242);
  });
  it('returns null for a corrupt record', () => {
    const name = freshName('corrupt');
    fs.mkdirSync(projectDir(name), { recursive: true });
    fs.writeFileSync(path.join(projectDir(name), OWNER_FILE), '{not json');
    expect(readProjectOwner(name)).toBeNull();
  });
});

describe('acquireProject', () => {
  const pingTrue = async () => true; // a live owner acks the handshake
  const pingFalse = async () => false; // nothing is consuming the channel
  const alwaysAlive = () => true;
  const neverAlive = () => false;

  it('claims a fresh project (owned, owner.json = our pid)', async () => {
    const name = freshName('fresh');
    const r = await acquireProject(name, {}, { ping: pingTrue });
    expect(r.owned).toBe(true);
    expect(readProjectOwner(name)?.pid).toBe(process.pid);
  });

  it('defers to a live owner that acks the handshake (handoff path)', async () => {
    const name = freshName('live');
    writeOwner(name, { pid: 999999, project: name });
    const r = await acquireProject(name, {}, { ping: pingTrue, alive: alwaysAlive });
    expect(r.owned).toBe(false);
    expect(r.owner.pid).toBe(999999); // unchanged — we did not take over
    expect(readProjectOwner(name)?.pid).toBe(999999);
  });

  it('takes over when the recorded PID is alive but NOT consuming (PID reuse)', async () => {
    // The crux: owner.json left by a hard-killed instance, its PID since recycled
    // to an unrelated live process. alive() is true, but the handshake fails.
    const name = freshName('reused');
    writeOwner(name, { pid: 999999, project: name });
    const r = await acquireProject(name, {}, { ping: pingFalse, alive: alwaysAlive });
    expect(r.owned).toBe(true);
    expect(readProjectOwner(name)?.pid).toBe(process.pid); // we took over
  });

  it('takes over a dead PID without bothering to handshake', async () => {
    const name = freshName('stale');
    writeOwner(name, { pid: 999999, project: name });
    let pinged = false;
    const r = await acquireProject(name, {}, { ping: async () => ((pinged = true), true), alive: neverAlive });
    expect(r.owned).toBe(true);
    expect(pinged).toBe(false); // dead PID short-circuits — no handshake needed
  });

  it('re-claims its own prior record', async () => {
    const name = freshName('self');
    writeOwner(name, { pid: process.pid, project: name });
    const r = await acquireProject(name, {}, { ping: pingTrue, alive: alwaysAlive });
    expect(r.owned).toBe(true); // our own pid is not a foreign live owner
  });

  it('records appVersion + host in the owner', async () => {
    const name = freshName('meta');
    await acquireProject(name, { appVersion: '9.9.9' }, { ping: pingTrue });
    const owner = readProjectOwner(name);
    expect(owner?.appVersion).toBe('9.9.9');
    expect(owner?.host).toBe(os.hostname());
  });
});

describe('isProjectLive', () => {
  it('is false with no record', () => {
    expect(isProjectLive(freshName('dead'))).toBe(false);
  });
  it('reflects the injected liveness of the recorded pid', () => {
    const name = freshName('livecheck');
    writeOwner(name, { pid: 999999, project: name });
    expect(isProjectLive(name, () => true)).toBe(true);
    expect(isProjectLive(name, () => false)).toBe(false);
  });
});

describe('releaseProject (ownership guard)', () => {
  it('does NOT remove a directory owned by another instance', () => {
    const name = freshName('foreign');
    writeOwner(name, { pid: 999999, project: name }); // someone else owns it
    expect(releaseProject(name)).toBe(false);
    expect(fs.existsSync(projectDir(name))).toBe(true);
  });
  it('removes the directory when we own it', async () => {
    const name = freshName('mine');
    await acquireProject(name, {}, { ping: async () => true });
    expect(releaseProject(name)).toBe(true);
    expect(fs.existsSync(projectDir(name))).toBe(false);
  });
});

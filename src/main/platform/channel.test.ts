import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sendToChannel, listenOnChannel, pingChannel, type ChannelListener } from './channel';
import { projectDir } from './project';

// The channel transport (R11–R15) over the file-drop directory: a caller writes
// a command file holding an absolute path; the watcher reads each and hands it
// to onFile. Replaces the old Unix-socket / named-pipe round-trip.

let seq = 0;
const made: string[] = [];
const open: ChannelListener[] = [];
function freshName(tag: string): string {
  const name = `vt-ch-${tag}-${process.pid}-${seq++}`;
  made.push(name);
  return name;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function listen(name: string, onFile: (p: string) => void): Promise<ChannelListener> {
  const l = listenOnChannel(name, onFile);
  open.push(l);
  await sleep(120); // let the polling watcher settle before drops
  return l;
}
async function waitFor(fn: () => boolean, ms = 3000, step = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(step);
  }
  return false;
}
function openCount(name: string): number {
  return fs.readdirSync(projectDir(name)).filter((n) => n.endsWith('.open')).length;
}
afterEach(async () => {
  for (const l of open.splice(0)) await l.close();
  for (const name of made.splice(0)) fs.rmSync(projectDir(name), { recursive: true, force: true });
});

describe('channel file-drop transport (R11–R15)', () => {
  it('delivers a dropped path and deletes the command file', async () => {
    const name = freshName('rt');
    const got: string[] = [];
    await listen(name, (p) => got.push(p));

    sendToChannel(name, 'C:\\docs\\a.md');

    expect(await waitFor(() => got.length === 1)).toBe(true);
    expect(got[0]).toBe('C:\\docs\\a.md');
    expect(await waitFor(() => openCount(name) === 0)).toBe(true);
  });

  it('delivers a burst of drops with no loss or duplication', async () => {
    const name = freshName('burst');
    const got: string[] = [];
    await listen(name, (p) => got.push(p));

    const sent = Array.from({ length: 12 }, (_, i) => `C:\\f${i}.md`);
    for (const p of sent) sendToChannel(name, p);

    expect(await waitFor(() => got.length === sent.length, 6000)).toBe(true);
    expect(new Set(got)).toEqual(new Set(sent));
    expect(await waitFor(() => openCount(name) === 0, 6000)).toBe(true);
  });

  it('reconciles commands dropped before the watcher attaches', async () => {
    const name = freshName('reconcile');
    fs.mkdirSync(projectDir(name), { recursive: true });
    sendToChannel(name, 'C:\\pre1.md');
    sendToChannel(name, 'C:\\pre2.md');

    const got: string[] = [];
    await listen(name, (p) => got.push(p));

    expect(await waitFor(() => got.length === 2)).toBe(true);
    expect(new Set(got)).toEqual(new Set(['C:\\pre1.md', 'C:\\pre2.md']));
  });

  it('ignores non-command files in the directory (e.g. owner.json)', async () => {
    const name = freshName('ignore');
    const dir = projectDir(name);
    fs.mkdirSync(dir, { recursive: true });
    const got: string[] = [];
    await listen(name, (p) => got.push(p));

    fs.writeFileSync(path.join(dir, 'owner.json'), '{"pid":1}');
    fs.writeFileSync(path.join(dir, 'note.txt'), 'C:\\notacommand.md');
    sendToChannel(name, 'C:\\real.md');

    expect(await waitFor(() => got.length === 1)).toBe(true);
    expect(got).toEqual(['C:\\real.md']); // the non-.open files never delivered
  });
});

describe('channel liveness handshake (PID-reuse defence)', () => {
  it('a listening owner acknowledges a ping', async () => {
    const name = freshName('ping-live');
    await listen(name, () => {
      /* file delivery isn't what these handshake tests exercise */
    });
    expect(await pingChannel(name)).toBe(true);
  });

  it('an unconsumed channel does not ack (times out false)', async () => {
    const name = freshName('ping-dead');
    // No listener attached — mimics a stale owner.json whose PID was recycled.
    expect(await pingChannel(name, { timeoutMs: 400, intervalMs: 25 })).toBe(false);
  });

  it('leaves no ping/pong files behind after a handshake', async () => {
    const name = freshName('ping-clean');
    await listen(name, () => {
      /* file delivery isn't what these handshake tests exercise */
    });
    await pingChannel(name);
    const leftovers = fs.readdirSync(projectDir(name)).filter((n) => n.endsWith('.ping') || n.endsWith('.pong'));
    expect(leftovers).toEqual([]);
  });
});

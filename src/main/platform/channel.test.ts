import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sendToChannel, listenOnChannel, pingChannel, type ChannelListener } from './channel';
import { projectDir } from './project';
import { PROTOCOL_VERSION, PROTOCOL } from './protocol';

// The channel transport (R11–R15): a launching peer writes a message file
// addressed to the owning instance's channel id; the owner reads each, version-
// checks it, and dispatches. Filenames carry the channel id, so a message only
// ever reaches its intended owner.

let seq = 0;
const made: string[] = [];
const open: ChannelListener[] = [];
function freshName(tag: string): string {
  const name = `vt-ch-${tag}-${process.pid}-${seq++}`;
  made.push(name);
  return name;
}
const ID = 'own-1'; // this window's channel id in these tests
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function listen(name: string, id: string, onFile: (p: string) => void): Promise<ChannelListener> {
  const l = listenOnChannel(name, id, onFile);
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
function msgCount(name: string): number {
  return fs.readdirSync(projectDir(name)).filter((n) => n.endsWith('.msg')).length;
}
/** Drop a raw envelope (atomic appear) addressed to `id`, to exercise the parser. */
function dropRaw(name: string, id: string, envelope: unknown): void {
  const dir = projectDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${id}.raw-${seq++}`);
  fs.writeFileSync(base + '.tmp', JSON.stringify(envelope));
  fs.renameSync(base + '.tmp', base + '.msg');
}
afterEach(async () => {
  for (const l of open.splice(0)) await l.close();
  for (const name of made.splice(0)) fs.rmSync(projectDir(name), { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('channel file-drop transport (R11–R15)', () => {
  it('delivers an open message and deletes it', async () => {
    const name = freshName('rt');
    const got: string[] = [];
    await listen(name, ID, (p) => got.push(p));

    sendToChannel(name, ID, 'C:\\docs\\a.md');

    expect(await waitFor(() => got.length === 1)).toBe(true);
    expect(got[0]).toBe('C:\\docs\\a.md');
    expect(await waitFor(() => msgCount(name) === 0)).toBe(true);
  });

  it('delivers a burst with no loss or duplication', async () => {
    const name = freshName('burst');
    const got: string[] = [];
    await listen(name, ID, (p) => got.push(p));

    const sent = Array.from({ length: 12 }, (_, i) => `C:\\f${i}.md`);
    for (const p of sent) sendToChannel(name, ID, p);

    expect(await waitFor(() => got.length === sent.length, 6000)).toBe(true);
    expect(new Set(got)).toEqual(new Set(sent));
    expect(await waitFor(() => msgCount(name) === 0, 6000)).toBe(true);
  });

  it('reconciles messages dropped before the watcher attaches', async () => {
    const name = freshName('reconcile');
    sendToChannel(name, ID, 'C:\\pre1.md');
    sendToChannel(name, ID, 'C:\\pre2.md');

    const got: string[] = [];
    await listen(name, ID, (p) => got.push(p));

    expect(await waitFor(() => got.length === 2)).toBe(true);
    expect(new Set(got)).toEqual(new Set(['C:\\pre1.md', 'C:\\pre2.md']));
  });

  it('only consumes messages addressed to its own channel id', async () => {
    const name = freshName('addr');
    const got: string[] = [];
    await listen(name, ID, (p) => got.push(p));

    sendToChannel(name, 'someone-else', 'C:\\other.md'); // a different owner's message
    sendToChannel(name, ID, 'C:\\mine.md');

    expect(await waitFor(() => got.length === 1)).toBe(true);
    expect(got).toEqual(['C:\\mine.md']);
    // the foreign message is left untouched for its owner
    expect(fs.readdirSync(projectDir(name)).some((n) => n.startsWith('someone-else.'))).toBe(true);
  });
});

describe('channel message format (versioned envelope)', () => {
  it('tolerates unknown extra fields, defaults nothing it does not need', async () => {
    const name = freshName('extra');
    const got: string[] = [];
    await listen(name, ID, (p) => got.push(p));
    dropRaw(name, ID, { v: PROTOCOL_VERSION, type: 'open', path: 'C:\\x.md', future: { a: 1 } });
    expect(await waitFor(() => got.length === 1)).toBe(true);
    expect(got[0]).toBe('C:\\x.md');
  });

  it('skips an unknown message type (forward-compat), without delivering', async () => {
    const name = freshName('unktype');
    const got: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {
      /* silence the expected diagnostic log */
    });
    await listen(name, ID, (p) => got.push(p));
    dropRaw(name, ID, { v: PROTOCOL_VERSION, type: 'frobnicate', path: 'C:\\x.md' });
    sendToChannel(name, ID, 'C:\\real.md'); // a known message after it
    expect(await waitFor(() => got.length === 1)).toBe(true);
    expect(got).toEqual(['C:\\real.md']); // the unknown type never delivered
  });

  it('surfaces (does not silently drop) an incompatible-major message', async () => {
    const name = freshName('badmajor');
    const got: string[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {
      /* silence the expected diagnostic log */
    });
    await listen(name, ID, (p) => got.push(p));
    dropRaw(name, ID, { v: `${PROTOCOL.major + 1}.0`, type: 'open', path: 'C:\\x.md' });
    sendToChannel(name, ID, 'C:\\real.md');
    expect(await waitFor(() => got.length === 1)).toBe(true);
    expect(got).toEqual(['C:\\real.md']); // incompatible message not delivered
    expect(err).toHaveBeenCalled(); // but surfaced, not silent
  });

  it('does not deliver an open message with no path', async () => {
    const name = freshName('nopath');
    const got: string[] = [];
    await listen(name, ID, (p) => got.push(p));
    dropRaw(name, ID, { v: PROTOCOL_VERSION, type: 'open' });
    sendToChannel(name, ID, 'C:\\real.md');
    expect(await waitFor(() => got.length === 1)).toBe(true);
    expect(got).toEqual(['C:\\real.md']);
  });
});

describe('stale-file reaping (orphans swept; own queued messages preserved)', () => {
  // Backdate a file's mtime well past STALE_MS (10s) so reapStale treats it as an orphan.
  function backdate(file: string): void {
    const t = new Date(Date.now() - 60_000);
    fs.utimesSync(file, t, t);
  }
  function writeMsg(name: string, fileName: string, path_: string): string {
    const p = path.join(projectDir(name), fileName);
    fs.mkdirSync(projectDir(name), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ v: PROTOCOL_VERSION, type: 'open', path: path_ }));
    return p;
  }

  it('sweeps a stale message addressed to a now-dead owner, without delivering it', async () => {
    const name = freshName('reap-orphan');
    const orphan = writeMsg(name, 'deadowner-1.x.msg', 'C:\\orphan.md'); // a different owner's id
    backdate(orphan);
    const got: string[] = [];
    await listen(name, ID, (p) => got.push(p));
    expect(fs.existsSync(orphan)).toBe(false); // reaped (not ours, past TTL)
    expect(got).toEqual([]); // never delivered to us
  });

  it('delivers our OWN queued message even when old (reconcile runs before reap)', async () => {
    const name = freshName('reap-mine');
    const mineMsg = writeMsg(name, `${ID}.old.msg`, 'C:\\mine.md');
    backdate(mineMsg); // old, but addressed to us
    const got: string[] = [];
    await listen(name, ID, (p) => got.push(p));
    expect(got).toEqual(['C:\\mine.md']); // consumed in reconcile, not swept
    expect(fs.existsSync(mineMsg)).toBe(false); // consumed (deleted), not lingering
  });

  it('leaves a FRESH foreign message for its own owner', async () => {
    const name = freshName('reap-fresh');
    const fresh = writeMsg(name, 'other-9.y.msg', 'C:\\fresh.md'); // not backdated
    await listen(name, ID, () => {
      /* delivery not exercised here */
    });
    expect(fs.existsSync(fresh)).toBe(true); // within TTL → left for its owner
  });
});

describe('channel liveness handshake (PID-reuse defence)', () => {
  it('a listening owner acknowledges a ping addressed to it', async () => {
    const name = freshName('ping-live');
    await listen(name, ID, () => {
      /* delivery not exercised here */
    });
    expect(await pingChannel(name, ID)).toBe(true);
  });

  it('an owner ignores a ping addressed to a different id (times out false)', async () => {
    const name = freshName('ping-addr');
    await listen(name, ID, () => {
      /* delivery not exercised here */
    });
    // Probe a different channel id — our owner must not answer for someone else.
    expect(await pingChannel(name, 'not-me', { timeoutMs: 400, intervalMs: 25 })).toBe(false);
  });

  it('an unconsumed channel does not ack (times out false)', async () => {
    const name = freshName('ping-dead');
    expect(await pingChannel(name, ID, { timeoutMs: 400, intervalMs: 25 })).toBe(false);
  });

  it('leaves no ping/pong files behind after a handshake', async () => {
    const name = freshName('ping-clean');
    await listen(name, ID, () => {
      /* delivery not exercised here */
    });
    await pingChannel(name, ID);
    const leftovers = fs.readdirSync(projectDir(name)).filter((n) => n.endsWith('.ping') || n.endsWith('.pong'));
    expect(leftovers).toEqual([]);
  });
});

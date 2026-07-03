import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendToChannel, listenOnChannel, pingChannel, type ChannelListener } from './channel';
import { PROTOCOL_VERSION, PROTOCOL } from './protocol';

// The channel transport (§7, §8.1): a launching peer writes a message file
// addressed to the owning instance's channel id into the project's `runtime/`
// dir; the owner reads each, version-checks it, and dispatches. Filenames carry
// the channel id, so a message only ever reaches its intended owner. Tests inject
// a hermetic temp `runtime/` dir under os.tmpdir() and clean it up.

let seq = 0;
const roots: string[] = [];
const open: ChannelListener[] = [];
function freshRuntimeDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'galley-ch-'));
  roots.push(root);
  return path.join(root, 'runtime');
}
const ID = 'own-1'; // this window's channel id in these tests
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function listen(dir: string, id: string, onFile: (p: string) => void): Promise<ChannelListener> {
  const l = listenOnChannel(dir, id, onFile);
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
function msgCount(dir: string): number {
  return fs.readdirSync(dir).filter((n) => n.endsWith('.msg')).length;
}
/** Drop a raw envelope (atomic appear) addressed to `id`, to exercise the parser. */
function dropRaw(dir: string, id: string, envelope: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${id}.raw-${seq++}`);
  fs.writeFileSync(base + '.tmp', JSON.stringify(envelope));
  fs.renameSync(base + '.tmp', base + '.msg');
}
afterEach(async () => {
  for (const l of open.splice(0)) await l.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('channel file-drop transport (§7, §8.1)', () => {
  it('delivers an open message and deletes it', async () => {
    const dir = freshRuntimeDir();
    const got: string[] = [];
    await listen(dir, ID, (p) => got.push(p));

    sendToChannel(dir, ID, 'C:\\docs\\a.md');

    expect(await waitFor(() => got.length === 1)).toBe(true);
    expect(got[0]).toBe('C:\\docs\\a.md');
    expect(await waitFor(() => msgCount(dir) === 0)).toBe(true);
  });

  it('delivers a burst with no loss or duplication', async () => {
    const dir = freshRuntimeDir();
    const got: string[] = [];
    await listen(dir, ID, (p) => got.push(p));

    const sent = Array.from({ length: 12 }, (_, i) => `C:\\f${i}.md`);
    for (const p of sent) sendToChannel(dir, ID, p);

    expect(await waitFor(() => got.length === sent.length, 6000)).toBe(true);
    expect(new Set(got)).toEqual(new Set(sent));
    expect(await waitFor(() => msgCount(dir) === 0, 6000)).toBe(true);
  });

  it('reconciles messages dropped before the watcher attaches', async () => {
    const dir = freshRuntimeDir();
    sendToChannel(dir, ID, 'C:\\pre1.md');
    sendToChannel(dir, ID, 'C:\\pre2.md');

    const got: string[] = [];
    await listen(dir, ID, (p) => got.push(p));

    expect(await waitFor(() => got.length === 2)).toBe(true);
    expect(new Set(got)).toEqual(new Set(['C:\\pre1.md', 'C:\\pre2.md']));
  });

  it('only consumes messages addressed to its own channel id', async () => {
    const dir = freshRuntimeDir();
    const got: string[] = [];
    await listen(dir, ID, (p) => got.push(p));

    sendToChannel(dir, 'someone-else', 'C:\\other.md'); // a different owner's message
    sendToChannel(dir, ID, 'C:\\mine.md');

    expect(await waitFor(() => got.length === 1)).toBe(true);
    expect(got).toEqual(['C:\\mine.md']);
    // the foreign message is left untouched for its owner
    expect(fs.readdirSync(dir).some((n) => n.startsWith('someone-else.'))).toBe(true);
  });
});

describe('channel message format (versioned envelope)', () => {
  it('tolerates unknown extra fields, defaults nothing it does not need', async () => {
    const dir = freshRuntimeDir();
    const got: string[] = [];
    await listen(dir, ID, (p) => got.push(p));
    dropRaw(dir, ID, { v: PROTOCOL_VERSION, type: 'open', path: 'C:\\x.md', future: { a: 1 } });
    expect(await waitFor(() => got.length === 1)).toBe(true);
    expect(got[0]).toBe('C:\\x.md');
  });

  it('skips an unknown message type (forward-compat), without delivering', async () => {
    const dir = freshRuntimeDir();
    const got: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {
      /* silence the expected diagnostic log */
    });
    await listen(dir, ID, (p) => got.push(p));
    dropRaw(dir, ID, { v: PROTOCOL_VERSION, type: 'frobnicate', path: 'C:\\x.md' });
    sendToChannel(dir, ID, 'C:\\real.md'); // a known message after it
    expect(await waitFor(() => got.length === 1)).toBe(true);
    expect(got).toEqual(['C:\\real.md']); // the unknown type never delivered
  });

  it('surfaces (does not silently drop) an incompatible-major message', async () => {
    const dir = freshRuntimeDir();
    const got: string[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {
      /* silence the expected diagnostic log */
    });
    await listen(dir, ID, (p) => got.push(p));
    dropRaw(dir, ID, { v: `${PROTOCOL.major + 1}.0`, type: 'open', path: 'C:\\x.md' });
    sendToChannel(dir, ID, 'C:\\real.md');
    expect(await waitFor(() => got.length === 1)).toBe(true);
    expect(got).toEqual(['C:\\real.md']); // incompatible message not delivered
    expect(err).toHaveBeenCalled(); // but surfaced, not silent
  });

  it('does not deliver an open message with no path', async () => {
    const dir = freshRuntimeDir();
    const got: string[] = [];
    await listen(dir, ID, (p) => got.push(p));
    dropRaw(dir, ID, { v: PROTOCOL_VERSION, type: 'open' });
    sendToChannel(dir, ID, 'C:\\real.md');
    expect(await waitFor(() => got.length === 1)).toBe(true);
    expect(got).toEqual(['C:\\real.md']);
  });
});

describe('channel liveness handshake (PID-reuse defence)', () => {
  it('a listening owner acknowledges a ping addressed to it', async () => {
    const dir = freshRuntimeDir();
    await listen(dir, ID, () => {
      /* delivery not exercised here */
    });
    expect(await pingChannel(dir, ID)).toBe(true);
  });

  it('an owner ignores a ping addressed to a different id (times out false)', async () => {
    const dir = freshRuntimeDir();
    await listen(dir, ID, () => {
      /* delivery not exercised here */
    });
    // Probe a different channel id — our owner must not answer for someone else.
    expect(await pingChannel(dir, 'not-me', { timeoutMs: 400, intervalMs: 25 })).toBe(false);
  });

  it('an unconsumed channel does not ack (times out false)', async () => {
    const dir = freshRuntimeDir();
    expect(await pingChannel(dir, ID, { timeoutMs: 400, intervalMs: 25 })).toBe(false);
  });

  it('leaves no ping/pong files behind after a handshake', async () => {
    const dir = freshRuntimeDir();
    await listen(dir, ID, () => {
      /* delivery not exercised here */
    });
    await pingChannel(dir, ID);
    const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.ping') || n.endsWith('.pong'));
    expect(leftovers).toEqual([]);
  });
});

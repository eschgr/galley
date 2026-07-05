import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendToChannel, listenOnChannel, type ChannelListener } from './channel';
import { acquireProject, reassertOwner, readProjectOwner, OWNER_FILE, type ProjectOwner } from './project';
import { PROTOCOL_VERSION, PROTOCOL } from './protocol';

// The channel transport: a launching peer writes a message file
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

describe('channel file-drop transport', () => {
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

describe('channel open-at-line (optional envelope line field)', () => {
  // A helper that captures both the path AND the line each delivery carries.
  const listenPairs = async (dir: string, got: { path: string; line?: number }[]) => {
    const l = listenOnChannel(dir, ID, (path, line) => got.push({ path, line }));
    open.push(l);
    await sleep(120);
    return l;
  };

  it('round-trips an optional line from send to delivery', async () => {
    const dir = freshRuntimeDir();
    const got: { path: string; line?: number }[] = [];
    await listenPairs(dir, got);

    sendToChannel(dir, ID, 'C:\\docs\\a.md', 120);

    expect(await waitFor(() => got.length === 1)).toBe(true);
    expect(got[0]).toEqual({ path: 'C:\\docs\\a.md', line: 120 });
  });

  it('omits the line field entirely when none is given (back-compat: opens at top)', async () => {
    const dir = freshRuntimeDir();
    // Inspect the raw envelope the sender writes — no `line` key at all.
    fs.mkdirSync(dir, { recursive: true });
    sendToChannel(dir, ID, 'C:\\docs\\a.md');
    const msg = fs.readdirSync(dir).find((n) => n.endsWith('.msg'))!;
    const env = JSON.parse(fs.readFileSync(path.join(dir, msg), 'utf8'));
    expect(env).not.toHaveProperty('line');
  });

  it('delivers undefined line for an envelope without one (old sender → new owner)', async () => {
    const dir = freshRuntimeDir();
    const got: { path: string; line?: number }[] = [];
    await listenPairs(dir, got);

    dropRaw(dir, ID, { v: PROTOCOL_VERSION, type: 'open', path: 'C:\\x.md' });

    expect(await waitFor(() => got.length === 1)).toBe(true);
    expect(got[0]).toEqual({ path: 'C:\\x.md', line: undefined });
  });

  it('ignores a malformed line (non-integer / < 1), opening at the top', async () => {
    const dir = freshRuntimeDir();
    const got: { path: string; line?: number }[] = [];
    await listenPairs(dir, got);

    dropRaw(dir, ID, { v: PROTOCOL_VERSION, type: 'open', path: 'C:\\a.md', line: 0 });
    dropRaw(dir, ID, { v: PROTOCOL_VERSION, type: 'open', path: 'C:\\b.md', line: 'nope' });
    dropRaw(dir, ID, { v: PROTOCOL_VERSION, type: 'open', path: 'C:\\c.md', line: 2.5 });

    expect(await waitFor(() => got.length === 3)).toBe(true);
    expect(got.every((g) => g.line === undefined)).toBe(true);
  });
});

// Re-assertion on external removal (defense-in-depth). A live
// owner whose runtime/ or owner.json is deleted out from under it must recreate the
// discoverable artifacts with the SAME identity, so a later launch's acquireProject
// finds the live owner and hands off instead of duplicating. The bridge wires
// `onReassert` to project.ts#reassertOwner (+ project.json re-materialization); the
// tests here mirror that wiring directly.
describe('channel re-assertion on external removal', () => {
  /** A home dir with a project.json + runtime/ layout (mirrors projectStore). */
  function freshHome(): { home: string; runtimeDir: string; recordPath: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'galley-home-'));
    roots.push(home);
    return { home, runtimeDir: path.join(home, 'runtime'), recordPath: path.join(home, 'project.json') };
  }
  const noop = (): void => {
    /* delivery not exercised */
  };
  /** Listen with `onReassert` wired to reassertOwner (as the bridge does); count fires. */
  async function listenOwned(
    dir: string,
    owner: ProjectOwner,
    onFile: (p: string) => void = noop,
    onProjectJson?: () => void,
  ): Promise<{ listener: ChannelListener; reasserts: () => number }> {
    let count = 0;
    const l = listenOnChannel(dir, owner.id, onFile, {
      onReassert: () => {
        count++;
        reassertOwner(dir, owner);
        onProjectJson?.();
      },
    });
    open.push(l);
    await sleep(120);
    return { listener: l, reasserts: () => count };
  }

  it('recreates owner.json with the SAME id when it is removed under a listener', async () => {
    const { runtimeDir } = freshHome();
    const claim = await acquireProject('reassert-owner', runtimeDir, {}, {});
    const owner = claim.owner;
    const { reasserts } = await listenOwned(runtimeDir, owner);

    fs.unlinkSync(path.join(runtimeDir, OWNER_FILE)); // external delete of just owner.json

    expect(await waitFor(() => reasserts() >= 1)).toBe(true);
    expect(fs.existsSync(runtimeDir)).toBe(true);
    expect(readProjectOwner(runtimeDir)?.id).toBe(owner.id); // same identity restored
  });

  it('recreates runtimeDir + owner.json (same id) and re-materializes project.json when the whole home is removed', async () => {
    const { home, runtimeDir, recordPath } = freshHome();
    const claim = await acquireProject('reassert-home', runtimeDir, {}, {});
    const owner = claim.owner;
    fs.writeFileSync(recordPath, JSON.stringify({ schemaVersion: 1, name: 'reassert-home', createdAt: 1 }));

    const { reasserts } = await listenOwned(runtimeDir, owner, noop, () => {
      // stand-in for the bridge's materializeProjectRecord: recreate project.json
      // only if the home was nuked (absence is the signal).
      if (!fs.existsSync(recordPath)) {
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(recordPath, JSON.stringify({ schemaVersion: 1, name: 'reassert-home', createdAt: 2 }));
      }
    });

    fs.rmSync(home, { recursive: true, force: true }); // nuke the entire home

    expect(await waitFor(() => reasserts() >= 1)).toBe(true);
    expect(await waitFor(() => fs.existsSync(runtimeDir))).toBe(true);
    expect(readProjectOwner(runtimeDir)?.id).toBe(owner.id); // same identity restored
    expect(fs.existsSync(recordPath)).toBe(true); // project.json re-materialized
  });

  it('after re-assertion a fresh acquireProject finds the live owner (handoff, not duplicate)', async () => {
    const { runtimeDir } = freshHome();
    // Model the owner as a SEPARATE live process (a foreign pid), the real
    // scenario — the re-asserting owner is a different process than the launch that
    // later probes it. (Using this test process's own pid would trip acquireProject's
    // "re-claim my own record" path and mask the handoff.)
    const owner: ProjectOwner = {
      pid: 999999,
      startedAt: 5,
      id: '999999-5',
      protocol: PROTOCOL_VERSION,
      host: os.hostname(),
      project: 'reassert-handoff',
      dropDir: runtimeDir,
      startTime: 'st:owner',
    };
    reassertOwner(runtimeDir, owner); // publish owner.json as a live owner would on claim
    // A listener consuming owner's channel, wired (as the bridge does) to re-assert.
    const l = listenOnChannel(runtimeDir, owner.id, noop, { onReassert: () => reassertOwner(runtimeDir, owner) });
    open.push(l);
    await sleep(120);

    fs.rmSync(runtimeDir, { recursive: true, force: true }); // external removal
    expect(await waitFor(() => readProjectOwner(runtimeDir)?.id === owner.id)).toBe(true);

    // A later launch for the same project: the recreated owner.json points at THIS
    // live owner; an injected start-time that still MATCHES the record models the
    // owner being alive, so acquireProject must defer (owned:false) not duplicate.
    const second = await acquireProject('reassert-handoff', runtimeDir, {}, {
      alive: () => true,
      queryStartTime: () => 'st:owner',
    });
    expect(second.owned).toBe(false);
    expect(second.owner.id).toBe(owner.id);
  });

  it('still delivers messages after a re-assertion (watch stays healthy)', async () => {
    const { runtimeDir } = freshHome();
    const claim = await acquireProject('reassert-deliver', runtimeDir, {}, {});
    const owner = claim.owner;
    const got: string[] = [];
    const { reasserts } = await listenOwned(runtimeDir, owner, (p) => got.push(p));

    fs.rmSync(runtimeDir, { recursive: true, force: true }); // external removal
    expect(await waitFor(() => reasserts() >= 1)).toBe(true);
    expect(await waitFor(() => fs.existsSync(runtimeDir))).toBe(true);
    await sleep(150); // let the re-healed watcher settle after the dir was recreated

    sendToChannel(runtimeDir, owner.id, 'C:\\after-reassert.md');
    expect(await waitFor(() => got.includes('C:\\after-reassert.md'), 6000)).toBe(true);
  });

  it('drains a message queued into the recreated dir before the watch re-attaches', async () => {
    // Dropped-open: after re-assert recreates runtime/ + owner.json, a launching
    // peer reads the recreated owner.json and drops a `.msg` — all within the ~60ms
    // heal debounce, so the file PRE-EXISTS the watcher re-attach. The re-created
    // watcher uses ignoreInitial, so only the heal-path reconcile can pick it up.
    // We model the peer's synchronous drop inside onReassert (which reassertOwner
    // recreated the dir for), guaranteeing the .msg is present before re-attach.
    const { runtimeDir } = freshHome();
    const claim = await acquireProject('reassert-drain', runtimeDir, {}, {});
    const owner = claim.owner;
    const got: string[] = [];

    let dropped = false;
    const l = listenOnChannel(runtimeDir, owner.id, (p) => got.push(p), {
      onReassert: () => {
        reassertOwner(runtimeDir, owner); // recreate runtimeDir + owner.json (same id)
        if (!dropped) {
          dropped = true;
          // A launching peer's drop into the freshly recreated dir, BEFORE the
          // debounce re-attaches the watcher.
          sendToChannel(runtimeDir, owner.id, 'C:\\queued-in-heal.md');
        }
      },
    });
    open.push(l);
    await sleep(120);

    fs.rmSync(runtimeDir, { recursive: true, force: true }); // external removal triggers the heal

    expect(await waitFor(() => got.includes('C:\\queued-in-heal.md'), 6000)).toBe(true);
  });

  it('does not re-assert on routine channel churn (a consumed message)', async () => {
    const { runtimeDir } = freshHome();
    const claim = await acquireProject('reassert-churn', runtimeDir, {}, {});
    const owner = claim.owner;
    const got: string[] = [];
    const { reasserts } = await listenOwned(runtimeDir, owner, (p) => got.push(p));

    sendToChannel(runtimeDir, owner.id, 'C:\\churn.md'); // delivered then unlinked
    expect(await waitFor(() => got.length === 1)).toBe(true);
    await sleep(200); // give any spurious unlink→reassert time to (not) fire

    expect(reasserts()).toBe(0); // consuming a .msg must not trigger a re-assert
  });
});

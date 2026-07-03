/**
 * Channel transport — file-drop messaging into a running window (PRD §7, §8.1).
 *
 * The channel is the *messaging* half of the per-project machinery (the
 * `owner.json` liveness record lives in `project.ts`). Both operate on the
 * project's `<home>/runtime/` dir (derived by `projectStore.ts`). A launching
 * peer "sends" by dropping a message file into that dir; the owning window
 * watches the dir and acts on each message. This replaces the old socket/named-
 * pipe transport, which a sandboxed launcher could not `listen()` on — file
 * write + file watch are both permitted where a socket `listen()` is denied
 * (EPERM).
 *
 * Addressing — the "channel name". Every file is named `<channelId>.<unique>.<ext>`
 * where `channelId = <pid>-<startedAt>` identifies the owning instance (the PID
 * aids debugging; `startedAt` makes it unique even if the PID is later reused).
 * A watcher only ever touches files carrying ITS channelId, so even if two
 * owners transiently coexist a message reaches exactly its intended target — no
 * double-delivery, no wrong-window delivery. The current owner's channelId is
 * published in `owner.json`, so a sender addresses the live owner.
 *
 * File lifecycle (all CHANNEL files, owned here):
 *   <id>.<u>.tmp    in-flight write; atomically renamed → `.msg` so a reader
 *                   never sees a half-written message. Crashed-sender orphans
 *                   are reaped.
 *   <id>.<u>.msg    a committed message: a versioned JSON envelope
 *                   `{ v, type, ... }` (see ./protocol). Read, dispatched, deleted.
 *   <id>.<u>.ping   a liveness probe addressed to owner <id>; the owner answers
 *   <id>.<u>.pong   by RENAMING the ping to `.pong` (one file's lifecycle, not
 *                   two). Distinguishes a live owner from a stale owner.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { PROTOCOL_VERSION, isCompatibleWith } from './protocol';
import { OWNER_FILE } from './project';

const TMP_EXT = '.tmp';
const MSG_EXT = '.msg';
const PING_EXT = '.ping';
const PONG_EXT = '.pong';
/** Handshake/in-flight files older than this are orphans (crashed sender / abandoned probe); reapStale deletes them. */
const STALE_MS = 10_000;
/** Default handshake budget — generous enough to cover an owner whose watcher is still starting. */
const PING_TIMEOUT_MS = 1_500;
const PING_INTERVAL_MS = 50;

/** Per-process counter so concurrent drops from one sender get distinct names. */
let seq = 0;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A message addressed to a given channel: `<channelId>.<unique>`. */
function messageBase(dir: string, channelId: string): string {
  return path.join(dir, `${channelId}.${process.pid}-${seq++}-${process.hrtime.bigint()}`);
}

/** Atomically place `body` at `finalPath` (write a `.tmp`, then rename over it). */
function atomicWrite(base: string, ext: string, body: string): void {
  const tmp = base + TMP_EXT;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, base + ext);
}

/**
 * Drop an "open this file" message addressed to the owner `targetId`. Body is a
 * versioned JSON envelope so the channel can carry more message types later
 * without a format break. Safe to call whether or not a window is currently
 * consuming; an unconsumed message waits for the owner's startup reconcile.
 *
 * The caller is responsible for protocol compatibility (it has the owner's
 * version from `owner.json` and must not write to a different-major owner — see
 * `startup.decideStartupAction`); the receiver re-checks defensively.
 */
export function sendToChannel(runtimeDir: string, targetId: string, absPath: string): void {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const envelope = JSON.stringify({ v: PROTOCOL_VERSION, type: 'open', path: absPath });
  atomicWrite(messageBase(runtimeDir, targetId), MSG_EXT, envelope);
}

/** Handle returned by `listenOnChannel`; close it to stop watching. */
export interface ChannelListener {
  close(): Promise<void>;
}

/** Options for `listenOnChannel`. */
export interface ListenOptions {
  /**
   * Invoked when this owner's discoverable artifacts are removed externally while
   * we're still live — either our `owner.json` is unlinked or the whole
   * `runtimeDir` vanishes (PF8, §8.2 — the #60 defense-in-depth). The callback
   * must recreate them with the SAME identity (see `project.ts#reassertOwner`),
   * and re-materialize `project.json` if the home was nuked; the bridge holds the
   * owner record + paths to do so. Routine channel churn (`.msg` consumed,
   * `.ping`→`.pong`, `reapStale` deletions) does NOT trigger it — only removal of
   * `owner.json` or of `runtimeDir` itself.
   */
  onReassert?: () => void;
}

/** How long to wait after a `runtimeDir` removal before re-checking + re-healing the watch. */
const REASSERT_DEBOUNCE_MS = 60;

/**
 * Start consuming the channel for owner `channelId`. Reconciles messages/pings
 * already addressed to us (queued before this window mounted, or left by a prior
 * launch), reaps orphans, then watches for new ones. Each `open` message's path
 * is handed to `onFile`. Only files carrying OUR channelId are touched.
 *
 * Uses chokidar with `usePolling` for robustness across launch contexts (incl.
 * sandboxes, where native FS events may not fire). chokidar v4 has no glob
 * support, so the directory is watched and the channelId prefix filtered in code.
 *
 * The watcher also guards the owner's discoverability: chokidar's `unlink` (our
 * `owner.json` deleted — it lives IN `runtimeDir` at depth 0, so we see it) and
 * `unlinkDir` (`runtimeDir` itself removed) fire `opts.onReassert`, which
 * recreates the artifacts with the same identity so a later launch hands off
 * instead of duplicating (§8.2). When `runtimeDir` vanished, chokidar stops
 * watching the gone root; after re-asserting we re-create the watcher so future
 * messages are still consumed.
 */
export function listenOnChannel(
  runtimeDir: string,
  channelId: string,
  onFile: (absPath: string) => void,
  opts: ListenOptions = {},
): ChannelListener {
  const dir = runtimeDir;
  const mine = channelId + '.';

  fs.mkdirSync(dir, { recursive: true });

  // Reap orphans and drain anything already queued in `dir` for us — messages
  // dropped before we mounted (or before a re-attach, in the heal path below).
  // The re-created watcher uses `ignoreInitial: true`, so a `.msg` already
  // present at re-attach never fires an `add`; this reconcile is what picks it up.
  const reconcile = (): void => {
    reapStale(dir);
    for (const name of safeReaddir(dir)) {
      if (!name.startsWith(mine)) {
        // A `.msg` for a DIFFERENT owner is a rare orphan: the addressee died
        // uncleanly in the ~150ms between a sender's drop and our consume. It can
        // never be re-delivered (ids are unique) and the next clean releaseProject
        // wipes the whole dir — so just note it and leave it, no dedicated cleanup.
        if (name.endsWith(MSG_EXT)) console.warn(`[galley] channel: orphaned message for a defunct owner, ignoring: ${name}`);
        continue;
      }
      if (name.endsWith(MSG_EXT)) consumeMessage(path.join(dir, name), onFile);
      else if (name.endsWith(PING_EXT)) ackPing(path.join(dir, name)); // answer a probe that beat us here
    }
  };

  reconcile();

  let watcher: FSWatcher;
  let closed = false;
  let healTimer: ReturnType<typeof setTimeout> | undefined;
  // Re-entrancy guard: our own re-assert recreates `owner.json` (an `add`, which
  // the message handler ignores since it lacks the channelId prefix). This flag
  // suppresses removal handling while we synchronously drive `onReassert`, so a
  // delete can't storm into a loop. (The re-created watcher's fresh scan of the
  // recreated dir is kept from re-emitting the removed files by `ignoreInitial`.)
  let reasserting = false;

  const reassert = (): void => {
    if (closed || reasserting || !opts.onReassert) return;
    reasserting = true;
    try {
      opts.onReassert(); // recreate runtimeDir + owner.json (+ project.json) with the same identity
    } catch (err) {
      console.error('[galley] channel: re-assert failed:', err);
    } finally {
      reasserting = false;
    }
  };

  const attach = (w: FSWatcher): void => {
    w.on('add', (p) => {
      const name = path.basename(p);
      if (!name.startsWith(mine)) return; // addressed to a different owner — not ours to touch (also skips owner.json)
      if (name.endsWith(MSG_EXT)) consumeMessage(p, onFile);
      else if (name.endsWith(PING_EXT)) ackPing(p); // a launching peer is checking we're alive
    });
    // Only `owner.json`'s removal is a discoverability loss; routine channel files
    // (`.msg` consumed, `.ping`→`.pong` rename, reaped orphans) unlink constantly
    // and must be ignored, or every message would trigger a needless re-assert.
    w.on('unlink', (p) => {
      if (reasserting) return;
      if (path.basename(p) === OWNER_FILE) reassert();
    });
    // The watched root itself vanished (the runtime dir — or the whole home — was
    // removed). Re-assert, then heal the watch: chokidar stops polling a gone
    // root, so we close it and re-create one on the recreated dir. A short debounce
    // lets the recreation settle and coalesces a burst of unlink+unlinkDir events.
    w.on('unlinkDir', (p) => {
      if (reasserting || closed) return;
      if (path.resolve(p) !== path.resolve(dir)) return; // a nested dir we never make — ignore
      reassert();
      healTimer = setTimeout(() => {
        if (closed) return;
        void w.close();
        watcher = chokidarWatch(dir, watchOpts);
        attach(watcher);
        // The re-created watcher ignores initial contents, so drain anything a
        // peer already queued in the recreated dir during the debounce window.
        reconcile();
      }, REASSERT_DEBOUNCE_MS);
    });
    w.on('error', (err) => console.error('[galley] channel watch error:', err));
  };

  const watchOpts = {
    usePolling: true,
    interval: 60,
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
  } as const;

  watcher = chokidarWatch(dir, watchOpts);
  attach(watcher);

  return {
    close: () => {
      closed = true;
      if (healTimer) clearTimeout(healTimer);
      return watcher.close();
    },
  };
}

/** Read, delete, and dispatch one message envelope. */
function consumeMessage(filePath: string, onFile: (absPath: string) => void): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return; // vanished / raced — fine
  }
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* already gone */
  }

  let msg: { v?: unknown; type?: unknown; path?: unknown };
  try {
    msg = JSON.parse(raw);
  } catch {
    console.error('[galley] channel: unparseable message dropped:', filePath);
    return;
  }

  // Defense-in-depth: a sender should have gated on owner.json's version. If an
  // incompatible-major message lands anyway, surface it — don't fail silently.
  if (!isCompatibleWith(msg.v)) {
    console.error(
      `[galley] channel: incompatible protocol ${JSON.stringify(msg.v)} (this build ${PROTOCOL_VERSION}); message ignored`,
    );
    return;
  }

  switch (msg.type) {
    case 'open':
      if (typeof msg.path === 'string' && msg.path) onFile(msg.path);
      return;
    default:
      // Unknown verb under a compatible major = a newer-minor capability we lack.
      // Graceful forward-compat: skip (logged), don't error.
      console.warn(`[galley] channel: unsupported message type ${JSON.stringify(msg.type)}; ignored`);
  }
}

/**
 * Probe whether a window is actively consuming owner `targetId`'s channel
 * (R11–R15 liveness). Drops a `.ping` addressed to that owner and waits for it
 * to be renamed to `.pong`. A live owner answers; a recycled-but-unrelated PID
 * consumes nothing and never does — so this is immune to PID reuse. Cleans up.
 */
export async function pingChannel(
  runtimeDir: string,
  targetId: string,
  { timeoutMs = PING_TIMEOUT_MS, intervalMs = PING_INTERVAL_MS } = {},
): Promise<boolean> {
  const dir = runtimeDir;
  fs.mkdirSync(dir, { recursive: true });
  const base = messageBase(dir, targetId);
  const pingPath = base + PING_EXT;
  const pongPath = base + PONG_EXT;
  atomicWrite(base, PING_EXT, '');

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (fs.existsSync(pongPath)) return true;
      await sleep(intervalMs);
    }
    return false;
  } finally {
    try {
      fs.unlinkSync(pongPath);
    } catch {
      /* no ack arrived */
    }
    try {
      fs.unlinkSync(pingPath);
    } catch {
      /* owner already renamed it to .pong */
    }
  }
}

/** Owner-side ack: rename the probe's `.ping` to `.pong` (one file, no churn). */
function ackPing(pingPath: string): void {
  const pongPath = pingPath.slice(0, -PING_EXT.length) + PONG_EXT;
  try {
    fs.renameSync(pingPath, pongPath);
  } catch {
    /* prober gave up and removed it — fine */
  }
}

/** Delete `.tmp`/`.ping`/`.pong` files orphaned by a crashed sender or abandoned probe. */
function reapStale(dir: string): void {
  const now = Date.now();
  for (const name of safeReaddir(dir)) {
    if (!(name.endsWith(TMP_EXT) || name.endsWith(PING_EXT) || name.endsWith(PONG_EXT))) continue;
    const f = path.join(dir, name);
    try {
      if (now - fs.statSync(f).mtimeMs > STALE_MS) fs.unlinkSync(f);
    } catch {
      /* raced with a rename/delete — fine */
    }
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

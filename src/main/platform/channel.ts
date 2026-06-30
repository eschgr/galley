/**
 * Channel transport — file-drop messaging into a running window (PRD §5.3
 * R11–R15).
 *
 * The channel is the *messaging* half of the per-project machinery (the project
 * scratch dir + `owner.json` live in `project.ts`). A launching peer "sends" by
 * dropping a message file into the project dir; the owning window watches the
 * dir and acts on each message. This replaces the old socket/named-pipe
 * transport, which a sandboxed launcher could not `listen()` on — file write +
 * file watch are both permitted where a socket `listen()` is denied (EPERM).
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
import { projectDir } from './project';
import { PROTOCOL_VERSION, isCompatibleWith } from './protocol';

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
export function sendToChannel(project: string, targetId: string, absPath: string): void {
  const dir = projectDir(project);
  fs.mkdirSync(dir, { recursive: true });
  const envelope = JSON.stringify({ v: PROTOCOL_VERSION, type: 'open', path: absPath });
  atomicWrite(messageBase(dir, targetId), MSG_EXT, envelope);
}

/** Handle returned by `listenOnChannel`; close it to stop watching. */
export interface ChannelListener {
  close(): Promise<void>;
}

/**
 * Start consuming the channel for owner `channelId`. Reconciles messages/pings
 * already addressed to us (queued before this window mounted, or left by a prior
 * launch), reaps orphans, then watches for new ones. Each `open` message's path
 * is handed to `onFile`. Only files carrying OUR channelId are touched.
 *
 * Uses chokidar with `usePolling` for robustness across launch contexts (incl.
 * sandboxes, where native FS events may not fire). chokidar v4 has no glob
 * support, so the directory is watched and the channelId prefix filtered in code.
 */
export function listenOnChannel(
  project: string,
  channelId: string,
  onFile: (absPath: string) => void,
): ChannelListener {
  const dir = projectDir(project);
  fs.mkdirSync(dir, { recursive: true });
  const mine = channelId + '.';

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

  const watcher: FSWatcher = chokidarWatch(dir, {
    usePolling: true,
    interval: 60,
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
  });
  watcher.on('add', (p) => {
    const name = path.basename(p);
    if (!name.startsWith(mine)) return; // addressed to a different owner — not ours to touch
    if (name.endsWith(MSG_EXT)) consumeMessage(p, onFile);
    else if (name.endsWith(PING_EXT)) ackPing(p); // a launching peer is checking we're alive
  });
  watcher.on('error', (err) => console.error('[galley] channel watch error:', err));

  return { close: () => watcher.close() };
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
  project: string,
  targetId: string,
  { timeoutMs = PING_TIMEOUT_MS, intervalMs = PING_INTERVAL_MS } = {},
): Promise<boolean> {
  const dir = projectDir(project);
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

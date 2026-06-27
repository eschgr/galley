/**
 * Channel transport — file-drop messaging into a running window (PRD §5.3
 * R11–R15).
 *
 * The channel is the *messaging* half of the per-project machinery (the project
 * scratch dir + `owner.json` live in `project.ts`). A caller "sends" by dropping
 * a one-line command file holding an absolute path; the owning window watches
 * the directory, reads each command, and opens the file. This replaces the old
 * Unix-socket / named-pipe transport, which a sandboxed launcher could not
 * `listen()` on — a file write + a file watch are both permitted where a socket
 * `listen()` is denied (EPERM).
 *
 * Command-file lifecycle (both are CHANNEL files, owned here):
 *   <unique>.tmp   in-flight write; atomically renamed → .open so the watcher
 *                  never observes a half-written path. A crashed sender may
 *                  orphan one; the stale-`.tmp` reaper cleans those up.
 *   <unique>.open  a committed command: one absolute path. Read, delivered to
 *                  `onFile`, then deleted. Re-delivering an open file just
 *                  focuses its tab (R15), so duplicate drops are harmless.
 *   <unique>.ping  a liveness probe from a launching instance; the owner answers
 *   <unique>.pong  with the matching `.pong`. Lets a new launch tell a real live
 *                  owner from a stale `owner.json` whose PID was recycled.
 *
 * The watcher only ever delivers `.open` (and answers `.ping`), so the project's
 * `owner.json`, an in-flight `.tmp`, and `.pong` files are never opened as docs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { projectDir } from './project';

const TMP_EXT = '.tmp';
const OPEN_EXT = '.open';
// Liveness handshake (PID-reuse defence): a probing launch drops a `.ping`; the
// owner's watcher answers with a `.pong`. This tests whether a window is really
// CONSUMING the channel, which a recycled-but-unrelated PID is not — so it
// distinguishes a live owner from a stale `owner.json` left by a hard kill.
const PING_EXT = '.ping';
const PONG_EXT = '.pong';
/** Transient files older than this are orphans (crashed sender / abandoned probe). */
const STALE_MS = 10_000;
/** Default handshake budget — generous enough to cover an owner whose watcher is still starting. */
const PING_TIMEOUT_MS = 1_500;
const PING_INTERVAL_MS = 50;

/** Per-process counter so concurrent drops from one sender get distinct names. */
let seq = 0;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Drop one command into a project's channel: write the absolute path to a
 * `.tmp` file, then atomically rename it to `.open`. The rename is what the
 * watcher sees, so a reader never catches a partial write. Safe to call whether
 * or not a window is currently consuming the directory (an unconsumed command
 * waits and is picked up by the next claim's startup reconcile).
 */
export function sendToChannel(project: string, absPath: string): void {
  const dir = projectDir(project);
  fs.mkdirSync(dir, { recursive: true });
  const base = `msg-${process.pid}-${seq++}-${process.hrtime.bigint()}`;
  const tmp = path.join(dir, base + TMP_EXT);
  fs.writeFileSync(tmp, absPath + '\n');
  fs.renameSync(tmp, path.join(dir, base + OPEN_EXT));
}

/** Handle returned by `listenOnChannel`; close it to stop watching. */
export interface ChannelListener {
  close(): Promise<void>;
}

/**
 * Start consuming a project's channel. Reconciles any `.open` commands already
 * present (delivered before this window mounted, or left by a prior launch),
 * reaps orphan `.tmp` files, then watches for new commands. Each command's path
 * is handed to `onFile`; the file is deleted once read.
 *
 * Uses chokidar with `usePolling` for robustness across launch contexts (incl.
 * sandboxes, where native FS events may not fire). chokidar v4 has no glob
 * support, so the directory is watched and `.open` is filtered in code.
 */
export function listenOnChannel(project: string, onFile: (absPath: string) => void): ChannelListener {
  const dir = projectDir(project);
  fs.mkdirSync(dir, { recursive: true });

  reapStale(dir);
  for (const name of safeReaddir(dir)) {
    if (name.endsWith(OPEN_EXT)) consume(path.join(dir, name), onFile);
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
    if (p.endsWith(OPEN_EXT)) consume(p, onFile);
    else if (p.endsWith(PING_EXT)) ackPing(p); // a probing launch is checking we're alive
  });
  // A watcher error is logged, not surfaced as a dialog — under the file-drop
  // transport there is no per-launch bind that can fail the way a socket did.
  watcher.on('error', (err) => console.error('[mdtool] channel watch error:', err));

  return { close: () => watcher.close() };
}

/** Read a command file, delete it, and deliver its (trimmed) path if non-empty. */
function consume(filePath: string, onFile: (absPath: string) => void): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return; // already consumed by a concurrent reader / vanished
  }
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* already gone — fine */
  }
  const line = content.trim();
  if (line) onFile(line);
}

/**
 * Probe whether a window is actively consuming the project's channel (R11–R15
 * liveness). Drops a `.ping` (atomic appear, so the owner's watcher sees it
 * whole) and waits for the owner to write the matching `.pong`. Returns true iff
 * acknowledged within the timeout — a far stronger signal than "the recorded PID
 * exists", since a recycled-but-unrelated PID consumes nothing and never acks.
 * Cleans up both files on the way out.
 */
export async function pingChannel(
  project: string,
  { timeoutMs = PING_TIMEOUT_MS, intervalMs = PING_INTERVAL_MS } = {},
): Promise<boolean> {
  const dir = projectDir(project);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `ping-${process.pid}-${seq++}-${process.hrtime.bigint()}`);
  const pingPath = base + PING_EXT;
  const pongPath = base + PONG_EXT;
  const tmp = base + TMP_EXT;
  fs.writeFileSync(tmp, '');
  fs.renameSync(tmp, pingPath);

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
      /* owner may have removed it */
    }
  }
}

/** Owner-side: answer a probe by writing its `.pong`, then remove the `.ping`. */
function ackPing(pingPath: string): void {
  const base = pingPath.slice(0, -PING_EXT.length);
  try {
    fs.writeFileSync(base + PONG_EXT, String(process.pid)); // existence is the signal; content is diagnostic
  } catch {
    /* prober vanished — fine */
  }
  try {
    fs.unlinkSync(pingPath);
  } catch {
    /* already cleaned up */
  }
}

/** Delete transient channel files orphaned by a crashed sender or abandoned probe. */
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

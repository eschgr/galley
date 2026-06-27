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
 *
 * The watcher only ever acts on `.open`, so the project's `owner.json` and any
 * in-flight `.tmp` are ignored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { projectDir } from './project';

const TMP_EXT = '.tmp';
const OPEN_EXT = '.open';
/** A `.tmp` older than this with no rename is an orphan from a crashed sender. */
const STALE_TMP_MS = 10_000;

/** Per-process counter so concurrent drops from one sender get distinct names. */
let seq = 0;

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

  reapStaleTmp(dir);
  for (const name of safeReaddir(dir)) {
    if (name.endsWith(OPEN_EXT)) consume(path.join(dir, name), onFile);
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

/** Delete `.tmp` files left orphaned by a sender that crashed before its rename. */
function reapStaleTmp(dir: string): void {
  const now = Date.now();
  for (const name of safeReaddir(dir)) {
    if (!name.endsWith(TMP_EXT)) continue;
    const f = path.join(dir, name);
    try {
      if (now - fs.statSync(f).mtimeMs > STALE_TMP_MS) fs.unlinkSync(f);
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

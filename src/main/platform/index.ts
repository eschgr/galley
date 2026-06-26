/**
 * Portability seam (PRD §7 architecture notes, §9 migration path).
 *
 * ALL OS-touching main-process work — file read/write, content hashing,
 * file watching, the per-project channel listener, and CLI parsing — sits
 * behind this interface. The rest of the main process talks to the seam, never
 * to Node's `fs`/`net`/`crypto` directly.
 *
 * Why: this is the one layer that a future migration off Electron (the PRD
 * names Tauri/Rust as the target) would rewrite. Keeping it thin and
 * well-defined keeps that migration cheap; everything above it — React,
 * CodeMirror, markdown-it/KaTeX, scroll-sync, tabs — ports as-is.
 *
 * This file defines the contract; the Node file-IO lives in ./fileIo and the
 * watcher uses chokidar here (the channel listener is still deferred).
 */
import * as fileIo from './fileIo';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * Map a channel **name** to its OS transport address (R11): a named pipe on
 * Windows, a Unix-domain socket under the temp dir elsewhere. The launch only
 * ever passes a plain name (`--channel <name>`) — no backslashes to mangle
 * through the shell — and both the app and the caller derive the same address
 * from it. This keeps the transport detail inside the seam (§7 portability).
 */
export function channelAddress(name: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\mdtool-${name}`
    : path.join(os.tmpdir(), `mdtool-${name}.sock`);
}

/** A file's content plus the baseline hash captured at read/write time (PRD §5.6). */
export interface FileSnapshot {
  readonly path: string;
  readonly content: string;
  /** Content hash recorded as the "baseline" for conflict detection (R33–R35). */
  readonly hash: string;
}

/** A genuine external change the watcher forwards to the renderer (R32–R33). */
export interface ExternalChangeEvent {
  readonly path: string;
  /** The new on-disk content, so the renderer can reload without a round-trip. */
  readonly content: string;
  /** Hash of the new on-disk content, for the renderer's conflict logic. */
  readonly hash: string;
}

/** Result of a checked save (R34): either it wrote, or disk had diverged. */
export type SaveResult =
  | { readonly conflict: false; readonly file: FileSnapshot }
  | { readonly conflict: true; readonly disk: FileSnapshot };

export interface PlatformBridge {
  // --- CLI (R7) -----------------------------------------------------------
  /**
   * Absolute file paths passed on the command line at launch (R7), in order;
   * empty if none. `mdtool a.md b.md` opens both. `packaged` distinguishes
   * `mdtool.exe …` from a dev `electron . …`.
   */
  parseCliFileArgs(argv: readonly string[], packaged: boolean): string[];
  /** The `--channel <addr>` address passed at launch, if any (R11). */
  parseCliChannelArg(argv: readonly string[], packaged: boolean): string | null;

  /**
   * Resolve a local-file link clicked in the preview (R4) to an absolute path,
   * relative to the document it was clicked in. Returns null for an unusable href.
   */
  resolveLocalLink(href: string, fromPath: string): string | null;

  // --- File IO + hashing (R33–R35) ---------------------------------------
  /** Read a file and record its hash as the last-known on-disk state. */
  readFile(absPath: string): Promise<FileSnapshot>;
  /**
   * Write content unconditionally (force / "keep mine"). Records the written
   * hash as the last-known on-disk state so the watcher ignores this own save.
   */
  writeFile(absPath: string, content: string): Promise<FileSnapshot>;
  /**
   * Write only if disk still matches what we last knew (R34 write-path guard).
   * If disk has diverged (an external change landed since our last read/write),
   * returns the on-disk snapshot WITHOUT writing, so the caller can prompt.
   */
  saveChecked(absPath: string, content: string): Promise<SaveResult>;

  // --- File watching (R32, R37) ------------------------------------------
  watch(absPath: string, onChange: (event: ExternalChangeEvent) => void): void;
  unwatch(absPath: string): void;

  // --- Per-project channel listener (R11–R15) ----------------------------
  /**
   * Begin listening on the caller-provided channel address (named pipe on
   * Windows / Unix-domain socket on macOS). Each path delivered over the
   * channel is handed to `onFile`. The app does not self-arbitrate (R11).
   */
  listenOnChannel(address: string, onFile: (absPath: string) => void): Promise<void>;
  closeChannel(): Promise<void>;
}

/**
 * The Node-backed bridge. File IO, CLI parsing, and file watching are
 * implemented; the per-project channel listener (R11–R15) is still deferred and
 * throws if called early, so accidental use fails loudly rather than silently
 * no-op'ing.
 */
export function createPlatformBridge(): PlatformBridge {
  // The hash of the on-disk content as we last knew it (set on read/write and
  // when we forward an external change), per path. Drives both self-write
  // detection (R33) and the write-path divergence guard (R34): a watcher event
  // or a save whose disk hash matches `knownHash` is consistent with our view.
  const knownHash = new Map<string, string>();
  const watchers = new Map<string, FSWatcher>();
  let channelServer: net.Server | null = null;

  const closeWatcher = (absPath: string): void => {
    const watcher = watchers.get(absPath);
    if (watcher) {
      void watcher.close();
      watchers.delete(absPath);
    }
  };

  return {
    parseCliFileArgs: fileIo.parseCliFileArgs,
    resolveLocalLink: fileIo.resolveLocalLink,
    parseCliChannelArg: fileIo.parseCliChannelArg,

    async readFile(absPath) {
      const snapshot = await fileIo.readFile(absPath);
      knownHash.set(absPath, snapshot.hash);
      return snapshot;
    },

    async writeFile(absPath, content) {
      const snapshot = await fileIo.writeFile(absPath, content);
      knownHash.set(absPath, snapshot.hash);
      return snapshot;
    },

    async saveChecked(absPath, content) {
      const onDisk = await fileIo.readFile(absPath); // raw read — does NOT update knownHash
      if (onDisk.hash !== knownHash.get(absPath)) {
        return { conflict: true, disk: onDisk }; // diverged since we last knew (R34)
      }
      const file = await fileIo.writeFile(absPath, content);
      knownHash.set(absPath, file.hash);
      return { conflict: false, file };
    },

    watch(absPath, onChange) {
      closeWatcher(absPath); // one watcher per path
      const watcher = chokidarWatch(absPath, {
        ignoreInitial: true,
        // Coalesce rapid/partial external writes into one stable event (R37).
        awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
      });
      const handle = async (): Promise<void> => {
        try {
          const snapshot = await fileIo.readFile(absPath);
          if (snapshot.hash === knownHash.get(absPath)) return; // unchanged from our view (R33)
          knownHash.set(absPath, snapshot.hash); // remember the new on-disk state
          onChange({ path: absPath, content: snapshot.content, hash: snapshot.hash });
        } catch {
          // File vanished or was unreadable mid-change — ignore (delete handling TBD).
        }
      };
      watcher.on('change', handle);
      watcher.on('add', handle); // some tools replace via rename → add
      watchers.set(absPath, watcher);
    },

    unwatch(absPath) {
      closeWatcher(absPath);
    },

    // Listen on the caller-provided channel (R11). The wire protocol is simple:
    // each delivered message is a newline-terminated absolute file path. The app
    // does not arbitrate — the caller already decided to send rather than launch.
    listenOnChannel(address, onFile) {
      return new Promise((resolve, reject) => {
        const server = net.createServer((socket) => {
          socket.setEncoding('utf8');
          let buffer = '';
          const drain = (final: boolean) => {
            let idx: number;
            while ((idx = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, idx).trim();
              buffer = buffer.slice(idx + 1);
              if (line) onFile(line);
            }
            if (final) {
              const line = buffer.trim(); // a message sent without a trailing newline
              if (line) onFile(line);
              buffer = '';
            }
          };
          socket.on('data', (chunk: string) => {
            buffer += chunk;
            drain(false);
          });
          socket.on('end', () => drain(true));
          socket.on('error', () => {
            /* a dropped client connection is not our problem */
          });
        });
        server.once('error', reject);
        server.listen(address, () => {
          server.removeListener('error', reject);
          channelServer = server;
          resolve();
        });
      });
    },
    closeChannel() {
      return new Promise((resolve) => {
        if (!channelServer) return resolve();
        channelServer.close(() => resolve());
        channelServer = null;
      });
    },
  };
}

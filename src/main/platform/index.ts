/**
 * Portability seam (PRD §7 architecture notes, §9 migration path).
 *
 * ALL OS-touching main-process work — file read/write, content hashing,
 * file watching, the per-project channel, and CLI parsing — sits behind this
 * interface. The rest of the main process talks to the seam, never to Node's
 * `fs`/`crypto` directly.
 *
 * Why: this is the one layer that a future migration off Electron (the PRD
 * names Tauri/Rust as the target) would rewrite. Keeping it thin and
 * well-defined keeps that migration cheap; everything above it — React,
 * CodeMirror, markdown-it/KaTeX, scroll-sync, tabs — ports as-is.
 *
 * This file defines the contract; the Node file-IO lives in ./fileIo, the
 * watcher uses chokidar here, and the per-project channel splits across
 * ./project (scratch dir + owner.json liveness) and ./channel (file-drop
 * messaging).
 */
import * as fileIo from './fileIo';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import {
  acquireProject as acquireProjectFs,
  releaseProject as releaseProjectFs,
  type ClaimResult,
} from './project';
import {
  sendToChannel as sendToChannelFs,
  listenOnChannel as listenOnChannelFs,
  pingChannel as pingChannelFs,
  type ChannelListener,
} from './channel';

export type { ClaimResult } from './project';

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
  /** The `--project <name>` value passed at launch, if any (R11/R12). */
  parseCliProjectArg(argv: readonly string[], packaged: boolean): string | null;

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

  // --- Per-project channel (R11–R15) -------------------------------------
  /**
   * Claim the project for this process, taking over a stale/absent owner. When
   * a *live* instance already owns it (confirmed via the channel handshake, so a
   * recycled PID can't masquerade as one), resolves `{ owned: false }` so the
   * launch can hand its files off and exit instead of opening a duplicate
   * window. A successful claim is remembered so `closeChannel` releases it.
   */
  claimProject(project: string, opts?: { appVersion?: string }): Promise<ClaimResult>;
  /** Drop one file into the project's channel for the owning window to open. */
  sendToChannel(project: string, absPath: string): void;
  /**
   * Start consuming the project's channel; each delivered absolute path is
   * handed to `onFile`. Reconciles commands queued before this window mounted.
   */
  listenOnChannel(project: string, onFile: (absPath: string) => void): void;
  /** Stop consuming the channel and release the project (ownership-guarded). */
  closeChannel(): Promise<void>;
}

/**
 * The Node-backed bridge. File IO, CLI parsing, file watching, and the
 * per-project file-drop channel (R11–R15) are all implemented here by composing
 * ./fileIo, ./project, and ./channel.
 */
export function createPlatformBridge(): PlatformBridge {
  // The hash of the on-disk content as we last knew it (set on read/write and
  // when we forward an external change), per path. Drives both self-write
  // detection (R33) and the write-path divergence guard (R34): a watcher event
  // or a save whose disk hash matches `knownHash` is consistent with our view.
  const knownHash = new Map<string, string>();
  const watchers = new Map<string, FSWatcher>();
  // The active channel watcher and the project we claimed, so closeChannel can
  // stop watching and release ownership of exactly what this process took.
  let channelListener: ChannelListener | null = null;
  let claimedProject: string | null = null;

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
    parseCliProjectArg: fileIo.parseCliProjectArg,

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

    // Per-project channel (R11–R15). The app self-arbitrates: claim the project
    // (taking over a stale owner), and either become its window or — when a live
    // owner exists — drop files into its channel. See ./project and ./channel.
    async claimProject(project, opts) {
      const result = await acquireProjectFs(project, opts ?? {}, { ping: (p) => pingChannelFs(p) });
      if (result.owned) claimedProject = project; // remember so closeChannel releases it
      return result;
    },

    sendToChannel(project, absPath) {
      sendToChannelFs(project, absPath);
    },

    listenOnChannel(project, onFile) {
      channelListener = listenOnChannelFs(project, onFile);
    },

    async closeChannel() {
      if (channelListener) {
        await channelListener.close();
        channelListener = null;
      }
      if (claimedProject) {
        releaseProjectFs(claimedProject); // ownership-guarded: only removes our own dir
        claimedProject = null;
      }
    },
  };
}

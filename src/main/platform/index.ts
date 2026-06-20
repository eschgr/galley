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
 * This file defines the contract; the Node file-IO implementation lives in
 * ./fileIo (the watcher and channel listener are still deferred).
 */
import * as fileIo from './fileIo';

/** A file's content plus the baseline hash captured at read/write time (PRD §5.6). */
export interface FileSnapshot {
  readonly path: string;
  readonly content: string;
  /** Content hash recorded as the "baseline" for conflict detection (R33–R35). */
  readonly hash: string;
}

/** An external-change event the watcher forwards to the renderer (R32–R33). */
export interface ExternalChangeEvent {
  readonly path: string;
  /** Hash of the new on-disk content, for the renderer's conflict logic. */
  readonly hash: string;
}

export interface PlatformBridge {
  // --- CLI (R7) -----------------------------------------------------------
  /**
   * Absolute file path passed on the command line at launch, if any.
   * `packaged` distinguishes `mdtool.exe <file>` from a dev `electron . <file>`.
   */
  parseCliFileArg(argv: readonly string[], packaged: boolean): string | null;

  // --- File IO + hashing (R33–R35) ---------------------------------------
  readFile(absPath: string): Promise<FileSnapshot>;
  /**
   * Write content to disk. Records the written content's hash so the watcher
   * can distinguish the app's own save from a genuine external change (R33).
   * Callers are responsible for the disk-vs-baseline guard (R34) before this.
   */
  writeFile(absPath: string, content: string): Promise<FileSnapshot>;

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
 * The Node-backed bridge. File IO + CLI parsing are implemented (this phase);
 * the watcher (R32–R38) and the per-project channel listener (R11–R15) are
 * deferred to later phases and throw if called early, so accidental use fails
 * loudly rather than silently no-op'ing.
 */
export function createPlatformBridge(): PlatformBridge {
  return {
    parseCliFileArg: fileIo.parseCliFileArg,
    readFile: fileIo.readFile,
    writeFile: fileIo.writeFile,
    watch() {
      throw new Error('watch() not implemented yet (deferred phase — PRD §5.6).');
    },
    unwatch() {
      throw new Error('unwatch() not implemented yet (deferred phase — PRD §5.6).');
    },
    listenOnChannel() {
      throw new Error('listenOnChannel() not implemented yet (deferred phase — PRD §5.3).');
    },
    closeChannel() {
      throw new Error('closeChannel() not implemented yet (deferred phase — PRD §5.3).');
    },
  };
}

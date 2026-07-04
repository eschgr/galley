/**
 * Portability seam (architecture notes & migration path).
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
 * watcher uses chokidar here, and the per-project machinery splits across
 * ./projectStore (durable home layout + project.json), ./project (owner.json
 * liveness) and ./channel (file-drop messaging).
 */
import * as fileIo from './fileIo';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import {
  acquireProject as acquireProjectFs,
  releaseProject as releaseProjectFs,
  reassertOwner as reassertOwnerFs,
  type ClaimResult,
  type ProjectOwner,
} from './project';
import {
  sendToChannel as sendToChannelFs,
  listenOnChannel as listenOnChannelFs,
  type ChannelListener,
} from './channel';
import {
  projectPaths,
  materializeProjectRecord,
  readSession,
  writeSession as writeSessionFs,
  SESSION_SCHEMA_VERSION,
  type ProjectPaths,
} from './projectStore';

export type { ClaimResult } from './project';

/** A file's content plus the baseline hash captured at read/write time (saving & conflict handling). */
export interface FileSnapshot {
  readonly path: string;
  readonly content: string;
  /** Content hash recorded as the "baseline" for conflict detection (self-write detection + read/write-path conflict guards). */
  readonly hash: string;
}

/** A genuine external change the watcher forwards to the renderer (watch open files + self-write detection). */
export interface ExternalChangeEvent {
  readonly path: string;
  /** The new on-disk content, so the renderer can reload without a round-trip. */
  readonly content: string;
  /** Hash of the new on-disk content, for the renderer's conflict logic. */
  readonly hash: string;
}

/** Result of a checked save (write-path conflict guard): either it wrote, or disk had diverged. */
export type SaveResult =
  | { readonly conflict: false; readonly file: FileSnapshot }
  | { readonly conflict: true; readonly disk: FileSnapshot };

export interface PlatformBridge {
  // --- CLI (open a file via CLI argument) ---------------------------------
  /**
   * Absolute file paths passed on the command line at launch (open a file via CLI argument), in order;
   * empty if none. `galley a.md b.md` opens both. `packaged` distinguishes
   * `galley.exe …` from a dev `electron . …`.
   */
  parseCliFileArgs(argv: readonly string[], packaged: boolean): string[];
  /** The `--project <name>` value passed at launch, if any (self-arbitrate per project; keyed by a stable name). */
  parseCliProjectArg(argv: readonly string[], packaged: boolean): string | null;

  /**
   * Resolve a local-file link clicked in the preview (preview link handling) to an absolute path,
   * relative to the document it was clicked in. Returns null for an unusable href.
   */
  resolveLocalLink(href: string, fromPath: string): string | null;

  // --- File IO + hashing (self-write detection + conflict guards) --------
  /** Read a file and record its hash as the last-known on-disk state. */
  readFile(absPath: string): Promise<FileSnapshot>;
  /**
   * Write content unconditionally (force / "keep mine"). Records the written
   * hash as the last-known on-disk state so the watcher ignores this own save.
   */
  writeFile(absPath: string, content: string): Promise<FileSnapshot>;
  /**
   * Write only if disk still matches what we last knew (write-path conflict guard).
   * If disk has diverged (an external change landed since our last read/write),
   * returns the on-disk snapshot WITHOUT writing, so the caller can prompt.
   */
  saveChecked(absPath: string, content: string): Promise<SaveResult>;

  // --- File watching (watch open files; watcher debounce) ----------------
  watch(absPath: string, onChange: (event: ExternalChangeEvent) => void): void;
  unwatch(absPath: string): void;

  // --- Per-project channel (the instance model & file delivery) ----------
  /**
   * Claim the project for this process, taking over a stale/absent owner. When
   * a *live* instance already owns it (confirmed via an OS start-time match, so a
   * recycled PID can't masquerade as one — §8.1), resolves `{ owned: false }` so
   * the launch can hand its files off and exit instead of opening a duplicate
   * window. A successful claim is remembered so `closeChannel` releases it.
   */
  claimProject(project: string, opts?: { appVersion?: string }): Promise<ClaimResult>;
  /** Drop one file into the channel addressed to owner `targetId` (its `owner.id`). */
  sendToChannel(project: string, targetId: string, absPath: string): void;
  /**
   * Start consuming the channel addressed to `channelId` (this window's own
   * `owner.id`); each delivered absolute path is handed to `onFile`. Reconciles
   * messages queued before this window mounted.
   */
  listenOnChannel(project: string, channelId: string, onFile: (absPath: string) => void): void;
  /** Stop consuming the channel and release the project (ownership-guarded). */
  closeChannel(): Promise<void>;

  // --- Session persistence (PF19, §8.6) ----------------------------------
  /**
   * Persist the claimed project's open-tab set to `<home>/session.json` with
   * `cleanExit:false` (§8.6) — the crash safety net, rewritten as tabs change.
   * `files` are absolute paths in tab order; `activeIndex` is the active tab's
   * index (or -1). NO-OP when there is no claimed project: a projectless window
   * (PF27) has no home, so it persists nothing.
   */
  writeSession(session: { files: string[]; activeIndex: number }): void;
  /**
   * Flag a clean shutdown: rewrite the claimed project's existing session with
   * `cleanExit:true` (§8.6), so a later launch can tell this quit from a crash.
   * NO-OP when there is no claimed project OR no session on disk yet — a clean
   * quit before any session was written leaves nothing to (and needs no) marking.
   */
  markCleanExit(): void;
  /**
   * The restore decision (§8.6, PF20/D2): the claimed project's session is
   * *restorable* iff its `session.json` exists, `cleanExit === false` (a prior
   * crash / unclean exit — a clean shutdown set it true), AND `files` is
   * non-empty. Returns the persisted paths + active index when restorable, else
   * null — including projectless mode (no claim, no home ⇒ nothing to restore).
   * This is the pure decision; the caller (main) loads the paths from disk.
   */
  getRestoreSession(): { files: string[]; activeIndex: number } | null;

  // --- Project identity (PF24) -------------------------------------------
  /**
   * The claimed project's name, or null in projectless mode (PF27). Fixed for
   * the window's lifetime — surfaced in the OS title bar (PF24).
   */
  projectName(): string | null;
}

/**
 * Options for the Node-backed bridge.
 */
export interface PlatformBridgeOptions {
  /**
   * The projects-home root — `<userData>/projects` — resolved LAZILY (a thunk,
   * not a value) so it can be read after `app` is ready without pulling Electron
   * into this seam. Every project op runs post-`ready`, so first-use resolution
   * is safe. Tests inject a temp dir here.
   */
  projectsHome: () => string;
}

/**
 * The Node-backed bridge. File IO, CLI parsing, file watching, and the
 * per-project durable home + file-drop channel (§7, §8.1) are all implemented
 * here by composing ./fileIo, ./projectStore, ./project, and ./channel.
 */
export function createPlatformBridge(options: PlatformBridgeOptions): PlatformBridge {
  // The hash of the on-disk content as we last knew it (set on read/write and
  // when we forward an external change), per path. Drives both self-write
  // detection and the write-path divergence guard: a watcher event
  // or a save whose disk hash matches `knownHash` is consistent with our view.
  const knownHash = new Map<string, string>();
  const watchers = new Map<string, FSWatcher>();
  // The active channel watcher and the runtime dir we claimed, so closeChannel
  // can stop watching and release ownership of exactly what this process took.
  let channelListener: ChannelListener | null = null;
  let claimedRuntimeDir: string | null = null;
  // The owner record + project name from our claim, retained so a re-assertion
  // (PF8, §8.2) can rewrite `owner.json` with the SAME identity and re-materialize
  // `project.json` if the home was externally removed while we're live.
  let claimedOwner: ProjectOwner | null = null;
  let claimedProject: string | null = null;
  let claimedAppVersion: string | undefined;

  // Resolve a project name to its on-disk layout, deriving the projects-home
  // lazily on first use (post-`app`-ready — see PlatformBridgeOptions).
  const pathsFor = (project: string): ProjectPaths => projectPaths(options.projectsHome(), project);

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
        return { conflict: true, disk: onDisk }; // diverged since we last knew
      }
      const file = await fileIo.writeFile(absPath, content);
      knownHash.set(absPath, file.hash);
      return { conflict: false, file };
    },

    watch(absPath, onChange) {
      closeWatcher(absPath); // one watcher per path
      const watcher = chokidarWatch(absPath, {
        ignoreInitial: true,
        // Coalesce rapid/partial external writes into one stable event (watcher debounce).
        awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
      });
      const handle = async (): Promise<void> => {
        try {
          const snapshot = await fileIo.readFile(absPath);
          if (snapshot.hash === knownHash.get(absPath)) return; // unchanged from our view (self-write detection)
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

    // Per-project channel (§7, §8.1). The app self-arbitrates: materialize the
    // durable home, then claim the project (taking over a stale owner) and either
    // become its window or — when a live owner exists — drop files into its
    // channel. See ./projectStore, ./project, and ./channel.
    async claimProject(project, opts) {
      const paths = pathsFor(project);
      // Materialize-or-reuse the durable record BEFORE claiming, so the home
      // exists whether we become owner or hand off (PF3). Reuse preserves an
      // existing createdAt — a claim never clobbers durable data.
      materializeProjectRecord(paths, project, opts ?? {});
      // Liveness uses the default OS start-time query (kill(0) + start-time match);
      // no channel handshake — see project.ts#acquireProject / §8.1.
      const result = await acquireProjectFs(project, paths.runtimeDir, opts ?? {}, {});
      if (result.owned) {
        // Remember so closeChannel releases it and a re-assertion (§8.2) can
        // recreate the artifacts with this exact owner identity.
        claimedRuntimeDir = paths.runtimeDir;
        claimedOwner = result.owner;
        claimedProject = project;
        claimedAppVersion = opts?.appVersion;
      }
      return result;
    },

    sendToChannel(project, targetId, absPath) {
      sendToChannelFs(pathsFor(project).runtimeDir, targetId, absPath);
    },

    listenOnChannel(project, channelId, onFile) {
      const paths = pathsFor(project);
      channelListener = listenOnChannelFs(paths.runtimeDir, channelId, onFile, {
        // On external removal of runtime/ or owner.json while we're live: recreate
        // the discoverable artifacts with the SAME identity so a later launch hands
        // off (§8.2, PF8). Re-materialize project.json too, in case the whole home
        // was nuked — its absence is the signal to recreate it (an existing record
        // is preserved untouched, never re-stamped).
        onReassert: () => {
          if (claimedOwner) reassertOwnerFs(paths.runtimeDir, claimedOwner);
          if (claimedProject) {
            materializeProjectRecord(paths, claimedProject, { appVersion: claimedAppVersion });
          }
        },
      });
    },

    async closeChannel() {
      if (channelListener) {
        await channelListener.close();
        channelListener = null;
      }
      if (claimedRuntimeDir) {
        // Ownership-guarded, non-destructive (PF8): removes ONLY our runtime/ dir,
        // never project.json or the home — the #60 data-safety fix.
        releaseProjectFs(claimedRuntimeDir);
        claimedRuntimeDir = null;
      }
      claimedOwner = null;
      claimedProject = null;
      claimedAppVersion = undefined;
    },

    // Session persistence (PF19, §8.6). Both derive the home from the retained
    // `claimedProject` and no-op in projectless mode — a window with no claimed
    // project has no home and writes no session.
    writeSession(session) {
      if (!claimedProject) return;
      writeSessionFs(pathsFor(claimedProject).homeDir, {
        schemaVersion: SESSION_SCHEMA_VERSION,
        files: session.files,
        activeIndex: session.activeIndex,
        cleanExit: false, // running; flipped true only by markCleanExit on a clean close
      });
    },

    markCleanExit() {
      if (!claimedProject) return;
      const homeDir = pathsFor(claimedProject).homeDir;
      const existing = readSession(homeDir);
      if (!existing) return; // nothing was ever persisted — nothing to mark
      writeSessionFs(homeDir, { ...existing, cleanExit: true });
    },

    // The restore decision (§8.6, PF20/D2). Pure and side-effect-free: reads the
    // claimed project's session and returns its paths only if it looks like a
    // dirty shutdown (cleanExit:false) with a non-empty open-set. A projectless
    // window has no claim and no home, so it returns null — projectless never
    // restores by design. Loading the paths from disk is main's job (readFile).
    getRestoreSession() {
      if (!claimedProject) return null;
      const session = readSession(pathsFor(claimedProject).homeDir);
      // Restorable iff a session exists, it was NOT a clean shutdown, and it had
      // open tabs. A clean quit (cleanExit:true), an absent record, or an empty
      // open-set all yield null — nothing to offer.
      if (!session || session.cleanExit || session.files.length === 0) return null;
      return { files: [...session.files], activeIndex: session.activeIndex };
    },

    // Project identity (PF24). Reads the retained `claimedProject`, null in
    // projectless mode — a window with no claim has no name to show.
    projectName() {
      return claimedProject;
    },
  };
}

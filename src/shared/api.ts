/**
 * The shape of the bridge exposed from the main process to the renderer across
 * the contextIsolation boundary (see src/preload.ts). This is the ENTIRE
 * surface the renderer is allowed to touch — no raw Node, no ipcRenderer.
 *
 * File watching, the channel listener, and conflict signalling get added here
 * (and implemented behind the platform seam) in later phases. Keeping this typed
 * and minimal is the renderer side of the security model and the
 * portability seam.
 */

/** A file plus the baseline hash captured at read/write time (saving & conflict handling). */
export interface OpenedFile {
  readonly path: string;
  readonly content: string;
  readonly hash: string;
}

/**
 * A file delivered to be opened, plus an optional one-shot 1-based line to reveal
 * (open at a specific line — CLI `path:line`, or the channel envelope's `line`).
 * The reveal target is transient: it rides in on the open only, is never stored on
 * the tab, and is not part of the persisted snapshot. No line opens at the top.
 */
export type OpenTarget = OpenedFile & { readonly line?: number };

/** Outcome of a save (write-path conflict guard): it wrote, or disk had diverged (no write). */
export type SaveOutcome =
  | { readonly conflict: false; readonly file: OpenedFile }
  | { readonly conflict: true; readonly disk: OpenedFile };

export interface GalleyApi {
  /** Host platform, surfaced for platform-conditional UI (shortcut labels, etc.). */
  readonly platform: NodeJS.Platform;
  /** App version, for the Help window. */
  readonly version: string;
  /**
   * The claimed project's name, surfaced in the OS window title. Fixed
   * for the window's lifetime, like `platform`/`version`; null in projectless
   * mode, where the title shows no project.
   */
  readonly projectName: string | null;
  /**
   * Open a URL in the system default browser (preview link handling). Only http/https/mailto
   * are honored by the main process; other schemes are silently ignored.
   */
  openExternal(url: string): Promise<void>;
  /**
   * Open a local-file link clicked in the preview: `href` is resolved
   * relative to `fromPath`'s folder and opened as a tab. For relative/absolute
   * file paths and `file://` URLs — external (web/mail) links use openExternal.
   */
  openLocalFile(href: string, fromPath: string): void;
  /**
   * Tell the main process whether the source pane is now visible, so it can
   * widen the window for side-by-side editing or shrink it back for reading
   * (split view & Show/Hide Source reading mode). A no-op effect when the window is maximized/fullscreen.
   */
  setSourceVisible(visible: boolean): Promise<void>;
  /**
   * Mirror the active document's path to main so Export to PDF can default the
   * Save dialog beside the source (Export to PDF). Fire-and-forget; null on the welcome
   * screen.
   */
  setActiveDocPath(path: string | null): void;
  /**
   * Mirror the open-tab set to main so it can persist the session as a crash
   * safety net: `files` are the open tabs' absolute paths in order,
   * `activeIndex` the active tab's index (or -1). Fire-and-forget; reported on
   * every tab open/close/switch. A no-op in projectless mode (main has no home).
   */
  setSession(session: { files: string[]; activeIndex: number }): void;
  /**
   * Pull the session to restore after a dirty shutdown, once on
   * mount. Non-null only when the claimed project's last session was left dirty
   * (a crash / unclean exit): main loads each persisted path from disk (skipping
   * any that no longer read, adjusting `activeIndex`) and returns the loaded
   * files + active index. Null on a clean shutdown, projectless mode, or nothing
   * to restore — the renderer then shows the restore prompt only when non-null.
   */
  getRestore(): Promise<{ files: OpenedFile[]; activeIndex: number } | null>;

  /**
   * Save content to a path (debounced auto-save / force-save). A checked save (default) refuses to write
   * if disk diverged since we last knew, resolving to `{ conflict: true, disk }`
   * (write-path conflict guard); `force` overwrites unconditionally ("keep mine").
   */
  saveFile(filePath: string, content: string, force?: boolean): Promise<SaveOutcome>;
  /** Read a file on demand — used to reload a tab in place (manual reload). Resolves to
   *  null if it can't be read. (Re)watches the file. */
  readFile(filePath: string): Promise<OpenedFile | null>;
  /**
   * Save As… (relocate) — for an orphaned tab whose file was moved/deleted ("file
   * gone"). Presents a native Save dialog defaulted beside `currentPath`, writes
   * `content` to the chosen path, watches it, and resolves to the new snapshot the
   * tab adopts. Resolves to null if the user cancels or the write fails.
   */
  saveFileAs(currentPath: string, content: string): Promise<OpenedFile | null>;
  /** Tell the main process a tab closed so it stops watching that file (close a tab). */
  notifyClosed(filePath: string): void;
  /** Pull the files passed on the command line at launch (open a file via CLI argument), once. Returned in
   *  command-line order; empty if none. Each may carry an optional reveal line
   *  (open at a specific line). The renderer opens each as a tab and focuses the first. */
  getStartupFiles(): Promise<OpenTarget[]>;
  /**
   * Resolve the absolute path of a file dropped onto the window. Electron removed
   * `File.path` from the renderer under contextIsolation, so path resolution must
   * run in the preload via `webUtils.getPathForFile`; returns '' if it cannot be
   * resolved. Used only by the drag-and-drop open handler.
   */
  getDroppedPath(file: File): string;
  /**
   * Open files dropped onto the window (drag-and-drop open). Each absolute path is
   * opened through the same read/watch/open path as a CLI argument or the file
   * dialog — a new focused tab per file, or focus if already open. Fire-and-forget.
   */
  openFiles(paths: string[]): void;
  /**
   * Subscribe to "a file was opened" (via CLI at launch, File → Open, drag-and-drop,
   * or a channel delivery). The renderer opens it in a tab, or focuses the tab if
   * already open (multiple documents in tabs), revealing the target line if one is
   * carried. Returns an unsubscribe function.
   */
  onOpenFile(callback: (file: OpenTarget) => void): () => void;
  /** Subscribe to the File → Save menu/accelerator (force-save). Returns unsubscribe. */
  onMenuSave(callback: () => void): () => void;
  /** Subscribe to View → Reload File (Ctrl/Cmd+R) — reload the active tab in
   *  place (manual reload). Returns unsubscribe. */
  onReloadFile(callback: () => void): () => void;
  /** Subscribe to File → Close Tab (Ctrl/Cmd+W) — close the active tab, prompting
   *  if it has unsaved edits (close a tab). Returns unsubscribe. */
  onCloseTab(callback: () => void): () => void;
  /** Subscribe to Ctrl+Tab — switch to the next tab (right, wrapping).
   *  Returns unsubscribe. */
  onNextTab(callback: () => void): () => void;
  /** Subscribe to Ctrl+Shift+Tab — switch to the previous tab (left, wrapping).
   *  Returns unsubscribe. */
  onPrevTab(callback: () => void): () => void;
  /** Subscribe to Help → Galley Help — open the Help window. Returns unsubscribe. */
  onHelp(callback: () => void): () => void;
  /**
   * Subscribe to a genuine external change to the open file (watch open files / self-write detection) — the
   * watcher's own saves are already filtered out. Payload is the new on-disk
   * snapshot. Returns an unsubscribe function.
   */
  onExternalChange(callback: (file: OpenedFile) => void): () => void;
  /**
   * Subscribe to "an open file was removed on disk" — moved or deleted out from
   * under a tab ("file gone"). Payload is the absolute path that vanished; the
   * renderer marks that tab orphaned. Returns an unsubscribe function.
   */
  onFileRemoved(callback: (path: string) => void): () => void;
}

declare global {
  interface Window {
    galley: GalleyApi;
  }
}

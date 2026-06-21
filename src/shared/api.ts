/**
 * The shape of the bridge exposed from the main process to the renderer across
 * the contextIsolation boundary (see src/preload.ts). This is the ENTIRE
 * surface the renderer is allowed to touch — no raw Node, no ipcRenderer.
 *
 * File watching, the channel listener, and conflict signalling get added here
 * (and implemented behind the platform seam) in later phases. Keeping this typed
 * and minimal is the renderer side of the PRD §7 security model and the §9
 * portability seam.
 */

/** A file plus the baseline hash captured at read/write time (PRD §5.6). */
export interface OpenedFile {
  readonly path: string;
  readonly content: string;
  readonly hash: string;
}

/** Outcome of a save (R34): it wrote, or disk had diverged (no write). */
export type SaveOutcome =
  | { readonly conflict: false; readonly file: OpenedFile }
  | { readonly conflict: true; readonly disk: OpenedFile };

export interface MdtoolApi {
  /** Host platform, surfaced for platform-conditional UI (shortcut labels, etc.). */
  readonly platform: NodeJS.Platform;
  /** App version, for the Help window (PRD R48). */
  readonly version: string;
  /**
   * Open a URL in the system default browser (PRD R4). Only http/https/mailto
   * are honored by the main process; other schemes are silently ignored.
   */
  openExternal(url: string): Promise<void>;
  /**
   * Open a local-file link clicked in the preview (R4): `href` is resolved
   * relative to `fromPath`'s folder and opened as a tab. For relative/absolute
   * file paths and `file://` URLs — external (web/mail) links use openExternal.
   */
  openLocalFile(href: string, fromPath: string): void;
  /**
   * Tell the main process whether the source pane is now visible, so it can
   * widen the window for side-by-side editing or shrink it back for reading
   * (PRD R45). A no-op effect when the window is maximized/fullscreen.
   */
  setSourceVisible(visible: boolean): Promise<void>;

  /**
   * Save content to a path (R29/R30). A checked save (default) refuses to write
   * if disk diverged since we last knew, resolving to `{ conflict: true, disk }`
   * (R34); `force` overwrites unconditionally ("keep mine").
   */
  saveFile(filePath: string, content: string, force?: boolean): Promise<SaveOutcome>;
  /** Read a file on demand — used to reload a tab in place (R31a). Resolves to
   *  null if it can't be read. (Re)watches the file. */
  readFile(filePath: string): Promise<OpenedFile | null>;
  /** Tell the main process a tab closed so it stops watching that file (R41). */
  notifyClosed(filePath: string): void;
  /** Pull the file passed on the command line at launch (R7), once. */
  getStartupFile(): Promise<OpenedFile | null>;
  /**
   * Subscribe to "a file was opened" (via CLI at launch, or File → Open).
   * The renderer opens it in a tab, or focuses the tab if already open (R39).
   * Returns an unsubscribe function.
   */
  onOpenFile(callback: (file: OpenedFile) => void): () => void;
  /** Subscribe to the File → Save menu/accelerator (R30). Returns unsubscribe. */
  onMenuSave(callback: () => void): () => void;
  /** Subscribe to View → Reload File (Ctrl/Cmd+R) — reload the active tab in
   *  place (R31a). Returns unsubscribe. */
  onReloadFile(callback: () => void): () => void;
  /** Subscribe to File → Close Tab (Ctrl/Cmd+W) — close the active tab, prompting
   *  if it has unsaved edits (R41). Returns unsubscribe. */
  onCloseTab(callback: () => void): () => void;
  /** Subscribe to Help → Galley Help — open the Help window (R48). Returns unsubscribe. */
  onHelp(callback: () => void): () => void;
  /**
   * Subscribe to a genuine external change to the open file (R32/R33) — the
   * watcher's own saves are already filtered out. Payload is the new on-disk
   * snapshot. Returns an unsubscribe function.
   */
  onExternalChange(callback: (file: OpenedFile) => void): () => void;
}

declare global {
  interface Window {
    mdtool: MdtoolApi;
  }
}

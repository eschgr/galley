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
   * Tell the main process whether the source pane is now visible, so it can
   * widen the window for side-by-side editing or shrink it back for reading
   * (PRD R45). A no-op effect when the window is maximized/fullscreen.
   */
  setSourceVisible(visible: boolean): Promise<void>;

  /** Save content to a path (R29/R30). Resolves to the new baseline snapshot. */
  saveFile(filePath: string, content: string): Promise<OpenedFile>;
  /** Pull the file passed on the command line at launch (R7), once. */
  getStartupFile(): Promise<OpenedFile | null>;
  /**
   * Subscribe to "a file was opened" (via CLI at launch, or File → Open).
   * Returns an unsubscribe function.
   */
  onOpenFile(callback: (file: OpenedFile) => void): () => void;
  /** Subscribe to the File → Save menu/accelerator (R30). Returns unsubscribe. */
  onMenuSave(callback: () => void): () => void;
}

declare global {
  interface Window {
    mdtool: MdtoolApi;
  }
}

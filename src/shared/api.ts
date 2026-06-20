/**
 * The shape of the bridge exposed from the main process to the renderer across
 * the contextIsolation boundary (see src/preload.ts). This is the ENTIRE
 * surface the renderer is allowed to touch — no raw Node, no ipcRenderer.
 *
 * It is intentionally tiny for the skeleton; file IO, watching, the channel
 * listener, and conflict signalling get added here (and implemented behind the
 * platform seam) in later steps. Keeping this typed and minimal is the renderer
 * side of the PRD §7 security model and the §9 portability seam.
 */
export interface MdtoolApi {
  /** Host platform, surfaced for platform-conditional UI (shortcut labels, etc.). */
  readonly platform: NodeJS.Platform;
  /** App version, for the Help window (PRD R48). */
  readonly version: string;
}

declare global {
  interface Window {
    mdtool: MdtoolApi;
  }
}

/**
 * Startup arbitration (PRD: instance model & file delivery).
 *
 * Pure decision lifted out of `main.ts` so it's testable without Electron
 * (following the `startupFiles.ts` / `pdfName.ts` precedent). Given the result
 * of claiming a project and the files from the command line, decide whether this
 * launch should BECOME the project's window or HAND its files to the window that
 * already owns the project and exit.
 *
 * Self-arbitration lives in the app (not the caller): the caller only ever runs
 * `galley --project <name> <file>`, and this function — driven by `owner.json`
 * liveness — routes it to the right window. The Electron glue in `main.ts` just
 * acts on the verdict (create a window, or drop + quit).
 */
import type { ClaimResult } from './platform/project';
import { isCompatibleWith } from './platform/protocol';

export type StartupAction =
  | { readonly kind: 'own' }
  | { readonly kind: 'handoff'; readonly files: readonly string[] }
  | { readonly kind: 'incompatible'; readonly ownerProtocol: string };

/**
 * - We won the claim ⇒ `own`: open the window and serve this project's channel.
 * - A live owner exists and speaks a compatible protocol ⇒ `handoff`: send our
 *   files into its channel and quit (no second window). With no files this is
 *   still a handoff of nothing — the existing window stays as-is.
 * - A live owner exists but speaks an **incompatible** (different-major) protocol
 *   ⇒ `incompatible`: do NOT pollute its queue with messages it can't parse. The
 *   sender surfaces an error and exits (a rare cross-version-install case).
 */
export function decideStartupAction(claim: ClaimResult, files: readonly string[]): StartupAction {
  if (claim.owned) return { kind: 'own' };
  if (!isCompatibleWith(claim.owner.protocol)) {
    return { kind: 'incompatible', ownerProtocol: claim.owner.protocol };
  }
  return { kind: 'handoff', files: [...files] };
}

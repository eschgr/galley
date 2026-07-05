// Pure, testable logic backing two main-process behaviours:
//   1. `decideCrashReload` — whether a `render-process-gone` event should trigger
//      a recovery reload, capped so a deterministic mount-time crash can't loop or
//      hang the window blank.
//   2. `materializeRestore` — turn a restore DECISION (paths + active index) into
//      the actual loaded tabs, skipping now-missing files and keeping the active
//      index pointing at a real tab.
// Both are side-effect-free (time and disk are injected) so they unit-test with no
// Electron, no real clock, and no real filesystem.

import type { OpenedFile } from '../shared/api';

/** Rolling window over which recent recovery reloads are counted (ms). */
export const RELOAD_WINDOW_MS = 30_000;
/** Max recovery reloads allowed within RELOAD_WINDOW_MS before giving up. */
export const RELOAD_CAP = 3;

/**
 * Decide whether a `render-process-gone` should reload the renderer.
 *
 * Replaces the old single `reloading` flag (which, if the renderer crashed AGAIN
 * during the recovery reload, stayed `true` forever and left the window blank).
 * Instead we keep a rolling window of recent reload timestamps and cap them:
 *
 *  - `clean-exit` / `closing` / `destroyed` ⇒ no reload, list unchanged.
 *  - Otherwise drop timestamps older than the window; if `RELOAD_CAP` remain,
 *    the renderer is crashing repeatedly — stop reloading (`gaveUp`) rather than
 *    loop or hang. Else record `now` and reload.
 *
 * Because EVERY `render-process-gone` re-evaluates this (there is no in-flight
 * flag to get stuck), a crash during the recovery reload simply reloads again,
 * up to the cap — then gives up cleanly. Old timestamps age out, so a lone crash
 * hours later reloads normally.
 */
export function decideCrashReload(opts: {
  reason: string;
  closing: boolean;
  destroyed: boolean;
  recentReloads: readonly number[];
  now: number;
}): { reload: boolean; recentReloads: number[]; gaveUp: boolean } {
  const { reason, closing, destroyed, recentReloads, now } = opts;
  // Normal teardown or a window on its way out — never a recovery reload, and
  // leave the history untouched (don't let a clean exit reset the cap window).
  if (reason === 'clean-exit' || closing || destroyed) {
    return { reload: false, recentReloads: [...recentReloads], gaveUp: false };
  }
  const pruned = recentReloads.filter((t) => now - t < RELOAD_WINDOW_MS);
  if (pruned.length >= RELOAD_CAP) {
    // Repeated crashes inside the window — a deterministic mount-time crash. Stop
    // reloading rather than spin. The window stays on its (blank) last load, but
    // main logs and does not loop/hang.
    return { reload: false, recentReloads: pruned, gaveUp: true };
  }
  return { reload: true, recentReloads: [...pruned, now], gaveUp: false };
}

/**
 * Materialize a restore decision into loaded tabs.
 *
 * Loads each persisted path via the injected `readFile` (which returns `null` for
 * a path that no longer reads — deleted/moved since the crash). Skipped paths that
 * precede the active tab pull `activeIndex` down so it still points at the same
 * tab; if the ACTIVE path itself is skipped, `activeIndex` clamps to the first
 * restored tab. Resolves `null` when nothing loads, so the caller offers no
 * restore.
 */
export async function materializeRestore(
  decision: { files: string[]; activeIndex: number },
  readFile: (p: string) => Promise<OpenedFile | null>,
): Promise<{ files: OpenedFile[]; activeIndex: number } | null> {
  const loaded: OpenedFile[] = [];
  let activeIndex = decision.activeIndex;
  for (let i = 0; i < decision.files.length; i++) {
    const snapshot = await readFile(decision.files[i]);
    if (snapshot) {
      loaded.push(snapshot);
    } else {
      // Missing/unreadable — skip it, and pull the active index back if the
      // dropped path was at or before it.
      if (i < decision.activeIndex) activeIndex--;
      else if (i === decision.activeIndex) activeIndex = -1;
    }
  }
  if (loaded.length === 0) return null;
  // Clamp: if the active tab itself was skipped (activeIndex went -1, or it now
  // points past the loaded set), fall back to the first restored tab.
  if (activeIndex < 0 || activeIndex >= loaded.length) activeIndex = 0;
  return { files: loaded, activeIndex };
}

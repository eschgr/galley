/**
 * Update-availability check (#126). On startup and once a day, ask GitHub whether
 * a newer release exists and, if so, notify the user. Notify-only — no download or
 * install. Packaged builds only (dev builds are intentionally short-lived and
 * shouldn't nag).
 *
 * The version compare and the check flow are pure / dependency-injected so they're
 * unit-testable without Electron or the network; the caller (main.ts) supplies the
 * real fetch and the notification (a native dialog).
 */

/** The repo whose releases we check (renamed from mdtool). */
const RELEASES_LATEST = 'https://api.github.com/repos/eschgr/galley/releases/latest';

/** Re-check interval while the app stays open — once a day. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Parse a `vX.Y.Z` (or `X.Y.Z`) tag into its numeric core, ignoring any suffix. */
function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `latestTag` names a strictly newer version than `current`. */
export function isUpdateAvailable(latestTag: string, current: string): boolean {
  const a = parseVersion(latestTag);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * Fetch the latest (non-prerelease, non-draft) release tag from GitHub, or null on
 * any failure — offline, rate-limited, unexpected shape. Never throws.
 */
export async function fetchLatestReleaseTag(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(RELEASES_LATEST, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Galley' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { tag_name?: unknown };
    return typeof json.tag_name === 'string' ? json.tag_name : null;
  } catch {
    return null;
  }
}

export interface CheckOptions {
  /** The running app version (`app.getVersion()`). */
  readonly currentVersion: string;
  /** Only packaged builds check — dev builds are short-lived. */
  readonly packaged: boolean;
  /** Resolve the latest release tag (real impl: fetchLatestReleaseTag). */
  readonly fetchLatestTag: () => Promise<string | null>;
  /** Show the "update available" notification. */
  readonly notify: () => void;
}

/**
 * Run one check: on a packaged build, if a newer release exists, call `notify`.
 * Swallows all errors — a failed check is silent, never disruptive.
 */
export async function checkForUpdate(opts: CheckOptions): Promise<void> {
  if (!opts.packaged) return;
  try {
    const latest = await opts.fetchLatestTag();
    if (latest && isUpdateAvailable(latest, opts.currentVersion)) opts.notify();
  } catch {
    /* silent */
  }
}

/**
 * Remembers the content hashes this process has recently written to each path,
 * so the file watcher can recognize the app's own saves and forward only genuine
 * external changes.
 *
 * The watcher's self-write check can't rely on a single "latest hash" slot alone:
 * a watcher event may surface a slightly-stale or out-of-order on-disk read whose
 * hash matches an *earlier* save in a burst rather than the latest one. Comparing
 * against the whole recent set (not just the latest) recognizes that read as ours
 * and drops it, instead of forwarding it as a spurious external change.
 *
 * Suppression is keyed on the content hash, so it can only ever hide a change that
 * is byte-identical to something we just wrote — which is not an observable change.
 * Entries expire after `ttlMs`, so a genuinely new external write is never masked
 * for longer than that window. Pure and clock-injectable for deterministic tests.
 */
export class SelfWriteTracker {
  private readonly recent = new Map<string, Map<string, number>>();

  constructor(
    private readonly ttlMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record that we wrote `hash` to `absPath` (also prunes that path's expired entries). */
  note(absPath: string, hash: string): void {
    let byHash = this.recent.get(absPath);
    if (!byHash) {
      byHash = new Map();
      this.recent.set(absPath, byHash);
    }
    const now = this.now();
    for (const [h, at] of byHash) if (now - at > this.ttlMs) byHash.delete(h);
    byHash.set(hash, now);
  }

  /** Whether `hash` is a still-live (within `ttlMs`) self-write for `absPath`. */
  has(absPath: string, hash: string): boolean {
    const at = this.recent.get(absPath)?.get(hash);
    return at !== undefined && this.now() - at <= this.ttlMs;
  }

  /** Forget everything tracked for a path (e.g. when it is no longer watched). */
  forget(absPath: string): void {
    this.recent.delete(absPath);
  }
}

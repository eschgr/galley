/**
 * Per-project ownership + liveness (PRD §7 layout, §8.1 liveness).
 *
 * This is the half of the channel machinery that answers "is a window already
 * serving this project, and who is it?" — distinct from `channel.ts`, which owns
 * the messages that flow through the directory. It operates on a plain
 * **`runtimeDir`** (the `<home>/runtime/` folder derived by `projectStore.ts`);
 * it knows nothing about the durable home layout above it.
 *
 * The model deliberately replaces the old caller-arbitrated socket transport
 * (which a sandboxed launcher could not `listen()` on): the app itself decides,
 * on launch, whether to become the project's window or hand its files to the
 * one already running. Liveness is an on-demand check (`process.kill(pid, 0)`),
 * not a heartbeat — the owner writes `owner.json` once on claim and removes it
 * on close; a crashed owner simply leaves a stale record the next launch takes
 * over. Mirrors Chrome's `SingletonLock` (host+pid identity, break-if-stale),
 * adapted to a plain JSON file so it works in a file-only sandbox.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROTOCOL_VERSION } from './protocol';

/** The liveness record inside a project's `runtime/` dir. */
export const OWNER_FILE = 'owner.json';

/** The live-instance record for a project (PRD §8.1). */
export interface ProjectOwner {
  /** OS pid of the instance that owns the project right now. */
  readonly pid: number;
  /** When that instance claimed the project (epoch ms) — disambiguates pid reuse. */
  readonly startedAt: number;
  /**
   * Channel name addressing this owner: `<pid>-<startedAt>`. Senders stamp their
   * message filenames with this so only the intended owner consumes them.
   */
  readonly id: string;
  /** Channel protocol version this owner speaks (e.g. "1.0"); a sender checks it before sending. */
  readonly protocol: string;
  /** Hostname the pid is meaningful on — a pid only proves liveness on its own host. */
  readonly host: string;
  /** The project name (the `--project` value). */
  readonly project: string;
  /** Absolute path of the project's runtime/drop directory. */
  readonly dropDir: string;
  /** App version that wrote the record (debugging / future format changes). */
  readonly appVersion?: string;
}

/** The channel name addressing a given instance. */
export function channelId(pid: number, startedAt: number): string {
  return `${pid}-${startedAt}`;
}

/** Outcome of `claimProject`: either we now own it, or a live owner already does. */
export type ClaimResult =
  | { readonly owned: true; readonly owner: ProjectOwner; readonly dropDir: string }
  | { readonly owned: false; readonly owner: ProjectOwner; readonly dropDir: string };

/** Injectable liveness predicate (so the decision logic is unit-testable). */
export type AliveFn = (pid: number) => boolean;

/**
 * Point-in-time liveness of a pid (no heartbeat). Signal 0 doesn't deliver a
 * signal — it just probes existence/permission: success or `EPERM` (alive but
 * owned by another user) ⇒ alive; `ESRCH` (and anything else) ⇒ dead. A live
 * pid never reads as dead, so the only error mode is a recycled-pid false
 * "alive", which is self-healing (a dropped file just waits for the next claim).
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read and validate a runtime dir's `owner.json`; null if absent/unreadable/garbage. */
export function readProjectOwner(runtimeDir: string): ProjectOwner | null {
  try {
    const raw = fs.readFileSync(path.join(runtimeDir, OWNER_FILE), 'utf8');
    const parsed = JSON.parse(raw) as ProjectOwner;
    if (parsed && typeof parsed.pid === 'number' && typeof parsed.host === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

/** True if a project has a live owner (record present, same host, pid alive). */
export function isProjectLive(runtimeDir: string, alive: AliveFn = isProcessAlive): boolean {
  const owner = readProjectOwner(runtimeDir);
  return !!owner && owner.host === os.hostname() && alive(owner.pid);
}

/**
 * Write `owner.json` atomically (write a temp file, then rename over it). The
 * temp file uses a `.swap` suffix, NOT `.tmp`, so the channel's stale-`.tmp`
 * reaper never races this write.
 */
function writeOwnerAtomic(dir: string, owner: ProjectOwner): void {
  const tmp = path.join(dir, `${OWNER_FILE}.${process.pid}.${process.hrtime.bigint()}.swap`);
  fs.writeFileSync(tmp, JSON.stringify(owner));
  fs.renameSync(tmp, path.join(dir, OWNER_FILE));
}

/** Dependencies for `acquireProject`, injected so the decision is unit-testable. */
export interface AcquireDeps {
  /**
   * Confirm a window is actually CONSUMING a specific owner's channel (the file
   * handshake in `channel.ts#pingChannel`), addressed to `targetId`. This makes
   * the claim safe against PID reuse: a recycled-but-unrelated PID looks alive to
   * `isProcessAlive` but consumes nothing, so it never acks.
   */
  ping: (targetId: string) => Promise<boolean>;
  /** PID-existence probe (fast short-circuit before the handshake). */
  alive?: AliveFn;
}

/**
 * Claim the project for this process, taking over a stale/absent owner. Resolves
 * `{ owned: true }` when we became the owner, or `{ owned: false, owner }` when a
 * *live* instance already owns it (the launch should hand its files off and exit
 * — see `decideStartupAction`).
 *
 * `runtimeDir` is the project's `<home>/runtime/` folder (derived by
 * `projectStore`). `project` is carried through only for the owner record.
 *
 * Liveness is decided in two steps so the common paths stay instant and only the
 * ambiguous one pays for the handshake:
 *  - no `owner.json`        → claim it (exclusive `wx`/`O_EXCL` create; a racing
 *                             launch loses with `EEXIST`, loops, and re-evaluates).
 *  - recorded PID is dead   → stale → take over immediately.
 *  - recorded PID is alive  → could be the real owner OR an unrelated process
 *                             that recycled the PID after a hard kill. Disambiguate
 *                             with the channel handshake: ack ⇒ real owner (defer);
 *                             no ack ⇒ recycled/stale ⇒ take over.
 * A stale record is overwritten via the atomic rename above (last-writer-wins,
 * benign for the turn-based launcher).
 */
export async function acquireProject(
  project: string,
  runtimeDir: string,
  opts: { appVersion?: string },
  deps: AcquireDeps,
): Promise<ClaimResult> {
  const alive = deps.alive ?? isProcessAlive;
  fs.mkdirSync(runtimeDir, { recursive: true });
  const startedAt = Date.now();
  const self: ProjectOwner = {
    pid: process.pid,
    startedAt,
    id: channelId(process.pid, startedAt),
    protocol: PROTOCOL_VERSION,
    host: os.hostname(),
    project,
    dropDir: runtimeDir,
    appVersion: opts.appVersion,
  };

  for (;;) {
    const existing = readProjectOwner(runtimeDir);
    if (existing && existing.host === self.host && existing.pid !== self.pid && alive(existing.pid)) {
      // PID exists — but a recycled PID would too. Only a live consumer acks.
      const targetId = existing.id ?? channelId(existing.pid, existing.startedAt);
      if (await deps.ping(targetId)) {
        return { owned: false, owner: existing, dropDir: runtimeDir };
      }
      // PID alive yet nothing is consuming the channel → stale; fall through.
    }
    if (!existing) {
      try {
        const fd = fs.openSync(path.join(runtimeDir, OWNER_FILE), 'wx'); // O_EXCL — atomic create
        fs.writeFileSync(fd, JSON.stringify(self));
        fs.closeSync(fd);
        return { owned: true, owner: self, dropDir: runtimeDir };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue; // lost the race — re-evaluate
        throw err;
      }
    }
    // existing but stale (dead/recycled PID, other host, or our own prior record) → take over.
    writeOwnerAtomic(runtimeDir, self);
    return { owned: true, owner: self, dropDir: runtimeDir };
  }
}

/**
 * Re-assert ownership after an external removal of `runtime/` or its `owner.json`
 * (PF8, §8.2 — the #60 defense-in-depth). A live owner whose discoverable
 * artifacts were deleted out from under it (manual delete, disk cleaner, AV
 * quarantine) recreates them with the SAME identity, so a later launch's
 * `acquireProject` finds the live owner and hands off instead of silently
 * duplicating the window.
 *
 * The record is re-written VERBATIM — same `id` (`<pid>-<startedAt>`), same
 * pid/startedAt/host/protocol/dropDir — because the published id is what senders
 * stamp their message filenames with; a fresh id would strand every message
 * already addressed to this owner. `mkdirSync recursive` also recreates the home
 * dir if the whole home was nuked. Uses the same atomic rename as `acquireProject`
 * (a `.swap` temp the channel's stale-`.tmp` reaper never races).
 */
export function reassertOwner(runtimeDir: string, owner: ProjectOwner): void {
  fs.mkdirSync(runtimeDir, { recursive: true });
  writeOwnerAtomic(runtimeDir, owner);
}

/**
 * Release the project on window close: remove ONLY the `runtime/` dir (the
 * ownership record + channel files), but ONLY if we still own it. The pid guard
 * stops a slow-closing previous instance from deleting a newer instance's runtime
 * after a takeover.
 *
 * This is the #60 data-safety guarantee: durable data (`project.json`, and the
 * home dir itself) is NEVER touched here — only the disposable coordination state
 * is cleared, so releasing a project can never destroy its durable half.
 */
export function releaseProject(runtimeDir: string): boolean {
  const owner = readProjectOwner(runtimeDir);
  if (!owner || owner.pid !== process.pid) return false;
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  return true;
}

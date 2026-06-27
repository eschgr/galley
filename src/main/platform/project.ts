/**
 * Per-project workspace + liveness (PRD §5.3 R11–R15).
 *
 * A **project** owns a scratch directory under the OS temp dir and a single
 * `owner.json` liveness record inside it. This is the half of the channel
 * machinery that answers "is a window already serving this project, and who is
 * it?" — distinct from `channel.ts`, which owns the messages that flow through
 * the directory.
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

/** Filename prefix for a project's scratch dir under the temp dir. */
const DIR_PREFIX = 'mdtool-';
/** The liveness record inside a project's scratch dir. */
export const OWNER_FILE = 'owner.json';

/** The live-instance record for a project (PRD R12). */
export interface ProjectOwner {
  /** OS pid of the instance that owns the project right now. */
  readonly pid: number;
  /** When that instance claimed the project (epoch ms) — disambiguates pid reuse. */
  readonly startedAt: number;
  /** Hostname the pid is meaningful on — a pid only proves liveness on its own host. */
  readonly host: string;
  /** The project name (the `--project` value). */
  readonly project: string;
  /** Absolute path of the project's scratch/drop directory. */
  readonly dropDir: string;
  /** App version that wrote the record (debugging / future format changes). */
  readonly appVersion?: string;
}

/** Outcome of `claimProject`: either we now own it, or a live owner already does. */
export type ClaimResult =
  | { readonly owned: true; readonly owner: ProjectOwner; readonly dropDir: string }
  | { readonly owned: false; readonly owner: ProjectOwner; readonly dropDir: string };

/** Injectable liveness predicate (so the decision logic is unit-testable). */
export type AliveFn = (pid: number) => boolean;

/**
 * Map a project name to its scratch directory under the OS temp dir.
 *
 * The name lands inside a filesystem path, so it is validated as a flat,
 * filesystem-safe token: only `[A-Za-z0-9._-]`, and never `.`/`..`. This blocks
 * a caller from steering the directory outside the temp dir (`../`, separators).
 * Callers normally derive the name as a short stable hash of the project root,
 * but a readable slug works too — the only contract is "same name ⇒ same dir".
 */
export function projectDir(project: string): string {
  if (typeof project !== 'string' || project.length === 0) {
    throw new Error('project name must be a non-empty string');
  }
  if (project === '.' || project === '..' || !/^[A-Za-z0-9._-]+$/.test(project)) {
    throw new Error(`unsafe project name ${JSON.stringify(project)} — allowed: A-Z a-z 0-9 . _ -`);
  }
  return path.join(os.tmpdir(), `${DIR_PREFIX}${project}`);
}

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

/** Read and validate a project's `owner.json`; null if absent/unreadable/garbage. */
export function readProjectOwner(project: string): ProjectOwner | null {
  try {
    const raw = fs.readFileSync(path.join(projectDir(project), OWNER_FILE), 'utf8');
    const parsed = JSON.parse(raw) as ProjectOwner;
    if (parsed && typeof parsed.pid === 'number' && typeof parsed.host === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

/** True if a project has a live owner (record present, same host, pid alive). */
export function isProjectLive(project: string, alive: AliveFn = isProcessAlive): boolean {
  const owner = readProjectOwner(project);
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

/**
 * Claim the project for this process, taking over a stale/absent owner. Returns
 * `{ owned: true }` when we became the owner, or `{ owned: false, owner }` when
 * a *live* instance already owns it (the caller should hand its files off and
 * exit — see `decideStartupAction`).
 *
 * The no-owner case uses an exclusive create (`wx`, i.e. `O_EXCL`): if two
 * launches race, exactly one wins the create; the loser gets `EEXIST`, loops,
 * re-reads the now-live owner, and correctly reports `owned: false`. A stale
 * (dead-pid / our-own) record is overwritten via the atomic rename above; that
 * path is last-writer-wins, which is benign for the turn-based launcher.
 */
export function claimProject(
  project: string,
  opts: { appVersion?: string } = {},
  alive: AliveFn = isProcessAlive,
): ClaimResult {
  const dir = projectDir(project);
  fs.mkdirSync(dir, { recursive: true });
  const self: ProjectOwner = {
    pid: process.pid,
    startedAt: Date.now(),
    host: os.hostname(),
    project,
    dropDir: dir,
    appVersion: opts.appVersion,
  };

  for (;;) {
    const existing = readProjectOwner(project);
    if (existing && existing.host === self.host && existing.pid !== self.pid && alive(existing.pid)) {
      return { owned: false, owner: existing, dropDir: dir };
    }
    if (!existing) {
      try {
        const fd = fs.openSync(path.join(dir, OWNER_FILE), 'wx'); // O_EXCL — atomic create
        fs.writeFileSync(fd, JSON.stringify(self));
        fs.closeSync(fd);
        return { owned: true, owner: self, dropDir: dir };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue; // lost the race — re-evaluate
        throw err;
      }
    }
    // existing but stale (dead pid, other host, or our own prior record) → take over.
    writeOwnerAtomic(dir, self);
    return { owned: true, owner: self, dropDir: dir };
  }
}

/**
 * Release the project on window close: remove `owner.json` and the scratch dir,
 * but ONLY if we still own it. The pid guard stops a slow-closing previous
 * instance from deleting a newer instance's directory after a takeover.
 */
export function releaseProject(project: string): boolean {
  const owner = readProjectOwner(project);
  if (!owner || owner.pid !== process.pid) return false;
  fs.rmSync(projectDir(project), { recursive: true, force: true });
  return true;
}

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
 * one already running. Liveness is an on-demand check, not a heartbeat — the
 * owner writes `owner.json` once on claim and removes it on close; a crashed
 * owner simply leaves a stale record the next launch takes over. Mirrors Chrome's
 * `SingletonLock` (host+pid identity, break-if-stale), adapted to a plain JSON
 * file so it works in a file-only sandbox.
 *
 * Liveness is an OS-maintained signal, so it survives a modal-blocked main thread
 * (§8.1, #56): an owner is live iff `process.kill(pid,0)` succeeds AND the pid's
 * current OS start-time matches the value recorded at claim. Both are answered by
 * the OS with no owner-code participation, so they stay truthful while the owner
 * is stuck in a native modal — the failure mode of the retired `.ping`→`.pong`
 * ack (answered on the owner's event loop, which the modal blocked → the owner
 * looked dead → a duplicate window). The start-time match is the reuse guard the
 * ack used to provide: a recycled pid has a different OS start-time ⇒ treated as
 * dead ⇒ take over, never a phantom handoff.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
   * The pid's OS process start-time, queried once at claim, canonicalized to a
   * path-independent absolute value — UTC epoch-ms as a decimal string (see
   * `queryProcessStartTime`). This is the reuse guard: liveness requires the pid's
   * *current* OS start-time to still equal this, so a recycled pid (same number,
   * later start-time) reads as dead (§8.1, #56). Because it is canonical epoch-ms,
   * a claim recorded via one query path (e.g. `wmic`) still equals a later re-query
   * via another (e.g. CIM) for the same instant. Absent on records written before
   * this field existed, and treated as unqueryable at check time when a live query
   * returns null — both cases DEFER to the live pid rather than take over (#56).
   */
  readonly startTime?: string;
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

/** Injectable OS start-time query (so the decision logic never shells out in tests). */
export type StartTimeFn = (pid: number) => string | null;

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

/**
 * The pid's OS process start-time canonicalized to a **path-independent** value:
 * integer epoch milliseconds, as a decimal string (or null if the process is gone /
 * unqueryable). This is the ONLY per-OS code in the liveness path: it shells out via
 * `node:child_process` (kept electron-free so the seam survives a future Tauri/Rust
 * port). Recorded once at claim and re-queried on every liveness check; a mismatch
 * means the pid was recycled (§8.1, #56).
 *
 * Every source is normalized to the SAME absolute scale (UTC epoch-ms) so two
 * queries of the same live pid agree even when they take DIFFERENT paths — the
 * bug behind #56, where a `wmic` claim and a later CIM re-query of the same
 * process produced unequal source-tagged strings and triggered a false take-over.
 * A process start is one instant; every path reports that one instant; flooring
 * to ms makes them agree.
 *
 * - Windows: `wmic process where processid=<pid> get CreationDate` — fast
 *   (~150 ms), present on this Win11 box; falls back to a `Get-CimInstance`
 *   `.CreationDate.ToFileTimeUtc()` (~600 ms) if wmic has been removed.
 * - macOS: `ps -o lstart= -p <pid>` — a fixed-width absolute start timestamp,
 *   stable across calls for a live process. (Verified on a Mac later; correct here.)
 *
 * Any spawn failure / timeout / empty result ⇒ null (process gone or command
 * unavailable), which liveness treats as "defer, don't take over" (#56).
 */
export function queryProcessStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') return queryWindowsStartTime(pid);
    return parsePsLstart(runCapture('ps', ['-o', 'lstart=', '-p', String(pid)]));
  } catch {
    return null; // process gone, command unavailable, or the query timed out
  }
}

/**
 * Bound on each start-time shell-out (ms). `queryProcessStartTime` is `await`ed in
 * the launcher's `app.on('ready')`, so a hung `wmic`/`powershell` would block launch
 * forever without this. On timeout `execFileSync` throws → the query returns null
 * (unqueryable), which the liveness logic treats as "defer, don't take over" (#56).
 */
const START_TIME_QUERY_TIMEOUT_MS = 2500;

/** Run a command and capture trimmed stdout; throws on non-zero exit / spawn error / timeout. */
function runCapture(cmd: string, args: readonly string[]): string {
  return execFileSync(cmd, args as string[], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: START_TIME_QUERY_TIMEOUT_MS,
  }).trim();
}

/**
 * Windows: wmic CreationDate, with a PowerShell CIM fallback if wmic is absent.
 * Both paths canonicalize to UTC epoch-ms, so a claim recorded via one path and a
 * later re-query via the other compare equal for the same live pid (#56).
 */
function queryWindowsStartTime(pid: number): string | null {
  try {
    return parseWmicCreationDate(runCapture('wmic', ['process', 'where', `processid=${pid}`, 'get', 'CreationDate']));
  } catch {
    // wmic is deprecated and removable on recent Windows — fall back to CIM.
    const out = runCapture('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate.ToFileTimeUtc()`,
    ]);
    return parseFileTimeUtc(out);
  }
}

/** FileTime epoch (1601-01-01 UTC) to Unix epoch offset, in 100-ns ticks. */
const FILETIME_EPOCH_OFFSET_TICKS = 116444736000000000n;

/**
 * Parse `wmic ... get CreationDate` output to canonical UTC epoch-ms (decimal
 * string). The command prints a header line then a WMI datetime
 * `YYYYMMDDHHMMSS.ffffff±ooo` (local wall-clock + a UTC offset in MINUTES), e.g.
 * `20260703124451.272290-420`. We read the local datetime, subtract the offset to
 * reach UTC, and floor to whole ms — so this agrees with the FileTimeUtc path for
 * the SAME process instant (#56).
 */
export function parseWmicCreationDate(out: string): string | null {
  for (const line of out.split(/\r?\n/)) {
    const v = line.trim();
    if (!v || v.toLowerCase() === 'creationdate') continue; // skip header / blanks
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d+)([+-]\d+)$/.exec(v);
    if (!m) continue;
    const [, yr, mo, day, hr, min, sec, frac, offset] = m;
    // The fractional field is microseconds (6 digits); take its ms part.
    const ms = Math.floor(Number(`0.${frac}`) * 1000);
    // Treat the wall-clock fields as UTC, then remove the reported UTC offset.
    const utcMs = Date.UTC(
      Number(yr), Number(mo) - 1, Number(day),
      Number(hr), Number(min), Number(sec), ms,
    );
    const offsetMs = Number(offset) * 60_000; // offset is in minutes
    return String(utcMs - offsetMs);
  }
  return null;
}

/**
 * Parse a PowerShell `.ToFileTimeUtc()` value (int64 of 100-ns ticks since
 * 1601-01-01 UTC) to canonical UTC epoch-ms (decimal string). BigInt keeps full
 * precision through the epoch shift before flooring to ms, so this agrees with the
 * wmic path for the same instant (#56).
 */
export function parseFileTimeUtc(out: string): string | null {
  const v = out.trim();
  if (!/^\d+$/.test(v)) return null;
  const ms = (BigInt(v) - FILETIME_EPOCH_OFFSET_TICKS) / 10000n; // 100-ns ticks → ms (floor)
  return String(ms);
}

/**
 * Parse macOS `ps -o lstart= -p <pid>` — a fixed-format absolute start time like
 * `Mon Jan 15 09:30:00 2024` (local time) — to canonical UTC epoch-ms (decimal
 * string). `ps` reports whole-second resolution, so no sub-ms handling is needed.
 */
export function parsePsLstart(out: string): string | null {
  const v = out.trim().replace(/\s+/g, ' ');
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : String(ms);
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

/**
 * True iff a project has a LIVE owner: a record present, on this host, whose pid
 * `alive(pid)` AND whose current OS start-time still matches the one recorded at
 * claim (§8.1, #56). A dead pid OR a start-time mismatch (recycled pid) ⇒ not live.
 *
 * Tolerant of a legacy record with no `startTime` (written before this field
 * existed): with nothing to compare against we cannot detect reuse, so we fall
 * back to the still-reliable pid-alive check alone. A live pid never reads as dead
 * either way; the only residual risk is a recycled pid on such an old record
 * looking alive, which is self-healing (the next clean claim rewrites the record
 * WITH a start-time). New records always carry `startTime`, so this is transient.
 */
export function isProjectLive(
  runtimeDir: string,
  alive: AliveFn = isProcessAlive,
  startTime: StartTimeFn = queryProcessStartTime,
): boolean {
  const owner = readProjectOwner(runtimeDir);
  if (!owner || owner.host !== os.hostname() || !alive(owner.pid)) return false;
  return ownerStartTimeMatches(owner, startTime);
}

/**
 * Should we treat the owner's (already-alive) pid as the real live owner and defer?
 * Called only after `alive(owner.pid)` has passed, so it decides the ambiguous
 * "alive but is it really the same process?" case.
 *
 * Returns true (⇒ DEFER / hand off) unless there is a DEFINITE mismatch — both the
 * recorded start-time AND a freshly-queried one present and unequal, i.e. the pid
 * was recycled to an unrelated process. Every other case defers:
 *  - owner.startTime missing (legacy record) — nothing to compare.
 *  - the live query returns null (query failed / timed out / process momentarily
 *    unqueryable) — a transient failure must NOT trigger a take-over of a pid that
 *    is provably alive, or #56's duplicate window returns.
 * Only a concrete canonical mismatch ⇒ false ⇒ take over.
 */
function ownerStartTimeMatches(owner: ProjectOwner, startTime: StartTimeFn): boolean {
  if (owner.startTime === undefined) return true; // legacy record — nothing to compare
  const live = startTime(owner.pid);
  if (live === null) return true; // unqueryable now — defer to the live pid, never take over (#56)
  return live === owner.startTime; // definite mismatch ⇒ recycled pid ⇒ take over
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
  /** PID-existence probe (fast short-circuit before the start-time query). */
  alive?: AliveFn;
  /**
   * Query a pid's current OS start-time (default: the real `queryProcessStartTime`).
   * Injected so tests are deterministic and never actually shell out. This is the
   * PID-reuse guard: a recycled-but-unrelated PID looks alive to `alive`, but its
   * OS start-time differs from the one in `owner.json`, so it reads as dead.
   */
  queryStartTime?: StartTimeFn;
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
 * ambiguous one pays for the OS start-time query:
 *  - no `owner.json`        → claim it (exclusive `wx`/`O_EXCL` create; a racing
 *                             launch loses with `EEXIST`, loops, and re-evaluates).
 *  - recorded PID is dead   → stale → take over immediately.
 *  - recorded PID is alive  → could be the real owner OR an unrelated process
 *                             that recycled the PID after a hard kill. Disambiguate
 *                             by matching the pid's current OS start-time against the
 *                             one recorded at claim: match ⇒ real owner (defer);
 *                             mismatch (recycled) ⇒ take over. Both signals are
 *                             OS-answered, so they stay truthful even while the owner
 *                             is blocked in a native modal (§8.1, #56).
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
  const queryStartTime = deps.queryStartTime ?? queryProcessStartTime;
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
    // Our own OS start-time, so a later launch can tell us apart from a process
    // that recycles our pid after we die (null only if the query is unavailable).
    startTime: queryStartTime(process.pid) ?? undefined,
    appVersion: opts.appVersion,
  };

  for (;;) {
    const existing = readProjectOwner(runtimeDir);
    if (existing && existing.host === self.host && existing.pid !== self.pid && alive(existing.pid)) {
      // PID exists — but a recycled PID would too. The recorded OS start-time tells
      // the real owner from an unrelated process that reused the PID: only the real
      // owner still has the same start-time. (A legacy record with no start-time
      // can't be disambiguated — defer to it, since its pid is alive.)
      if (ownerStartTimeMatches(existing, queryStartTime)) {
        return { owned: false, owner: existing, dropDir: runtimeDir };
      }
      // PID alive but start-time differs → recycled/stale; fall through and take over.
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

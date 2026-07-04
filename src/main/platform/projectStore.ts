/**
 * ProjectStore — the durable-home seam member (PRD §7 layout, §8.4 derivation,
 * §9 seam).
 *
 * This is the piece that knows *where a project lives on disk* and *what its
 * durable record is*. It owns:
 *  - home-path derivation from the project name (§8.4): a deterministic,
 *    collision-free, filesystem-safe token under `<baseDir>/`;
 *  - the on-disk layout (§7): `<home>/project.json` (durable) and
 *    `<home>/runtime/` (ephemeral coordination — ownership + channel);
 *  - reading/writing/materializing `project.json` (§7.1, PF3).
 *
 * It sits ABOVE `project.ts` (owner.json liveness) and `channel.ts` (file-drop
 * messaging): those operate on a plain directory and know nothing about the home
 * layout or the durable record. `projectStore` derives the `runtimeDir` they act
 * on and composes the two into the durable concept.
 *
 * Deliberately Electron-free (like the rest of the seam): the projects-home
 * `baseDir` is passed in, never resolved from `app.getPath` here. `index.ts`
 * supplies it (lazily, from `userData/projects`); tests inject a temp dir.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Durable-record format version — bumped only on a breaking `project.json` change. */
export const PROJECT_SCHEMA_VERSION = 1;

/** Session-record format version — bumped only on a breaking `session.json` change (§7.1). */
export const SESSION_SCHEMA_VERSION = 1;

/** The session filename inside a home (§7). */
export const SESSION_FILE = 'session.json';

/** The durable identity/metadata record at `<home>/project.json` (§7.1). */
export interface ProjectRecord {
  /** Format version for forward migration. */
  readonly schemaVersion: number;
  /** Identity + display label (spaces allowed). */
  readonly name: string;
  /** When the home was first materialized (epoch ms). */
  readonly createdAt: number;
  /** App version that created/last-wrote the record (debugging). */
  readonly appVersion?: string;
}

/** The resolved on-disk locations for one project. */
export interface ProjectPaths {
  /** The durable project home, `<baseDir>/<derived>/` (§7). */
  readonly homeDir: string;
  /** The ephemeral coordination dir, `<home>/runtime/` — release (PF8) clears ONLY this. */
  readonly runtimeDir: string;
  /** The durable identity record, `<home>/project.json`. */
  readonly recordPath: string;
}

/**
 * The durable session record at `<home>/session.json` (§7, §8.6, PF19). A
 * separately-versioned record under the same tolerant discipline as
 * `project.json`. Persisted continuously as tabs open/close/switch — purely a
 * crash safety net, only ever read back after a dirty shutdown (Slice B).
 */
export interface SessionRecord {
  /** Format version for forward migration. */
  readonly schemaVersion: number;
  /** Absolute paths of the open tabs, in tab order. */
  readonly files: readonly string[];
  /** Index of the active tab within `files`, or -1 when none is active. */
  readonly activeIndex: number;
  /**
   * False while the window is running; set true on a clean shutdown. A whole-app
   * crash never rewrites it, so `cleanExit:false` surviving to the next launch is
   * the dirty-shutdown signal (§8.6). This slice only WRITES it; nothing reads it.
   */
  readonly cleanExit: boolean;
}

/** The runtime subdirectory name inside a home (§7). */
export const RUNTIME_DIR = 'runtime';
/** The durable identity record filename (§7). */
export const PROJECT_FILE = 'project.json';

/**
 * Validate a project name as a launch key. Names MAY contain spaces (PF1), but
 * must stay traversal-safe — the derivation (below) is what makes them
 * filesystem-safe, but a name that is itself a path fragment is rejected outright
 * as a caller error rather than silently sanitized away. Mirrors the guard the
 * old `projectDir` applied, minus the charset restriction (the hash suffix now
 * handles unusual characters).
 */
function assertSafeName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('project name must be a non-empty string');
  }
  if (name === '.' || name === '..') {
    throw new Error(`unsafe project name ${JSON.stringify(name)} — cannot be "." or ".."`);
  }
  // Path separators and control chars would let a name steer the derived path or
  // break the filesystem; the derivation intentionally does not "rescue" these.
  // (Control chars are checked by code point rather than a regex, so no literal
  // control bytes end up in this source file.)
  const hasControlChar = [...name].some((ch) => ch.charCodeAt(0) < 0x20);
  if (/[/\\]/.test(name) || hasControlChar) {
    throw new Error(`unsafe project name ${JSON.stringify(name)} — no path separators or control characters`);
  }
}

/**
 * Derive the home directory *token* from a project name (§8.4):
 * `<sanitized>-<first 8 hex of sha256(name)>`.
 *
 * The sanitized prefix keeps the directory human-recognizable; the hash suffix
 * guarantees uniqueness/collision-freeness and filesystem-safety even for names
 * with spaces or unusual characters. Deterministic: same name ⇒ same token.
 */
/** Max length of the human-readable slug before the `-<hash>` suffix (defense against ENAMETOOLONG). */
const SLUG_MAX_LEN = 64;

export function deriveDirName(name: string): string {
  assertSafeName(name);
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-') // collapse any run of disallowed chars to a single '-'
    .replace(/^-+|-+$/g, '') // trim leading/trailing '-'
    .replace(/^\.+/, ''); // trim leading dots so the slug alone can never be "."/".."/"..."
  // Cap the slug so a pathologically long name can't produce a >255-char path
  // component (ENAMETOOLONG). Uniqueness is unaffected: the hash is over the FULL
  // raw name below, not the truncated slug.
  const slug = sanitized.length > 0 ? sanitized.slice(0, SLUG_MAX_LEN) : 'p';
  const hash = createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}

/** Resolve the full set of on-disk paths for a project under `baseDir` (§7, §8.4). */
export function projectPaths(baseDir: string, name: string): ProjectPaths {
  const homeDir = path.join(baseDir, deriveDirName(name));
  return {
    homeDir,
    runtimeDir: path.join(homeDir, RUNTIME_DIR),
    recordPath: path.join(homeDir, PROJECT_FILE),
  };
}

/**
 * Tolerant, versioned parse of a `project.json` (§7.1) — unknown fields ignored,
 * missing fields defaulted, mirroring `protocol.ts`'s additive discipline. Only
 * `name` is load-bearing; a record missing it is treated as unusable (null).
 */
export function parseProjectRecord(raw: unknown): ProjectRecord | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || r.name.length === 0) return null;
  return {
    schemaVersion: typeof r.schemaVersion === 'number' ? r.schemaVersion : PROJECT_SCHEMA_VERSION,
    name: r.name,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
    ...(typeof r.appVersion === 'string' ? { appVersion: r.appVersion } : {}),
  };
}

/** Read and validate `<home>/project.json`; null if absent/unreadable/garbage. */
export function readProjectRecord(recordPath: string): ProjectRecord | null {
  try {
    return parseProjectRecord(JSON.parse(fs.readFileSync(recordPath, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Exclusively create `recordPath` with `record`, or adopt an existing record if a
 * racer beat us to it. This is the first-writer-wins primitive behind
 * `materializeProjectRecord` — factored out so the race branch is unit-testable.
 *
 * The create uses an O_EXCL open (`'wx'`), mirroring `acquireProject`'s claim of
 * `owner.json`. This matters on Windows: `fs.renameSync` there SILENTLY OVERWRITES
 * an existing target rather than throwing, so a rename-over would let a later
 * racing launch clobber the earlier one's `createdAt`. `'wx'` fails hard with
 * `EEXIST` if the file exists, so the first writer's record — and its `createdAt`
 * — is preserved on both Windows and POSIX; a loser re-reads and adopts it.
 */
export function createOrAdoptRecord(recordPath: string, record: ProjectRecord): ProjectRecord {
  let fd: number;
  try {
    fd = fs.openSync(recordPath, 'wx'); // O_EXCL — throws EEXIST if a racer already created it
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // A racer created the record between our read and this create — adopt theirs
      // (preserving their createdAt), the point of reuse. Fall back to ours only if
      // it somehow re-reads as unusable, which is not expected.
      return readProjectRecord(recordPath) ?? record;
    }
    throw err;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify(record, null, 2));
  } finally {
    fs.closeSync(fd);
  }
  return record;
}

/**
 * Materialize-or-reuse the durable record (PF3): create `<home>/project.json` if
 * absent, otherwise keep the existing one untouched — crucially, never clobber
 * `createdAt`. Returns the record now on disk.
 *
 * The home dir is created if needed. Only the durable record is touched here; the
 * `runtime/` dir is created lazily by the ownership/channel layer on claim.
 */
export function materializeProjectRecord(
  paths: ProjectPaths,
  name: string,
  opts: { appVersion?: string } = {},
): ProjectRecord {
  fs.mkdirSync(paths.homeDir, { recursive: true });
  const existing = readProjectRecord(paths.recordPath);
  if (existing) return existing; // reuse — preserves createdAt

  const record: ProjectRecord = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    name,
    createdAt: Date.now(),
    ...(opts.appVersion ? { appVersion: opts.appVersion } : {}),
  };
  // Create exclusively (first-writer-wins). A launch that lost the race between
  // the read above and this create adopts the winner's record — never clobbers it.
  return createOrAdoptRecord(paths.recordPath, record);
}

// --- Session record (§7, §8.6, PF19) ---------------------------------------

/**
 * Tolerant, versioned parse of a `session.json` (§7.1 discipline) — unknown
 * fields ignored, missing fields defaulted. `files` is the only structurally
 * load-bearing field: a record whose `files` is not an array of strings is
 * unusable (null), since a garbage open-set is worse than none. `activeIndex`
 * defaults to -1 (no active tab) and `cleanExit` defaults to true (a record we
 * cannot trust the flag on should NOT masquerade as a crash).
 */
export function parseSessionRecord(raw: unknown): SessionRecord | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.files) || !r.files.every((f) => typeof f === 'string')) return null;
  return {
    schemaVersion: typeof r.schemaVersion === 'number' ? r.schemaVersion : SESSION_SCHEMA_VERSION,
    files: r.files as string[],
    activeIndex: typeof r.activeIndex === 'number' ? r.activeIndex : -1,
    // A missing/garbage flag defaults to clean, so only an explicit `false` — the
    // value a running window writes — is ever read as a dirty shutdown (Slice B).
    cleanExit: typeof r.cleanExit === 'boolean' ? r.cleanExit : true,
  };
}

/**
 * Read and validate `<home>/session.json`; null if absent/unreadable/garbage.
 * (Slice A does not act on this; it exists to make `writeSession` round-trippable
 * and unit-testable, and is the surface Slice B's restore path will consume.)
 */
export function readSession(homeDir: string): SessionRecord | null {
  try {
    return parseSessionRecord(JSON.parse(fs.readFileSync(path.join(homeDir, SESSION_FILE), 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Write `<home>/session.json` atomically (temp file, then rename over), mirroring
 * `writeOwnerAtomic` in project.ts: a partial write from a crash mid-save can
 * never leave a truncated record readers would parse as a real (empty) session.
 * The temp uses a `.swap` suffix — NOT `.tmp` — so it lives in the home, not the
 * runtime dir, and shares no namespace with the channel's stale-`.tmp` reaper.
 * The home dir is created if needed.
 */
export function writeSession(homeDir: string, record: SessionRecord): void {
  fs.mkdirSync(homeDir, { recursive: true });
  const tmp = path.join(homeDir, `${SESSION_FILE}.${process.pid}.${process.hrtime.bigint()}.swap`);
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, path.join(homeDir, SESSION_FILE));
}

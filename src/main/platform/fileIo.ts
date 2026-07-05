/**
 * Node-backed file IO for the platform seam (file IO and saving &
 * conflict handling). Pure helpers +
 * thin fs wrappers, kept separate from the bridge factory so they're unit-
 * testable. All OS access for files lives here.
 */
import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileSnapshot, OpenRequest } from './index';

/** SHA-256 (hex) of UTF-8 content — the baseline used for conflict detection. */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Split a trailing `:<line>[:<col>]` reveal suffix off a CLI file argument (the
 * editor `path:line[:col]` convention — open at a specific line). Returns the bare
 * path and, if present, the 1-based line; a column is accepted and ignored.
 *
 * Only a colon **followed by digits at the very end** is treated as the
 * separator, so a Windows drive letter stays intact: `C:\Users\me\notes.md:120`
 * → `{ path: 'C:\Users\me\notes.md', line: 120 }`, while `C:\Users\me\notes.md`
 * (no trailing digits) → `{ path: 'C:\Users\me\notes.md' }`. The leading match is
 * lazy so the path grows only until such a suffix is found.
 */
export function splitLineSuffix(arg: string): { path: string; line?: number } {
  const m = /^(.+?):(\d+)(?::\d+)?$/.exec(arg);
  return m ? { path: m[1], line: Number(m[2]) } : { path: arg };
}

/**
 * Pick the files to open from a process argv (`galley <file> [file …]`).
 *
 * Returns EVERY non-flag argument, each resolved to an absolute path (with an
 * optional 1-based reveal line parsed from a `path:line` suffix), in command-line
 * order — so `galley a.md b.md c.md` opens all three. Skips the executable (and,
 * in dev, the app-path argv[1]) and known value-taking flags (`--project <name>`
 * also skips its value); other flags (`--devtools`, `--help`, `-h`) are simply
 * ignored. `packaged` distinguishes a packaged launch (`galley.exe …`) from a dev
 * launch (`electron . …`). Returns an empty array when no file was given.
 */
export function parseCliFileArgs(argv: readonly string[], packaged: boolean): OpenRequest[] {
  const rest = argv.slice(packaged ? 1 : 2);
  const files: OpenRequest[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('-')) {
      if (arg === '--project') i++; // skip its name value
      continue;
    }
    const { path: rawPath, line } = splitLineSuffix(arg);
    files.push(line === undefined ? { path: path.resolve(rawPath) } : { path: path.resolve(rawPath), line });
  }
  return files;
}

/**
 * Resolve a local-file link clicked in the preview to an absolute path.
 * `href` is the link target, `fromPath` the absolute path of the document it was
 * clicked in. Drops any `#fragment`, percent-decodes, accepts `file://` URLs, and
 * resolves a relative path against the source document's folder. Returns null for
 * an empty/unusable href.
 */
export function resolveLocalLink(href: string, fromPath: string): string | null {
  let target = href.split('#')[0]; // a fragment is not part of the path
  if (!target) return null;
  try {
    target = decodeURIComponent(target);
  } catch {
    /* keep the raw href if it isn't valid percent-encoding */
  }
  if (/^file:\/\//i.test(target)) {
    try {
      return fileURLToPath(target);
    } catch {
      return null;
    }
  }
  return path.isAbsolute(target) ? target : path.resolve(path.dirname(fromPath), target);
}

/**
 * Pick the project name from a process argv: `galley --project <name> …`
 * or `--project=<name>`. The name identifies the project whose window this file
 * belongs to; the app derives the durable home from it (see
 * `projectStore.ts#deriveDirName`). Returns null when no project was passed.
 */
export function parseCliProjectArg(argv: readonly string[], packaged: boolean): string | null {
  const rest = argv.slice(packaged ? 1 : 2);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--project' && i + 1 < rest.length) return rest[i + 1];
    if (rest[i].startsWith('--project=')) return rest[i].slice('--project='.length);
  }
  return null;
}

/** Read a file as UTF-8 and capture its baseline hash. */
export async function readFile(absPath: string): Promise<FileSnapshot> {
  const content = await fsReadFile(absPath, 'utf8');
  return { path: absPath, content, hash: hashContent(content) };
}

/**
 * Write UTF-8 content and return the new snapshot (its hash becomes the new
 * baseline). The disk-vs-baseline guard is the caller's responsibility and
 * is added with the watcher in a later phase.
 */
export async function writeFile(absPath: string, content: string): Promise<FileSnapshot> {
  await fsWriteFile(absPath, content, 'utf8');
  return { path: absPath, content, hash: hashContent(content) };
}

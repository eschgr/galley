/**
 * Node-backed file IO for the platform seam (PRD §5.2, §5.6). Pure helpers +
 * thin fs wrappers, kept separate from the bridge factory so they're unit-
 * testable. All OS access for files lives here.
 */
import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileSnapshot } from './index';

/** SHA-256 (hex) of UTF-8 content — the baseline used for conflict detection. */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Pick the file paths to open from a process argv (R7: `mdtool <file> [file …]`).
 *
 * Returns EVERY non-flag argument, each resolved to absolute, in command-line
 * order — so `mdtool a.md b.md c.md` opens all three. Skips the executable (and,
 * in dev, the app-path argv[1]) and known value-taking flags (`--channel <addr>`
 * also skips its value); other flags (`--devtools`, `--help`, `-h`) are simply
 * ignored. `packaged` distinguishes a packaged launch (`mdtool.exe …`) from a dev
 * launch (`electron . …`). Returns an empty array when no file was given.
 */
export function parseCliFileArgs(argv: readonly string[], packaged: boolean): string[] {
  const rest = argv.slice(packaged ? 1 : 2);
  const files: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('-')) {
      if (arg === '--channel') i++; // skip its address value
      continue;
    }
    files.push(path.resolve(arg));
  }
  return files;
}

/**
 * Resolve a local-file link clicked in the preview (R4) to an absolute path.
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
 * Pick the channel address from a process argv (R11): `mdtool --channel <addr> …`
 * or `--channel=<addr>`. The address is whatever the caller chose (a named pipe
 * on Windows, a Unix-domain socket path on macOS); the app just listens on it.
 * Returns null when no channel was passed.
 */
export function parseCliChannelArg(argv: readonly string[], packaged: boolean): string | null {
  const rest = argv.slice(packaged ? 1 : 2);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--channel' && i + 1 < rest.length) return rest[i + 1];
    if (rest[i].startsWith('--channel=')) return rest[i].slice('--channel='.length);
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
 * baseline). The disk-vs-baseline guard (R34) is the caller's responsibility and
 * is added with the watcher in a later phase.
 */
export async function writeFile(absPath: string, content: string): Promise<FileSnapshot> {
  await fsWriteFile(absPath, content, 'utf8');
  return { path: absPath, content, hash: hashContent(content) };
}

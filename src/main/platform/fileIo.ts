/**
 * Node-backed file IO for the platform seam (PRD §5.2, §5.6). Pure helpers +
 * thin fs wrappers, kept separate from the bridge factory so they're unit-
 * testable. All OS access for files lives here.
 */
import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { FileSnapshot } from './index';

/** SHA-256 (hex) of UTF-8 content — the baseline used for conflict detection. */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Pick the file path to open from a process argv (R7: `mdtool <file>`).
 *
 * Returns the first non-flag argument (resolved to absolute), or null. Skips the
 * executable (and, in dev, the app-path argv[1]) and known value-taking flags
 * (`--channel <addr>`). `packaged` distinguishes a packaged launch
 * (`mdtool.exe <file>`) from a dev launch (`electron . <file>`).
 */
export function parseCliFileArg(argv: readonly string[], packaged: boolean): string | null {
  const rest = argv.slice(packaged ? 1 : 2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('-')) {
      if (arg === '--channel') i++; // skip its address value
      continue;
    }
    return path.resolve(arg);
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

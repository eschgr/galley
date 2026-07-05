/**
 * Startup-file loading (open a file via CLI argument; multiple files).
 *
 * Resolves the command-line file paths into snapshots, in command-line order:
 * each path is read and — on success — watched; an unreadable path is reported
 * via `onError` and skipped, never aborting the rest. Extracted from main.ts's
 * `file:getStartup` handler so the read / watch / skip-on-error / ordering logic
 * is unit-testable without booting Electron (mirrors registerAppVersionIpc).
 */
import type { FileSnapshot } from './platform';

export async function readStartupFiles(
  paths: readonly string[],
  read: (absPath: string) => Promise<FileSnapshot>,
  watch: (absPath: string) => void,
  onError: (absPath: string, err: unknown) => void,
): Promise<FileSnapshot[]> {
  const snapshots: FileSnapshot[] = [];
  for (const absPath of paths) {
    try {
      const snapshot = await read(absPath);
      watch(absPath); // only watch what we could actually read
      snapshots.push(snapshot);
    } catch (err) {
      onError(absPath, err); // surfaced (a dialog in main) and skipped
    }
  }
  return snapshots;
}

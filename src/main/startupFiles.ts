/**
 * Startup-file loading (open a file via CLI argument; multiple files).
 *
 * Resolves the command-line open requests into snapshots, in command-line order:
 * each path is read and — on success — watched; an unreadable path is reported
 * via `onError` and skipped, never aborting the rest. A request's optional reveal
 * line (open at a specific line) rides through onto its snapshot, so the renderer
 * can reveal it. Extracted from main.ts's `file:getStartup` handler so the read /
 * watch / skip-on-error / ordering logic is unit-testable without booting Electron.
 */
import type { FileSnapshot, OpenRequest } from './platform';

/** A read startup file plus its optional one-shot reveal line (open at a line). */
export type StartupFile = FileSnapshot & { readonly line?: number };

export async function readStartupFiles(
  requests: readonly OpenRequest[],
  read: (absPath: string) => Promise<FileSnapshot>,
  watch: (absPath: string) => void,
  onError: (absPath: string, err: unknown) => void,
): Promise<StartupFile[]> {
  const files: StartupFile[] = [];
  for (const req of requests) {
    try {
      const snapshot = await read(req.path);
      watch(req.path); // only watch what we could actually read
      files.push(req.line === undefined ? snapshot : { ...snapshot, line: req.line });
    } catch (err) {
      onError(req.path, err); // surfaced (a dialog in main) and skipped
    }
  }
  return files;
}

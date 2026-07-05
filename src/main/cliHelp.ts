/**
 * `--help` / `-h` output.
 *
 * The help text itself lives in the sibling raw file `cliHelp.txt` (imported
 * with Vite's `?raw`, like welcome.md), so it reads as plain prose with no
 * string-escaping noise and is easy to find/edit. It is written for an LLM (e.g.
 * Claude) told only that "Galley exists" and to read its help before driving the
 * app — keep it in sync with the launcher contract.
 * The `--project <name>` contract here MUST match the CLI parsing in
 * src/main/platform/fileIo.ts and the self-arbitration flow in src/main.ts.
 */
import helpText from './cliHelp.txt?raw';

/** Placeholder in cliHelp.txt replaced with the running version. */
const VERSION_TOKEN = '{{VERSION}}';

/** True when the argv asks for help (`--help` or `-h`, anywhere in the list). */
export function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

/** The full `--help` text, with the running version interpolated. */
export function buildCliHelp(version: string): string {
  return helpText.replace(VERSION_TOKEN, version);
}

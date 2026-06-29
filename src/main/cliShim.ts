/**
 * Windows `galley` command shim (issue #42).
 *
 * Squirrel installs the app to a versioned `app-x.y.z\` dir that changes on every
 * update, so there is no stable exe path to put on PATH. But Squirrel runs the
 * app with a lifecycle flag ON every install/update, so we simply (re)write a
 * tiny `galley.cmd` forwarder pointing at the CURRENT exe each time.
 *
 * It is written into `%LOCALAPPDATA%\Microsoft\WindowsApps`, which is on the user
 * PATH by default — so there is NO PATH editing (the fiddliest, most failure-prone
 * part). It is removed on uninstall. (If that location proves unreliable in a real
 * install, the fallback is a dedicated `bin` dir added to PATH once.)
 *
 * The forwarder launches a fresh `Galley.exe` per call; the app self-arbitrates —
 * claims the project or hands its files off (PRD §5.3). `.cmd` resolves as
 * `galley` in cmd/PowerShell; Git Bash resolution is a known gap (run via
 * PowerShell, or add a no-extension script later).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SHIM_NAME = 'galley.cmd';

/** `%LOCALAPPDATA%` (env, with a home-dir fallback). */
function localAppData(): string {
  return process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
}

/** The on-PATH directory the shim lives in (`…\Microsoft\WindowsApps`, on PATH by default). */
export function shimDir(base: string = localAppData()): string {
  return path.join(base, 'Microsoft', 'WindowsApps');
}

/** Absolute path of `galley.cmd`. */
export function shimPath(base: string = localAppData()): string {
  return path.join(shimDir(base), SHIM_NAME);
}

/**
 * `galley.cmd` contents: forward every argument verbatim to `exePath`. `%*`
 * preserves the caller's quoting (e.g. a path with spaces); the exe path itself
 * is quoted so its own spaces are safe.
 */
export function shimContents(exePath: string): string {
  return `@echo off\r\n"${exePath}" %*\r\n`;
}

/** Write/refresh the shim to point at `exePath`. Idempotent — safe on install AND each update. */
export function installCliShim(exePath: string, base: string = localAppData()): void {
  fs.mkdirSync(shimDir(base), { recursive: true });
  fs.writeFileSync(shimPath(base), shimContents(exePath));
}

/** Remove the shim (uninstall). No-op if it is already gone. */
export function removeCliShim(base: string = localAppData()): void {
  try {
    fs.unlinkSync(shimPath(base));
  } catch {
    /* already absent — fine */
  }
}

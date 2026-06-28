import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shimDir, shimPath, shimContents, installCliShim, removeCliShim } from './cliShim';

// A temp stand-in for %LOCALAPPDATA% so the install/remove tests don't touch the
// real one. The pure helpers (path + contents) need no fs.
const made: string[] = [];
function fakeLocalAppData(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'galley-shim-test-'));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('shim path', () => {
  it('lives in Microsoft\\WindowsApps as galley.cmd (on PATH by default)', () => {
    const base = 'C:\\Users\\me\\AppData\\Local';
    expect(shimDir(base)).toBe(path.join(base, 'Microsoft', 'WindowsApps'));
    expect(shimPath(base)).toBe(path.join(base, 'Microsoft', 'WindowsApps', 'galley.cmd'));
  });
});

describe('shim contents', () => {
  it('forwards all args to the (quoted) exe', () => {
    const out = shimContents('C:\\Users\\me\\AppData\\Local\\Galley\\app-1.2.3\\Galley.exe');
    expect(out).toContain('"C:\\Users\\me\\AppData\\Local\\Galley\\app-1.2.3\\Galley.exe" %*');
    expect(out).toContain('@echo off');
  });
  it('quotes the exe so a path with spaces is safe', () => {
    expect(shimContents('C:\\Program Files\\Galley\\Galley.exe')).toContain('"C:\\Program Files\\Galley\\Galley.exe" %*');
  });
});

describe('install / remove', () => {
  it('writes the shim pointing at the current exe, creating the dir', () => {
    const base = fakeLocalAppData();
    const exe = 'C:\\path\\app-9.9.9\\Galley.exe';
    installCliShim(exe, base);
    expect(fs.existsSync(shimPath(base))).toBe(true);
    expect(fs.readFileSync(shimPath(base), 'utf8')).toContain(`"${exe}" %*`);
  });

  it('is idempotent and refreshes the target on a later update', () => {
    const base = fakeLocalAppData();
    installCliShim('C:\\path\\app-1.0.0\\Galley.exe', base);
    installCliShim('C:\\path\\app-2.0.0\\Galley.exe', base); // an "update"
    const body = fs.readFileSync(shimPath(base), 'utf8');
    expect(body).toContain('app-2.0.0\\Galley.exe');
    expect(body).not.toContain('app-1.0.0');
  });

  it('removes the shim, and tolerates removing one that is already gone', () => {
    const base = fakeLocalAppData();
    installCliShim('C:\\path\\Galley.exe', base);
    removeCliShim(base);
    expect(fs.existsSync(shimPath(base))).toBe(false);
    expect(() => removeCliShim(base)).not.toThrow(); // idempotent
  });
});

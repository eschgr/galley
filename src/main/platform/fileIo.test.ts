import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashContent, parseCliFileArg, readFile, writeFile } from './fileIo';

describe('hashContent', () => {
  it('is the sha256 hex of the utf-8 content', () => {
    expect(hashContent('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hashContent('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
  it('is deterministic and content-sensitive', () => {
    expect(hashContent('abc')).toBe(hashContent('abc'));
    expect(hashContent('abc')).not.toBe(hashContent('abd'));
  });
});

describe('parseCliFileArg', () => {
  it('returns the file arg as an absolute path (packaged launch)', () => {
    const r = parseCliFileArg(['mdtool.exe', 'notes.md'], true);
    expect(r).toBe(path.resolve('notes.md'));
    expect(path.isAbsolute(r!)).toBe(true);
  });

  it('skips the app-path argv[1] in a dev launch', () => {
    expect(parseCliFileArg(['electron.exe', '.', 'notes.md'], false)).toBe(path.resolve('notes.md'));
  });

  it('skips flags and the --channel <addr> value', () => {
    expect(parseCliFileArg(['mdtool.exe', '--devtools', 'notes.md'], true)).toBe(path.resolve('notes.md'));
    expect(parseCliFileArg(['mdtool.exe', '--channel', '\\\\.\\pipe\\x', 'notes.md'], true)).toBe(
      path.resolve('notes.md'),
    );
  });

  it('returns null when no file argument is present', () => {
    expect(parseCliFileArg(['mdtool.exe'], true)).toBeNull();
    expect(parseCliFileArg(['mdtool.exe', '--devtools'], true)).toBeNull();
  });
});

describe('readFile / writeFile round-trip', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('writes content and reads it back with a matching baseline hash', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mdtool-'));
    dirs.push(dir);
    const file = path.join(dir, 'doc.md');
    const content = '# Title\n\nBody with unicode: café ✓\n';

    const written = await writeFile(file, content);
    expect(written.path).toBe(file);
    expect(written.hash).toBe(hashContent(content));

    const read = await readFile(file);
    expect(read.content).toBe(content);
    expect(read.hash).toBe(written.hash);
  });
});

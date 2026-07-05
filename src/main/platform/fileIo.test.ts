import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashContent, parseCliFileArgs, parseCliProjectArg, readFile, resolveLocalLink, splitLineSuffix, writeFile } from './fileIo';

describe('resolveLocalLink (preview local links)', () => {
  const from = path.resolve('docs', 'index.md');

  it('resolves a relative link against the source document folder', () => {
    expect(resolveLocalLink('./sibling.md', from)).toBe(path.resolve('docs', 'sibling.md'));
    expect(resolveLocalLink('sibling.md', from)).toBe(path.resolve('docs', 'sibling.md'));
    expect(resolveLocalLink('../README.md', from)).toBe(path.resolve('README.md'));
  });

  it('drops a #fragment before resolving', () => {
    expect(resolveLocalLink('sibling.md#intro', from)).toBe(path.resolve('docs', 'sibling.md'));
  });

  it('percent-decodes the href', () => {
    expect(resolveLocalLink('my%20notes.md', from)).toBe(path.resolve('docs', 'my notes.md'));
  });

  it('returns an absolute path unchanged', () => {
    const abs = path.resolve('elsewhere', 'thing.md');
    expect(resolveLocalLink(abs, from)).toBe(abs);
  });

  it('handles a file:// URL', () => {
    if (process.platform === 'win32') {
      expect(resolveLocalLink('file:///C:/Windows/win.ini', from)).toBe('C:\\Windows\\win.ini');
    } else {
      expect(resolveLocalLink('file:///etc/hosts', from)).toBe('/etc/hosts');
    }
  });

  it('returns null for an empty or fragment-only href', () => {
    expect(resolveLocalLink('', from)).toBeNull();
    expect(resolveLocalLink('#section', from)).toBeNull();
  });
});

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

describe('splitLineSuffix (open at a specific line — path:line)', () => {
  it('splits a trailing :line off the path', () => {
    expect(splitLineSuffix('notes.md:120')).toEqual({ path: 'notes.md', line: 120 });
  });

  it('leaves a plain path unchanged (no line)', () => {
    expect(splitLineSuffix('notes.md')).toEqual({ path: 'notes.md' });
  });

  it('keeps a Windows drive letter intact — only a trailing :digits is the line', () => {
    // The drive colon (`C:`) is followed by a backslash, not the end, so it is
    // never mistaken for the line separator.
    expect(splitLineSuffix('C:\\Users\\me\\notes.md:120')).toEqual({
      path: 'C:\\Users\\me\\notes.md',
      line: 120,
    });
    expect(splitLineSuffix('C:\\Users\\me\\notes.md')).toEqual({
      path: 'C:\\Users\\me\\notes.md',
    });
  });

  it('accepts and ignores a trailing :col', () => {
    expect(splitLineSuffix('notes.md:120:8')).toEqual({ path: 'notes.md', line: 120 });
  });
});

describe('parseCliFileArgs', () => {
  it('returns the single file arg as an absolute path (packaged launch)', () => {
    const r = parseCliFileArgs(['galley.exe', 'notes.md'], true);
    expect(r).toEqual([{ path: path.resolve('notes.md') }]);
    expect(path.isAbsolute(r[0].path)).toBe(true);
  });

  it('returns EVERY file arg, in command-line order, each absolute', () => {
    expect(parseCliFileArgs(['galley.exe', 'a.md', 'b.md', 'c.md'], true)).toEqual([
      { path: path.resolve('a.md') },
      { path: path.resolve('b.md') },
      { path: path.resolve('c.md') },
    ]);
  });

  it('parses a path:line arg into an absolute path plus the 1-based line', () => {
    expect(parseCliFileArgs(['galley.exe', 'notes.md:120'], true)).toEqual([
      { path: path.resolve('notes.md'), line: 120 },
    ]);
  });

  it('resolves the path but not the drive letter when a line is appended', () => {
    // The line comes off first, so the resolved path is the real file (the
    // suffix never contaminates it) and the line rides alongside.
    const r = parseCliFileArgs(['galley.exe', 'sub/notes.md:42'], true);
    expect(r).toEqual([{ path: path.resolve('sub/notes.md'), line: 42 }]);
  });

  it('skips the app-path argv[1] in a dev launch', () => {
    expect(parseCliFileArgs(['electron.exe', '.', 'notes.md'], false)).toEqual([
      { path: path.resolve('notes.md') },
    ]);
  });

  it('skips flags and the --project <name> value, keeping the rest of the files', () => {
    expect(parseCliFileArgs(['galley.exe', '--devtools', 'notes.md'], true)).toEqual([
      { path: path.resolve('notes.md') },
    ]);
    // --project consumes its value; the files on either side still come through.
    expect(
      parseCliFileArgs(['galley.exe', 'a.md', '--project', 'pack-325', 'b.md'], true),
    ).toEqual([{ path: path.resolve('a.md') }, { path: path.resolve('b.md') }]);
  });

  it('returns an empty array when no file argument is present', () => {
    expect(parseCliFileArgs(['galley.exe'], true)).toEqual([]);
    expect(parseCliFileArgs(['galley.exe', '--devtools'], true)).toEqual([]);
  });
});

describe('parseCliProjectArg', () => {
  it('reads the --project <name> value', () => {
    expect(parseCliProjectArg(['galley.exe', '--project', 'pack-325'], true)).toBe('pack-325');
  });
  it('reads the --project=<name> form', () => {
    expect(parseCliProjectArg(['galley.exe', '--project=a1b2c3d4', 'notes.md'], true)).toBe('a1b2c3d4');
  });
  it('skips the app-path argv[1] in a dev launch', () => {
    expect(parseCliProjectArg(['electron.exe', '.', '--project', 'proj'], false)).toBe('proj');
  });
  it('returns null when no project is passed', () => {
    expect(parseCliProjectArg(['galley.exe', 'notes.md'], true)).toBeNull();
    expect(parseCliProjectArg(['galley.exe', '--project'], true)).toBeNull(); // no value
  });
});

describe('readFile / writeFile round-trip', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('writes content and reads it back with a matching baseline hash', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'galley-'));
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

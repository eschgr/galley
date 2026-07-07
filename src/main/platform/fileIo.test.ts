import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashContent, parseCliFileArgs, parseCliOperation, parseCliProjectArg, readFile, resolveLocalLink, resolveUserDataDir, splitLineSuffix, writeFile } from './fileIo';

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

describe('parseCliOperation (manage the tab set — open / --close / --set)', () => {
  it('defaults to the open verb for positional files', () => {
    expect(parseCliOperation(['galley.exe', 'a.md', 'b.md'], true)).toEqual({
      kind: 'open',
      files: [{ path: path.resolve('a.md') }, { path: path.resolve('b.md') }],
    });
  });

  it('parses --close with one or more files', () => {
    expect(parseCliOperation(['galley.exe', '--close', 'stale.md'], true)).toEqual({
      kind: 'close',
      files: [{ path: path.resolve('stale.md') }],
    });
    expect(parseCliOperation(['galley.exe', '--close', 'a.md', 'b.md'], true)).toEqual({
      kind: 'close',
      files: [{ path: path.resolve('a.md') }, { path: path.resolve('b.md') }],
    });
  });

  it('parses --set with the target file list', () => {
    expect(parseCliOperation(['galley.exe', '--set', 'a.md', 'b.md', 'c.md'], true)).toEqual({
      kind: 'set',
      files: [{ path: path.resolve('a.md') }, { path: path.resolve('b.md') }, { path: path.resolve('c.md') }],
    });
  });

  it('still skips the --project value alongside a verb', () => {
    expect(parseCliOperation(['galley.exe', '--project', 'proj', '--close', 'a.md'], true)).toEqual({
      kind: 'close',
      files: [{ path: path.resolve('a.md') }],
    });
  });

  it('--set with no files is a valid empty set (close everything)', () => {
    expect(parseCliOperation(['galley.exe', '--set'], true)).toEqual({ kind: 'set', files: [] });
  });

  it('skips the --data-dir value so it is not opened as a file', () => {
    expect(parseCliOperation(['galley.exe', '--data-dir', 'D:\\gdata', 'notes.md'], true)).toEqual({
      kind: 'open',
      files: [{ path: path.resolve('notes.md') }],
    });
  });

  it('parseCliFileArgs is the open-verb files (back-compat)', () => {
    expect(parseCliFileArgs(['galley.exe', 'a.md'], true)).toEqual([{ path: path.resolve('a.md') }]);
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

describe('resolveUserDataDir (Galley data home)', () => {
  const home = path.join(path.sep, 'home', 'greg');

  it('defaults to <home>/.galley with no override', () => {
    expect(resolveUserDataDir(['galley.exe'], true, home)).toBe(path.join(home, '.galley'));
    expect(resolveUserDataDir(['galley.exe', 'notes.md'], true, home)).toBe(path.join(home, '.galley'));
  });

  it('honors --data-dir <path>, made absolute', () => {
    expect(resolveUserDataDir(['galley.exe', '--data-dir', 'gdata'], true, home)).toBe(path.resolve('gdata'));
    expect(resolveUserDataDir(['galley.exe', '--data-dir', path.join(path.sep, 'abs', 'dir')], true, home)).toBe(
      path.resolve(path.join(path.sep, 'abs', 'dir')),
    );
  });

  it('honors the --data-dir=<path> form', () => {
    expect(resolveUserDataDir(['galley.exe', '--data-dir=gdata', 'notes.md'], true, home)).toBe(path.resolve('gdata'));
  });

  it('skips the app-path argv[1] in a dev launch', () => {
    expect(resolveUserDataDir(['electron.exe', '.', '--data-dir', 'gdata'], false, home)).toBe(path.resolve('gdata'));
    expect(resolveUserDataDir(['electron.exe', '.'], false, home)).toBe(path.join(home, '.galley'));
  });

  it('returns null when Electron\'s own --user-data-dir is passed (leave it be)', () => {
    expect(resolveUserDataDir(['galley.exe', '--user-data-dir=/x/y'], true, home)).toBeNull();
    expect(resolveUserDataDir(['galley.exe', '--user-data-dir', '/x/y'], true, home)).toBeNull();
  });

  it('prefers --data-dir over Electron\'s --user-data-dir', () => {
    expect(resolveUserDataDir(['galley.exe', '--user-data-dir=/x', '--data-dir', 'gdata'], true, home)).toBe(
      path.resolve('gdata'),
    );
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

  it('overwrites an existing file and leaves no temp file behind (atomic replace)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'galley-'));
    dirs.push(dir);
    const file = path.join(dir, 'doc.md');

    await writeFile(file, 'first\n');
    // Same byte-length as the previous content — the case that used to let a
    // rapid burst surface a torn read; the atomic replace makes it a non-issue.
    await writeFile(file, 'secnd\n');

    expect((await readFile(file)).content).toBe('secnd\n');
    // The sibling temp (`doc.md.<pid>.<n>.tmp`) must be renamed away, never left.
    const leftovers = (await readdir(dir)).filter((n) => n.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

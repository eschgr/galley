import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashContent, parseCliFileArg, parseCliChannelArg, readFile, resolveLocalLink, writeFile } from './fileIo';

describe('resolveLocalLink (preview local links, R4)', () => {
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

describe('parseCliChannelArg', () => {
  it('reads the --channel <addr> value', () => {
    expect(parseCliChannelArg(['mdtool.exe', '--channel', '\\\\.\\pipe\\galley-x'], true)).toBe(
      '\\\\.\\pipe\\galley-x',
    );
  });
  it('reads the --channel=<addr> form', () => {
    expect(parseCliChannelArg(['mdtool.exe', '--channel=/tmp/g.sock', 'notes.md'], true)).toBe('/tmp/g.sock');
  });
  it('skips the app-path argv[1] in a dev launch', () => {
    expect(parseCliChannelArg(['electron.exe', '.', '--channel', 'addr'], false)).toBe('addr');
  });
  it('returns null when no channel is passed', () => {
    expect(parseCliChannelArg(['mdtool.exe', 'notes.md'], true)).toBeNull();
    expect(parseCliChannelArg(['mdtool.exe', '--channel'], true)).toBeNull(); // no value
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

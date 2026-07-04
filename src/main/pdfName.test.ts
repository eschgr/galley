import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { defaultPdfPath } from './pdfName';

describe('defaultPdfPath (Export to PDF default)', () => {
  const docs = path.join(path.sep === '\\' ? 'C:\\Users\\me' : '/home/me', 'Documents');

  it('swaps a .md extension for .pdf, beside the source', () => {
    const src = path.join('docs', 'notes.md');
    expect(defaultPdfPath(src, docs)).toBe(path.join('docs', 'notes.pdf'));
  });

  it('swaps other markdown-ish extensions for .pdf', () => {
    expect(defaultPdfPath('a.markdown', docs)).toBe('a.pdf');
    expect(defaultPdfPath('a.mdown', docs)).toBe('a.pdf');
    expect(defaultPdfPath('a.mkd', docs)).toBe('a.pdf');
    expect(defaultPdfPath('a.txt', docs)).toBe('a.pdf');
  });

  it('matches the stripped extensions case-insensitively', () => {
    expect(defaultPdfPath('README.MD', docs)).toBe('README.pdf');
    expect(defaultPdfPath('NOTES.Markdown', docs)).toBe('NOTES.pdf');
  });

  it('appends .pdf for an unknown extension rather than swapping it', () => {
    expect(defaultPdfPath('notes.report', docs)).toBe('notes.report.pdf');
  });

  it('keeps the source folder and handles spaces in the name', () => {
    const src = path.join('my docs', 'meeting notes.md');
    expect(defaultPdfPath(src, docs)).toBe(path.join('my docs', 'meeting notes.pdf'));
  });

  it('finds the basename for native-separator paths', () => {
    // path.join re-normalizes to the host separator, so assert the native form.
    if (path.sep === '\\') {
      expect(defaultPdfPath('C:\\Users\\me\\notes.md', docs)).toBe('C:\\Users\\me\\notes.pdf');
    } else {
      expect(defaultPdfPath('/home/me/notes.md', docs)).toBe('/home/me/notes.pdf');
    }
  });

  it('falls back to Galley document.pdf in Documents when no file is open', () => {
    expect(defaultPdfPath(null, docs)).toBe(path.join(docs, 'Galley document.pdf'));
    expect(defaultPdfPath('', docs)).toBe(path.join(docs, 'Galley document.pdf'));
  });
});

import { describe, it, expect } from 'vitest';
import { classifyHref } from './linkRouting';

describe('classifyHref (preview link routing, R4)', () => {
  it('treats #fragments as in-page anchors', () => {
    expect(classifyHref('#section-a')).toBe('anchor');
    expect(classifyHref('#')).toBe('anchor');
  });

  it('treats web/mail URLs (any 2+ char scheme) as external', () => {
    expect(classifyHref('https://example.com/page')).toBe('external');
    expect(classifyHref('http://example.com')).toBe('external');
    expect(classifyHref('mailto:greg@example.com')).toBe('external');
    expect(classifyHref('tel:+15551234')).toBe('external');
    expect(classifyHref('ftp://host/file')).toBe('external');
  });

  it('treats file:// URLs as local', () => {
    expect(classifyHref('file:///C:/Windows/win.ini')).toBe('local');
    expect(classifyHref('file:///home/greg/notes.md')).toBe('local');
  });

  it('treats relative and absolute file paths as local', () => {
    expect(classifyHref('./sibling.md')).toBe('local');
    expect(classifyHref('../docs/PRD.md')).toBe('local');
    expect(classifyHref('sibling.md')).toBe('local');
    expect(classifyHref('sibling.md#intro')).toBe('local'); // path + fragment
    expect(classifyHref('/usr/local/notes.md')).toBe('local');
  });

  it('treats a Windows drive path as local, not an external "c:" scheme', () => {
    expect(classifyHref('C:\\Users\\greg\\notes.md')).toBe('local');
    expect(classifyHref('C:/Users/greg/notes.md')).toBe('local');
  });
});

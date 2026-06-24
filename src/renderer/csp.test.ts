import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The renderer's Content-Security-Policy lives in index.html. These tests guard
// the security posture the #25 change touched: remote https images are allowed
// to load, but code execution stays locked down. Parsing the meta tag keeps the
// policy honest (e.g. nobody silently re-tightens img-src or loosens script-src).
function cspDirectives(): Record<string, string> {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  if (!m) throw new Error('CSP meta tag not found in index.html');
  const directives: Record<string, string> = {};
  for (const part of m[1].split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(' ');
    directives[sp === -1 ? trimmed : trimmed.slice(0, sp)] =
      sp === -1 ? '' : trimmed.slice(sp + 1).trim();
  }
  return directives;
}

describe('renderer Content-Security-Policy (index.html)', () => {
  it('allows remote web images (http + https), plus inline data: and self (#25)', () => {
    const img = cspDirectives()['img-src'];
    expect(img).toContain("'self'");
    expect(img).toContain('data:');
    expect(img).toContain('https:');
    // a local document viewer should show whatever an image link points at,
    // incl. non-TLS / LAN hosts. 'https:' does not contain the 'http:' token,
    // so this only passes when http: is explicitly listed.
    expect(img).toContain('http:');
  });

  it('keeps code execution locked: script-src is self only', () => {
    expect(cspDirectives()['script-src']).toBe("'self'");
  });

  it('does not loosen default-src beyond self', () => {
    expect(cspDirectives()['default-src']).toBe("'self'");
  });
});

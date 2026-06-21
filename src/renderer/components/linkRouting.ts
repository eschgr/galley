/**
 * How a link clicked in the preview should be handled (PRD R4). Classification is
 * a pure function of the href so it can be unit-tested exhaustively; Preview maps
 * each kind to an action:
 *   - 'anchor'   in-page (`#heading`)        → scroll the preview to that heading
 *   - 'external' a web/mail URL (any scheme) → open in the system browser
 *   - 'local'    a file path or `file://`    → open as a tab (host resolves it)
 */
export type LinkKind = 'anchor' | 'external' | 'local';

export function classifyHref(href: string): LinkKind {
  if (href.startsWith('#')) return 'anchor';
  // `file:`/`file://` carries a scheme but is a local file.
  if (/^file:/i.test(href)) return 'local';
  // Any other explicit URL scheme — http(s), mailto, tel, ftp, custom… — is
  // external. A scheme is 2+ chars, so a Windows drive letter ("C:\…", a
  // 1-char "scheme") is NOT matched here and falls through to 'local'.
  if (/^[a-z][a-z0-9+.-]+:/i.test(href)) return 'external';
  // Everything else is a path: relative (`./a.md`, `../a.md`, `a.md`),
  // POSIX-absolute (`/a.md`), or Windows-absolute (`C:\a.md`).
  return 'local';
}

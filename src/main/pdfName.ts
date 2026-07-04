/**
 * Default Save-dialog path for Export to PDF. Pure and
 * Electron-free so it can be unit-tested cross-platform.
 *
 * The PDF defaults beside the source document, with the source's basename and
 * its markdown-ish extension swapped for `.pdf`. With no file open there is no
 * folder to sit beside, so it falls back to `Galley document.pdf` in the user's
 * Documents directory (the caller passes that in).
 */
import path from 'node:path';

/** Extensions we treat as the document's own and strip before adding `.pdf`
 *  (case-insensitive). Anything else is kept and `.pdf` is appended. */
const STRIP_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd', '.txt'];

/**
 * The path to default the Export-to-PDF Save dialog to.
 * @param srcPath the active document's path, or null on the welcome screen.
 * @param documentsDir the user's Documents folder (app.getPath('documents')).
 */
export function defaultPdfPath(srcPath: string | null, documentsDir: string): string {
  if (!srcPath) {
    return path.join(documentsDir, 'Galley document.pdf');
  }
  // Resolve the basename across both separator styles so a Windows path handed
  // to a POSIX `path` (or vice versa) still splits correctly.
  const base = srcPath.split(/[\\/]/).pop() ?? srcPath;
  const dir = srcPath.slice(0, srcPath.length - base.length);
  const ext = path.extname(base);
  const stem = STRIP_EXTENSIONS.includes(ext.toLowerCase())
    ? base.slice(0, base.length - ext.length)
    : base; // unknown extension → keep it and append `.pdf`
  return path.join(dir, `${stem}.pdf`);
}

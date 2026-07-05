// The renderer's drag-and-drop open decision, kept pure so it is testable
// without Electron or a live DataTransfer.
//
// A window drop hands us a list of File objects; the absolute path of each is
// resolved through an injected resolver (the preload's webUtils bridge — the
// renderer cannot read File.path under contextIsolation). This turns that list
// into the ordered set of paths to open: unresolvable/blank entries are dropped,
// and duplicates within a single drop collapse to one (dropping the same file
// twice in one gesture opens one tab, not two).
export function dropPaths(
  files: readonly File[],
  resolve: (file: File) => string,
): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const file of files) {
    const p = resolve(file);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    paths.push(p);
  }
  return paths;
}

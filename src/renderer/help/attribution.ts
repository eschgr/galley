/**
 * Bundled third-party attribution for the Help window (PRD R48, §10). The app is
 * MIT-licensed; this is the in-app summary of the open-source libraries it ships.
 * Forge/electron-builder produce the full per-file license notice for the
 * distributed package — this list is the human-readable acknowledgement.
 *
 * Derived from package.json dependencies and each package's declared license;
 * refresh it when dependencies change. CodeMirror and Lezer are grouped because
 * each ships as several same-licensed scoped packages.
 */
export interface Attribution {
  readonly name: string;
  readonly license: string;
}

/** The application's own license (PRD §10). */
export const APP_LICENSE = 'MIT';

export const ATTRIBUTIONS: readonly Attribution[] = [
  { name: 'Electron', license: 'MIT' },
  { name: 'React, React DOM', license: 'MIT' },
  { name: 'CodeMirror 6', license: 'MIT' },
  { name: 'Lezer', license: 'MIT' },
  { name: 'markdown-it', license: 'MIT' },
  { name: 'markdown-it-task-lists', license: 'ISC' },
  { name: 'markdown-it-texmath', license: 'MIT' },
  { name: 'KaTeX', license: 'MIT' },
  { name: 'highlight.js', license: 'BSD-3-Clause' },
  { name: 'chokidar', license: 'MIT' },
  { name: 'electron-squirrel-startup', license: 'Apache-2.0' },
];

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The macOS .pkg postinstall (#42) can only be exercised on a real macOS install,
// so pin its critical lines here as a guard against accidental edits.
const script = fs.readFileSync(
  path.join(process.cwd(), 'packaging', 'macos', 'pkg-scripts', 'postinstall'),
  'utf8',
);

describe('macOS pkg postinstall (galley PATH command)', () => {
  it('installs an executable launcher at /usr/local/bin/galley (on the default PATH)', () => {
    expect(script).toContain('/usr/local/bin/galley');
    expect(script).toMatch(/mkdir -p \/usr\/local\/bin/);
    expect(script).toMatch(/chmod\s+755/);
  });

  it('launches a fresh, detached Galley per call (self-arbitration) — not `open`', () => {
    expect(script).toContain('/Applications/Galley.app/Contents/MacOS/Galley');
    expect(script).toContain('nohup'); // detached so the shell returns / app survives
    expect(script).toContain('"$@"'); // forwards args verbatim
    expect(script).not.toContain('open -a'); // would route through blocked Apple Events (#49)
  });

  it('keeps LF line endings (it runs via /bin/sh)', () => {
    expect(script).not.toContain('\r');
  });
});

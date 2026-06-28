import { describe, it, expect } from 'vitest';
import { buildCliHelp, wantsHelp } from './cliHelp';

describe('wantsHelp', () => {
  it('is true for a bare --help or -h', () => {
    expect(wantsHelp(['galley.exe', '--help'])).toBe(true);
    expect(wantsHelp(['galley.exe', '-h'])).toBe(true);
  });

  it('is true wherever the flag sits among other args — first, middle, or last', () => {
    // first, with a full project + file invocation after it
    expect(wantsHelp(['galley.exe', '--help', '--project', 'proj', 'notes.md'])).toBe(true);
    // in the middle, between files
    expect(wantsHelp(['galley.exe', 'a.md', '-h', 'b.md'])).toBe(true);
    // last, after project + file + devtools
    expect(wantsHelp(['galley.exe', '--project', 'proj', 'notes.md', '--devtools', '--help'])).toBe(true);
    // dev-launch shape (electron . <args>)
    expect(wantsHelp(['electron.exe', '.', 'notes.md', '--help'])).toBe(true);
  });

  it('is false when neither flag is present, even amid many other args', () => {
    expect(wantsHelp(['galley.exe'])).toBe(false);
    expect(wantsHelp(['galley.exe', '--project', 'proj', 'a.md', 'b.md', '--devtools'])).toBe(false);
    // not fooled by look-alikes
    expect(wantsHelp(['galley.exe', '--helpme', 'help', '-help'])).toBe(false);
  });
});

describe('buildCliHelp', () => {
  const help = buildCliHelp('1.2.3');

  it('interpolates the running version', () => {
    expect(help).toContain('1.2.3');
  });

  // The help is the LLM-facing launcher contract — these guard against the text
  // drifting out of sync with docs/PRD.md Appendix A and the --project flow.
  it('covers the --project launcher contract', () => {
    expect(help).toContain('--project <name>'); // the single invocation
    expect(help).toContain('project'); // window keyed on the project
    expect(help).toMatch(/one window/i); // one project => one window
    expect(help).toMatch(/PID/); // explicit "do not key on PID"
  });

  it('documents multiple files and the absolute-path requirement', () => {
    expect(help).toContain('[file ...]');
    expect(help.toLowerCase()).toContain('absolute');
  });

  it('keeps the contract simple — no probe/socket/wire-protocol details to get wrong', () => {
    // The app self-arbitrates now; the caller never speaks a transport. Guard the
    // old socket/probe vocabulary from creeping back into the contract.
    expect(help).not.toContain('.sock');
    expect(help).not.toContain('NamedPipeClientStream');
    expect(help.toLowerCase()).not.toContain('newline');
    expect(help.toLowerCase()).not.toContain('connect to');
  });

  it('pins a canonical project-name recipe and flags "galley" as a placeholder', () => {
    expect(help).toContain('SHA-256'); // concrete, reproducible name derivation
    expect(help).toContain('PATH'); // "galley" is not necessarily a PATH command
  });

  it('explains what it is for (LLM-generates / human-reviews)', () => {
    expect(help.toLowerCase()).toContain('markdown');
    expect(help).toMatch(/LLM/);
  });
});

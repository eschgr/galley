import { describe, it, expect } from 'vitest';
import { buildCliHelp, wantsHelp } from './cliHelp';

describe('wantsHelp', () => {
  it('is true for a bare --help or -h', () => {
    expect(wantsHelp(['galley.exe', '--help'])).toBe(true);
    expect(wantsHelp(['galley.exe', '-h'])).toBe(true);
  });

  it('is true wherever the flag sits among other args — first, middle, or last', () => {
    // first, with a full channel + file invocation after it
    expect(wantsHelp(['galley.exe', '--help', '--channel', 'proj', 'notes.md'])).toBe(true);
    // in the middle, between files
    expect(wantsHelp(['galley.exe', 'a.md', '-h', 'b.md'])).toBe(true);
    // last, after channel + file + devtools
    expect(wantsHelp(['galley.exe', '--channel', 'proj', 'notes.md', '--devtools', '--help'])).toBe(true);
    // dev-launch shape (electron . <args>)
    expect(wantsHelp(['electron.exe', '.', 'notes.md', '--help'])).toBe(true);
  });

  it('is false when neither flag is present, even amid many other args', () => {
    expect(wantsHelp(['galley.exe'])).toBe(false);
    expect(wantsHelp(['galley.exe', '--channel', 'proj', 'a.md', 'b.md', '--devtools'])).toBe(false);
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
  // drifting out of sync with docs/PRD.md Appendix A and channelAddress().
  it('covers the channel launcher contract', () => {
    expect(help).toContain('--channel');
    expect(help).toContain('\\\\.\\pipe\\mdtool-<name>'); // Windows named-pipe form
    expect(help).toContain('<tmpdir>/mdtool-<name>.sock'); // Unix-socket form
    expect(help.toLowerCase()).toContain('newline'); // wire protocol
    expect(help).toContain('project'); // channel keyed on the project root
    expect(help).toMatch(/PID/); // explicit "do not key on PID"
  });

  it('documents multiple files and the absolute-path requirement', () => {
    expect(help).toContain('[file ...]');
    expect(help.toLowerCase()).toContain('absolute');
  });

  it('explains what it is for (LLM-generates / human-reviews)', () => {
    expect(help.toLowerCase()).toContain('markdown');
    expect(help).toMatch(/LLM/);
  });
});

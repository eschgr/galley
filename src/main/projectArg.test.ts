import { describe, it, expect } from 'vitest';
import { parseProjectArg } from './projectArg';

describe('parseProjectArg', () => {
  it('returns null when the token is absent', () => {
    expect(parseProjectArg(['electron', '--other=x', 'a.md'])).toBe(null);
  });

  it('returns the name for a normal --galley-project=<name>', () => {
    expect(parseProjectArg(['electron', '--galley-project=Notebook'])).toBe('Notebook');
  });

  it('keeps everything after the FIRST = so names may contain = (not split[1])', () => {
    // Would break a naive `split('=')[1]` implementation, which yields 'a'.
    expect(parseProjectArg(['--galley-project=a=b'])).toBe('a=b');
  });

  it('treats an empty value (--galley-project=) as projectless → null', () => {
    expect(parseProjectArg(['--galley-project='])).toBe(null);
  });

  it('ignores a lookalike token that lacks the exact prefix', () => {
    // The bare flag (no `=`) doesn't start with `--galley-project=`, and a
    // different `--other=` token merely contains a substring — both → null.
    expect(parseProjectArg(['--galley-project', 'Notebook'])).toBe(null);
    expect(parseProjectArg(['--other=x'])).toBe(null);
  });
});

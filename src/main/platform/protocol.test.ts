import { describe, it, expect } from 'vitest';
import { parseVersion, isCompatible, isCompatibleWith, PROTOCOL, PROTOCOL_VERSION } from './protocol';

describe('parseVersion', () => {
  it('parses MAJOR.MINOR', () => {
    expect(parseVersion('1.0')).toEqual({ major: 1, minor: 0 });
    expect(parseVersion('2.13')).toEqual({ major: 2, minor: 13 });
  });
  it('rejects malformed input', () => {
    expect(parseVersion('1')).toBeNull();
    expect(parseVersion('1.0.0')).toBeNull();
    expect(parseVersion('x.y')).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
    expect(parseVersion(10)).toBeNull();
  });
});

describe('isCompatible (same major ⇒ compatible)', () => {
  it('is true when majors match, either minor direction', () => {
    expect(isCompatible({ major: 1, minor: 0 }, { major: 1, minor: 0 })).toBe(true);
    expect(isCompatible({ major: 1, minor: 5 }, { major: 1, minor: 0 })).toBe(true); // sender newer minor
    expect(isCompatible({ major: 1, minor: 0 }, { major: 1, minor: 5 })).toBe(true); // receiver newer minor
  });
  it('is false when majors differ', () => {
    expect(isCompatible({ major: 1, minor: 9 }, { major: 2, minor: 0 })).toBe(false);
    expect(isCompatible({ major: 2, minor: 0 }, { major: 1, minor: 9 })).toBe(false);
  });
});

describe('isCompatibleWith (against this build)', () => {
  it('accepts the current version and any same-major minor', () => {
    expect(isCompatibleWith(PROTOCOL_VERSION)).toBe(true);
    expect(isCompatibleWith(`${PROTOCOL.major}.${PROTOCOL.minor + 7}`)).toBe(true);
  });
  it('rejects a different major and malformed strings', () => {
    expect(isCompatibleWith(`${PROTOCOL.major + 1}.0`)).toBe(false);
    expect(isCompatibleWith('garbage')).toBe(false);
    expect(isCompatibleWith(undefined)).toBe(false);
  });
});

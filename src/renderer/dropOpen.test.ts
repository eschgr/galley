import { describe, it, expect } from 'vitest';
import { dropPaths } from './dropOpen';

// Minimal File stand-ins keyed by name; the resolver maps them to paths.
const f = (name: string) => ({ name }) as unknown as File;

describe('dropPaths', () => {
  const resolve = (file: File) => (file.name ? `/docs/${file.name}` : '');

  it('resolves each dropped file to its absolute path, in order', () => {
    expect(dropPaths([f('a.md'), f('b.md')], resolve)).toEqual(['/docs/a.md', '/docs/b.md']);
  });

  it('collapses duplicates within one drop to a single path', () => {
    expect(dropPaths([f('a.md'), f('a.md'), f('b.md')], resolve)).toEqual([
      '/docs/a.md',
      '/docs/b.md',
    ]);
  });

  it('drops entries the resolver cannot turn into a path', () => {
    expect(dropPaths([f('a.md'), f(''), f('b.md')], resolve)).toEqual(['/docs/a.md', '/docs/b.md']);
  });

  it('returns nothing for an empty drop', () => {
    expect(dropPaths([], resolve)).toEqual([]);
  });
});

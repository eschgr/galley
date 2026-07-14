import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSpellEngine } from './spellEngine';

// A tiny hand-written Hunspell dictionary keeps the factory tests fast and
// deterministic (no 540 KB asset). The TRY line gives nspell an alphabet for
// generating suggestions.
const FIXTURE_AFF = ['SET UTF-8', 'TRY esianrtolcd'].join('\n') + '\n';
const FIXTURE_DIC = ['4', 'hello', 'world', 'code', "don't"].join('\n') + '\n';

describe('createSpellEngine (fixture dictionary)', () => {
  it('accepts known words and rejects misspellings', () => {
    const engine = createSpellEngine(FIXTURE_AFF, FIXTURE_DIC);
    expect(engine.correct('hello')).toBe(true);
    expect(engine.correct('world')).toBe(true);
    expect(engine.correct('helo')).toBe(false);
  });

  it('suggests the intended word for a near miss', () => {
    const engine = createSpellEngine(FIXTURE_AFF, FIXTURE_DIC);
    expect(engine.suggest('helo')).toContain('hello');
  });

  it('add() marks a previously-unknown word correct', () => {
    const engine = createSpellEngine(FIXTURE_AFF, FIXTURE_DIC);
    expect(engine.correct('galley')).toBe(false);
    engine.add('galley');
    expect(engine.correct('galley')).toBe(true);
  });

  it('addPersonal() seeds a batch of custom words', () => {
    const engine = createSpellEngine(FIXTURE_AFF, FIXTURE_DIC);
    engine.addPersonal(['nspell', 'codemirror']);
    expect(engine.correct('nspell')).toBe(true);
    expect(engine.correct('codemirror')).toBe(true);
  });

  it('normalises a curly apostrophe to a straight one', () => {
    const engine = createSpellEngine(FIXTURE_AFF, FIXTURE_DIC);
    expect(engine.correct('don’t')).toBe(true); // curly ’ — same as the dic's don't
  });
});

// A light smoke test against the REAL bundled asset: proves it loads and that
// affix morphology works (inflected forms not present as literal dic lines).
describe('createSpellEngine (bundled en_US asset)', () => {
  const read = (name: string) => readFileSync(fileURLToPath(new URL(`../assets/${name}`, import.meta.url)), 'utf8');
  const engine = createSpellEngine(read('en.aff'), read('en.dic'));

  it('accepts common words and an affix-inflected form', () => {
    expect(engine.correct('the')).toBe(true);
    expect(engine.correct('obfuscate')).toBe(true);
    expect(engine.correct('obfuscating')).toBe(true); // via affix, not a literal entry
  });

  it('rejects a clear misspelling and suggests a fix', () => {
    expect(engine.correct('teh')).toBe(false);
    expect(engine.suggest('teh')).toContain('the');
  });

  it('ranks common-typo fixes near the top via the REP table (gen-spelldict)', () => {
    // Without the appended REP rules nspell buries "the" ~8th for "teh"; the rules
    // lift each common typo's fix into the leading suggestions.
    for (const [typo, fix] of [
      ['teh', 'the'],
      ['adn', 'and'],
      ['taht', 'that'],
      ['thier', 'their'],
      ['peice', 'piece'],
      ['tounge', 'tongue'],
      ['arent', "aren't"],
      ['basicly', 'basically'],
    ] as const) {
      expect(engine.suggest(typo).slice(0, 3)).toContain(fix);
    }
  });
});

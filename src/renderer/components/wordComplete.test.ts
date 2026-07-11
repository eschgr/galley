import { describe, it, expect } from 'vitest';
import { rankWordMatches, type DictEntry } from './wordComplete';

const dict: DictEntry[] = [
  { word: 'them', band: 10 },
  { word: 'there', band: 20 },
  { word: 'therefore', band: 35 },
  { word: 'theremin', band: 50 },
  { word: 'the', band: 10 },
];

describe('rankWordMatches (word autocomplete ranking)', () => {
  it('returns dictionary matches ranked by band (common first)', () => {
    // "the" itself is excluded (same length); the rest ranked band 10 → 50.
    expect(rankWordMatches('the', [], dict)).toEqual(['them', 'there', 'therefore', 'theremin']);
  });

  it('excludes the prefix itself and equal-length words', () => {
    expect(rankWordMatches('them', [], dict)).toEqual([]); // nothing longer starts with "them"
  });

  it('puts document words first, then the dictionary', () => {
    expect(rankWordMatches('the', ['thermodynamics'], dict)).toEqual([
      'thermodynamics', // contextual (doc) word first
      'them',
      'there',
      'therefore',
      'theremin',
    ]);
  });

  it('dedupes a word that is in both the document and the dictionary (doc wins)', () => {
    // "there" comes from the doc list, so it is not repeated from the dictionary.
    expect(rankWordMatches('the', ['there'], dict)).toEqual(['there', 'them', 'therefore', 'theremin']);
  });

  it('matches case-insensitively and capitalizes dictionary suggestions to match the prefix', () => {
    expect(rankWordMatches('The', [], dict)).toEqual(['Them', 'There', 'Therefore', 'Theremin']);
  });

  it('keeps a document word in its original case', () => {
    expect(rankWordMatches('the', ['theORY'], dict)[0]).toBe('theORY');
  });

  it('caps the number of suggestions', () => {
    expect(rankWordMatches('the', [], dict, 2)).toEqual(['them', 'there']);
  });

  it('returns nothing for an empty prefix or no matches', () => {
    expect(rankWordMatches('', [], dict)).toEqual([]);
    expect(rankWordMatches('zzz', [], dict)).toEqual([]);
  });
});

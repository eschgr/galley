import { describe, it, expect } from 'vitest';
import { rankWordMatches, type DictEntry } from './wordComplete';

// Ranking is purely by SCOWL band (ascending), then alphabetical within a band.
// The fixture spans the bundled bands (the app ships 10/20/35/40/50) — with two
// words in band 20 to exercise the intra-band alphabetical tiebreak — plus words
// in bands OUTSIDE the bundled set (55, 70): a word rarer than anything shipped
// must still sort after the common ones, purely by number, so the ranking makes no
// assumption that a band sits within the shipped range.
const dict: DictEntry[] = [
  { word: 'them', band: 10 },
  { word: 'theater', band: 20 },
  { word: 'there', band: 20 },
  { word: 'therefore', band: 35 },
  { word: 'theory', band: 40 },
  { word: 'theremin', band: 50 },
  { word: 'theorem', band: 55 }, // out of the bundled bands…
  { word: 'thespian', band: 70 }, // …rarer still — must sort after every bundled band
  { word: 'the', band: 10 },
];

describe('rankWordMatches (word autocomplete ranking)', () => {
  it('returns dictionary matches ranked by band (common first)', () => {
    // "the" itself is excluded (same length); the rest ranked by band ascending
    // (bundled 10→50, then out-of-band 55, 70), alphabetical within a band
    // ("theater" before "there", both band 20).
    expect(rankWordMatches('the', [], dict)).toEqual([
      'them',
      'theater',
      'there',
      'therefore',
      'theory',
      'theremin',
      'theorem',
      'thespian',
    ]);
  });

  it('excludes the prefix itself and equal-length words', () => {
    expect(rankWordMatches('them', [], dict)).toEqual([]); // nothing longer starts with "them"
  });

  it('puts document words first, then the dictionary', () => {
    expect(rankWordMatches('the', ['thermodynamics'], dict)).toEqual([
      'thermodynamics', // contextual (doc) word first
      'them',
      'theater',
      'there',
      'therefore',
      'theory',
      'theremin',
      'theorem',
      'thespian',
    ]);
  });

  it('dedupes a word that is in both the document and the dictionary (doc wins)', () => {
    // "there" comes from the doc list, so it is not repeated from the dictionary.
    expect(rankWordMatches('the', ['there'], dict)).toEqual([
      'there',
      'them',
      'theater',
      'therefore',
      'theory',
      'theremin',
      'theorem',
      'thespian',
    ]);
  });

  it('matches case-insensitively and capitalizes dictionary suggestions to match the prefix', () => {
    expect(rankWordMatches('The', [], dict)).toEqual([
      'Them',
      'Theater',
      'There',
      'Therefore',
      'Theory',
      'Theremin',
      'Theorem',
      'Thespian',
    ]);
  });

  it('keeps a document word in its original case', () => {
    expect(rankWordMatches('the', ['theORY'], dict)[0]).toBe('theORY');
  });

  it('caps the number of suggestions', () => {
    expect(rankWordMatches('the', [], dict, 2)).toEqual(['them', 'theater']);
  });

  it('returns nothing for an empty prefix or no matches', () => {
    expect(rankWordMatches('', [], dict)).toEqual([]);
    expect(rankWordMatches('zzz', [], dict)).toEqual([]);
  });
});

/**
 * The offline spell-check engine for the source editor (#132): a thin wrapper
 * over nspell (a browser-safe, pure-JS Hunspell implementation) loaded with the
 * bundled US-English dictionary (`assets/en.aff` + `en.dic`, SCOWL-derived).
 *
 * `createSpellEngine` is a pure factory over affix + word-list strings, so its
 * behaviour is unit-tested with a tiny fixture; `loadSpellEngine` is the lazily
 * constructed, cached singleton that pulls in the ~540 KB `en.dic` asset, so the
 * nspell parse cost is paid once and off the initial render path.
 *
 * Detection, suggestions, and add-to-dictionary all live here so the editor's
 * spell decorations and right-click menu can source everything from this engine
 * instead of Chromium's native (caret-local) checker (the #132 root cause).
 */
import nspell from 'nspell';

export interface SpellEngine {
  /** True when `word` is spelled correctly (or is a known/added word). */
  correct(word: string): boolean;
  /** Ranked correction suggestions for a misspelling (best first, may be empty). */
  suggest(word: string): string[];
  /** Mark `word` as correct for the rest of this session. */
  add(word: string): void;
  /** Add a batch of custom words (e.g. seeded from a saved personal dictionary). */
  addPersonal(words: readonly string[]): void;
}

// Curly apostrophes are normalised to straight ones so "don’t" checks the same as
// "don't": the dictionary's affix ICONV maps ’→', but nspell doesn't apply ICONV
// to the words it is asked about, so we normalise on the way in.
function normalize(word: string): string {
  return word.replace(/’/g, "'");
}

/** Wrap affix + dictionary strings in a SpellEngine. Pure — no assets, no I/O. */
export function createSpellEngine(aff: string, dic: string): SpellEngine {
  const speller = nspell(aff, dic);
  return {
    correct: (word) => speller.correct(normalize(word)),
    suggest: (word) => speller.suggest(normalize(word)),
    add: (word) => {
      speller.add(normalize(word));
    },
    addPersonal: (words) => {
      for (const w of words) speller.add(normalize(w));
    },
  };
}

let singleton: Promise<SpellEngine> | null = null;

/**
 * The shared engine, constructed once from the bundled US-English dictionary. The
 * dictionary asset is dynamically imported so it (and the nspell parse) stay out
 * of the initial chunk and are paid for lazily on first use.
 */
export function loadSpellEngine(): Promise<SpellEngine> {
  if (!singleton) {
    singleton = (async () => {
      const [{ default: aff }, { default: dic }] = await Promise.all([
        import('../assets/en.aff?raw'),
        import('../assets/en.dic?raw'),
      ]);
      return createSpellEngine(aff, dic);
    })();
  }
  return singleton;
}

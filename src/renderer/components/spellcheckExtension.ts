/**
 * Whole-viewport spell-check for the source editor (#132). Chromium's native
 * contenteditable checker is as-you-type only — it never flags untouched or
 * off-screen lines — so this replaces it with a CodeMirror decoration checker:
 * on every doc change or viewport change it tokenizes the VISIBLE ranges, looks
 * each word up in the offline engine ([[spellEngine]]), and underlines the
 * misspellings itself. Because CodeMirror keeps the whole document in state and
 * re-runs this on scroll, coverage is complete for everything rendered — the gap
 * the native checker left.
 *
 * Words inside code and links are skipped via the markdown syntax tree
 * (`spellSkipRanges`, pure and unit-tested). The engine loads asynchronously; a
 * `recheckSpelling` effect (dispatched by `forceRecheck`) forces a recompute once
 * it is ready, or after the personal dictionary changes (Add to Dictionary).
 *
 * The word tokenization, region clipping, and heuristics live in the pure
 * ./spellRanges module; this file is the CodeMirror glue plus the syntax-tree
 * skip-range walk.
 */
import {
  ViewPlugin,
  Decoration,
  EditorView,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder, StateEffect, type EditorState, type Extension } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { computeMisspelledRanges, type Range } from './spellRanges';
import { loadSpellEngine, type SpellEngine } from './spellEngine';

/** Syntax-tree node names whose text is NOT prose and must not be spell-checked. */
const SKIP_NODES = new Set([
  'FencedCode', // ``` blocks (marks + body)
  'CodeText', // fenced-code body (redundant with FencedCode, harmless)
  'CodeBlock', // indented code
  'InlineCode', // `code`
  'URL', // link destinations + autolink targets (visible link text stays checked)
  'HTMLTag', // inline HTML
  'HTMLBlock', // block HTML
  'Comment',
  'CommentBlock',
]);

/**
 * The ranges within [from, to) that should be skipped by the spell checker —
 * code spans, link/autolink URLs, and HTML, located via the markdown syntax
 * tree. Returned sorted ascending by `from`. Pure over an EditorState (no view,
 * no DOM), so it is unit-tested headlessly.
 */
export function spellSkipRanges(state: EditorState, from: number, to: number): Range[] {
  const skip: Range[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (SKIP_NODES.has(node.name)) skip.push({ from: node.from, to: node.to });
    },
  });
  skip.sort((a, b) => a.from - b.from);
  return skip;
}

/**
 * Force the spell decorations to recompute — after the engine finishes loading or
 * the personal dictionary changes. The plugin clears its per-word cache and
 * re-scans the viewport when it sees this effect.
 */
export const recheckSpelling = StateEffect.define<null>();

/** Dispatch a recheck (no-op if the view is gone). */
export function forceRecheck(view: EditorView | null | undefined): void {
  view?.dispatch({ effects: recheckSpelling.of(null) });
}

const misspelledMark = Decoration.mark({ class: 'cm-misspelled' });

const spellTheme = EditorView.baseTheme({
  '.cm-misspelled': {
    textDecoration: 'underline wavy #d1242f',
    // Don't let the wavy line skip under descenders — keep it continuous.
    textDecorationSkipInk: 'none',
  },
});

// The plugin caches per-word correctness so re-scanning the viewport on every
// scroll tick stays cheap (repeated and re-scrolled words are O(1)). The cache is
// cleared whenever a recheck is forced (the dictionary changed).
class SpellcheckPlugin {
  decorations: DecorationSet = Decoration.none;
  private engine: SpellEngine | null = null;
  private readonly cache = new Map<string, boolean>();

  constructor(view: EditorView) {
    void loadSpellEngine().then((engine) => {
      this.engine = engine;
      // Repaint now that words can be judged (the ctor already returned, so a
      // dispatch here is a normal follow-up transaction).
      forceRecheck(view);
    });
  }

  update(u: ViewUpdate): void {
    const rechecked = u.transactions.some((tr) => tr.effects.some((e) => e.is(recheckSpelling)));
    if (rechecked) this.cache.clear();
    if (this.engine && (u.docChanged || u.viewportChanged || rechecked)) {
      this.decorations = this.build(u.view);
    }
  }

  private isCorrect = (word: string): boolean => {
    const hit = this.cache.get(word);
    if (hit !== undefined) return hit;
    const ok = this.engine!.correct(word);
    this.cache.set(word, ok);
    return ok;
  };

  private build(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const text = view.state.doc.toString();
    for (const region of view.visibleRanges) {
      const skip = spellSkipRanges(view.state, region.from, region.to);
      for (const r of computeMisspelledRanges(text, [region], skip, this.isCorrect)) {
        builder.add(r.from, r.to, misspelledMark);
      }
    }
    return builder.finish();
  }
}

/** The spell-check extension: the viewport decoration plugin plus its theme. */
export function spellcheck(): Extension {
  return [
    ViewPlugin.fromClass(SpellcheckPlugin, { decorations: (p) => p.decorations }),
    spellTheme,
  ];
}

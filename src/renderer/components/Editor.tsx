/**
 * CodeMirror 6 source editor (in-app source editing, editor syntax
 * highlighting, undo/redo, find & replace, formatting shortcuts, list indent,
 * the link dialog, and the 2-space indentation setting).
 *
 * Composes the editor from CM6 sub-packages (no `basicSetup` meta-package):
 *  - markdown() language for editor syntax highlighting
 *  - history + history/default keymaps for undo/redo
 *  - search panel + keymap for find/replace (Cmd/Ctrl+F)
 *  - line numbers, line wrapping, 2-space indent unit
 *  - a highest-precedence formatting keymap (formatting shortcuts — apply/toggle
 *    + smart selection): bold/italic/inline code/
 *    strikethrough/heading 1–6/fenced code block, plus list-aware Tab (list
 *    indent / outdent) and
 *    a Cmd/Ctrl+K hook that asks the host to open the link dialog. The
 *    wrap/heading/fence rules live in the pure, tested ./editorCommands module;
 *    link parsing needs the live syntax tree, so it stays on the handle below.
 *
 * Exposes an imperative handle (getTopLine / scrollToLine) in 0-based fractional
 * line units — the same units the preview's data-source-line anchors use — so
 * the split view can keep the two panes aligned (scroll synchronization). Calls onScroll on user
 * scroll and onChange on edits.
 *
 * The editor is UNCONTROLLED: it is initialised from `initialDoc` once on mount
 * and never reset from a prop change (CM6 would clobber the cursor/undo). When a
 * tab is RELOADED from disk (Ctrl+R / external refresh / keep-mine) the host
 * pushes the new text down imperatively via setDoc(); ordinary edits flow up
 * through onChange and never round-trip back. Since every open tab now owns its
 * OWN Editor (one CodeMirror per TabView), the per-tab state-swap machinery
 * that used to live here — getState/setState + the scrollSnapshot/restoreScroll
 * warm-sweep — is gone: switching tabs just toggles which TabView is visible.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  keymap,
  type Command,
} from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, indentMore, indentLess, redo } from '@codemirror/commands';
import {
  syntaxHighlighting,
  HighlightStyle,
  indentUnit,
  syntaxTree,
} from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { wordAutocomplete } from './wordComplete';
import { spellcheck, forceRecheck, spellSkipRanges } from './spellcheckExtension';
import { loadSpellEngine, type SpellEngine } from './spellEngine';
import {
  wrapEdit,
  unwrapSpan,
  headingEdit,
  fencedEdit,
  listIndentEdit,
  listContinueEdit,
  type EditResult,
} from './editorCommands';

/** Link context handed to the host so it can open the dialog prefilled. */
export interface LinkContext {
  text: string;
  url: string;
  /** True when the cursor sits inside an existing link (edit, not create). */
  editing: boolean;
}

export interface EditorHandle {
  /** The editor's current document text (the source of truth while mounted). */
  getText(): string;
  /** Top of the viewport as a 0-based fractional source line. */
  getTopLine(): number;
  /** Scroll so a 0-based fractional source line sits at the viewport top. */
  scrollToLine(line: number): void;
  /** Raw scroll offset (px) of the editor's scroller. */
  getScrollTop(): number;
  /** Set the scroller's scrollTop directly (px) — used by co-arrival blending. */
  setScrollTop(px: number): void;
  /** Max scrollTop of the scroller (scrollHeight - clientHeight), clamped >= 0. */
  maxScroll(): number;
  /** Visible height of the scroller (px) — one screenful, used as the blend window. */
  clientHeight(): number;
  /** The px scrollTop that would put a 0-based fractional source line at the top
   *  — the line-anchored target, without actually scrolling (scroll synchronization). */
  scrollTopForLine(line: number): number;
  /** Re-measure layout — call after the editor is re-shown from display:none. */
  refresh(): void;
  /**
   * Scroll to a 0-based line *after* the editor has been (re)measured. Use right
   * after the editor is revealed from display:none, when its line geometry isn't
   * valid yet — the scroll runs in CodeMirror's measure cycle, once heights are
   * known.
   */
  alignTo(line: number): void;
  /** Replace the whole document (e.g. when a file is reloaded from disk) with
   *  fresh undo history, so undo can't reach back into the previous content.
   *  Ordinary edits never call this — they flow up through onChange. */
  setDoc(content: string): void;
  /** Move keyboard focus into the editor (e.g. after a tab becomes visible). */
  focus(): void;
  /** Snapshot the link context at the cursor and remember the target range so a
   *  later applyLink/removeLink edits the right span. */
  requestLink(): LinkContext | null;
  /** Insert/replace the remembered range with `[text](url)`. */
  applyLink(text: string, url: string): void;
  /** Strip the remembered link to its plain text. */
  removeLink(): void;
}

interface EditorProps {
  initialDoc: string;
  onChange?: (doc: string) => void;
  onScroll?: () => void;
  /** Cmd/Ctrl+K — the host opens the link dialog. */
  onLink?: () => void;
}

// Source-like highlighting (editor syntax highlighting): colour only — no bold/italic/size/strike — so
// the editor reads as Markdown *source* (uniform monospace) while colour still
// conveys structure like a code editor's syntax highlighting.
const sourceHighlightStyle = HighlightStyle.define([
  { tag: t.heading, color: '#0550ae' },
  { tag: [t.strong, t.emphasis], color: '#0a3069' },
  { tag: t.strikethrough, color: '#6e7781' },
  { tag: [t.link, t.url], color: '#0969da' },
  { tag: t.monospace, color: '#0a3069' },
  { tag: t.quote, color: '#6e7781' },
  { tag: [t.processingInstruction, t.meta, t.list, t.contentSeparator], color: '#6e7781' },
  // Fenced code, when a language gets parsed.
  { tag: t.keyword, color: '#cf222e' },
  { tag: t.string, color: '#0a3069' },
  { tag: t.comment, color: '#6e7781' },
  { tag: t.number, color: '#0550ae' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13.5px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
    lineHeight: '1.6',
    overflow: 'auto',
  },
  '.cm-content': { padding: '12px 0' },
  '.cm-gutters': { border: 'none', background: 'transparent' },
});

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function getTopLine(view: EditorView): number {
  const top = view.scrollDOM.scrollTop;
  const block = view.lineBlockAtHeight(top);
  const lineNo = view.state.doc.lineAt(block.from).number; // 1-based
  const frac = block.height > 0 ? clamp((top - block.top) / block.height, 0, 1) : 0;
  return lineNo - 1 + frac; // 0-based fractional
}

// The px scrollTop that puts a 0-based fractional source line at the viewport
// top — the inverse of getTopLine. Shared by scrollToLine and the handle's
// scrollTopForLine so SplitView can blend toward the editor's own max.
function scrollTopForLine(view: EditorView, line0: number): number {
  const total = view.state.doc.lines;
  const lineNo = clamp(Math.floor(line0) + 1, 1, total); // 1-based
  const frac = line0 - Math.floor(line0);
  const docLine = view.state.doc.line(lineNo);
  const block = view.lineBlockAt(docLine.from);
  return block.top + frac * block.height;
}

function scrollToLine(view: EditorView, line0: number): void {
  view.scrollDOM.scrollTop = scrollTopForLine(view, line0);
}

// --- Formatting commands (formatting shortcuts — apply/toggle + smart selection) ---
// Each turns an EditResult (computed by the pure helpers over the primary
// selection) into a single transaction.
function formatCommand(fn: (doc: string, from: number, to: number) => EditResult): Command {
  return (view) => {
    const { state } = view;
    const range = state.selection.main;
    const r = fn(state.doc.toString(), range.from, range.to);
    view.dispatch(
      state.update({
        changes: { from: r.from, to: r.to, insert: r.insert },
        selection: { anchor: r.select[0], head: r.select[1] },
        userEvent: 'input.format',
        scrollIntoView: true,
      }),
    );
    return true;
  };
}

// The Lezer node each inline marker produces, used to detect when a bare cursor
// sits inside an existing span so the shortcut toggles it OFF (formatting toggle behavior).
const INLINE_NODE: Record<string, string> = {
  '**': 'StrongEmphasis',
  '_': 'Emphasis',
  '`': 'InlineCode',
  '~~': 'Strikethrough',
};

function enclosingSpan(state: EditorState, pos: number, nodeName: string): { from: number; to: number } | null {
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    for (let n: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side); n; n = n.parent) {
      if (n.name === nodeName) return { from: n.from, to: n.to };
    }
  }
  return null;
}

// A wrap toggle: with a selection (or empty cursor not inside a span) it wraps;
// with a bare cursor *inside* a span of this type it removes the whole span.
function wrapCommand(marker: string): Command {
  const nodeName = INLINE_NODE[marker];
  return (view) => {
    const { state } = view;
    const range = state.selection.main;
    if (range.empty) {
      const span = enclosingSpan(state, range.head, nodeName);
      if (span) {
        applyEdit(view, unwrapSpan(state.doc.toString(), span.from, span.to, marker.length, range.head), 'input.format');
        return true;
      }
    }
    applyEdit(view, wrapEdit(state.doc.toString(), range.from, range.to, marker), 'input.format');
    return true;
  };
}

const boldCmd = wrapCommand('**');
// Italic uses underscores so `_italic_` reads distinctly from `**bold**` (both
// are CommonMark emphasis; `_` also avoids accidental intra-word italics).
const italicCmd = wrapCommand('_');
const inlineCodeCmd = wrapCommand('`');
const strikeCmd = wrapCommand('~~');
const fencedCmd = formatCommand(fencedEdit);
const headingCmd = (level: number) => formatCommand((d, f, t) => headingEdit(d, f, t, level));

// --- List-aware Tab / Shift+Tab (list indent / outdent; 2-space indentation setting) ---
// On a list line, Tab/Shift+Tab nest/un-nest the whole item to the CommonMark
// content column of its parent (so nested lists actually render), from anywhere
// on the line. Off a list line, Tab inserts spaces at the cursor and Shift+Tab
// outdents — and Tab never escapes the editor.
function applyEdit(view: EditorView, r: EditResult, userEvent: string): void {
  view.dispatch(
    view.state.update({
      changes: { from: r.from, to: r.to, insert: r.insert },
      selection: { anchor: r.select[0], head: r.select[1] },
      userEvent,
    }),
  );
}

const tabCmd: Command = (view) => {
  const range = view.state.selection.main;
  if (range.empty) {
    const r = listIndentEdit(view.state.doc.toString(), range.head, 'in');
    if (r) {
      applyEdit(view, r, 'input.indent');
      return true;
    }
    // Not a list line → insert indentation at the cursor.
    view.dispatch(
      view.state.update({
        changes: { from: range.head, insert: '  ' },
        selection: { anchor: range.head + 2 },
        userEvent: 'input.indent',
      }),
    );
    return true;
  }
  return indentMore(view); // a multi-line selection indents the whole block
};

const shiftTabCmd: Command = (view) => {
  const range = view.state.selection.main;
  if (range.empty) {
    const r = listIndentEdit(view.state.doc.toString(), range.head, 'out');
    if (r) {
      applyEdit(view, r, 'delete.dedent');
      return true;
    }
  }
  return indentLess(view);
};

// Enter continues a list with a fresh "1." item (list continuation on Enter); off a list line it
// returns false so the default newline runs.
const continueListCmd: Command = (view) => {
  const range = view.state.selection.main;
  if (!range.empty) return false;
  const r = listContinueEdit(view.state.doc.toString(), range.head);
  if (!r) return false;
  applyEdit(view, r, 'input');
  return true;
};

const LINK_RE = /^\[([^\]]*)\]\(([^)]*)\)$/;

// The word token (letters + internal apostrophes, matching the spell tokenizer)
// under document position `pos`, or null if the click wasn't on a word. Used to
// source the right-click spell menu (#132) from the offline engine.
const CLICK_WORD_RE = /[A-Za-z]+(?:'[A-Za-z]+)*/g;
function wordAt(view: EditorView, pos: number): { from: number; to: number; text: string } | null {
  const line = view.state.doc.lineAt(pos);
  const rel = pos - line.from;
  CLICK_WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLICK_WORD_RE.exec(line.text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (rel >= start && rel <= end) return { from: line.from + start, to: line.from + end, text: m[0] };
  }
  return null;
}

type CbRef<T> = { current: T | undefined };

function formattingKeymap(onLinkRef: CbRef<() => void>): Extension {
  const linkCmd: Command = () => {
    onLinkRef.current?.();
    return true; // swallow Mod-k regardless, so no default fires
  };
  return Prec.highest(
    keymap.of([
      { key: 'Mod-b', run: boldCmd },
      { key: 'Mod-i', run: italicCmd },
      { key: 'Mod-e', run: inlineCodeCmd },
      { key: 'Mod-Shift-x', run: strikeCmd },
      { key: 'Mod-Shift-c', run: fencedCmd },
      { key: 'Mod-1', run: headingCmd(1) },
      { key: 'Mod-2', run: headingCmd(2) },
      { key: 'Mod-3', run: headingCmd(3) },
      { key: 'Mod-4', run: headingCmd(4) },
      { key: 'Mod-5', run: headingCmd(5) },
      { key: 'Mod-6', run: headingCmd(6) },
      { key: 'Mod-k', run: linkCmd },
      // Redo alongside the default Mod-y. Always claim the key (return true) so
      // CodeMirror's shift-letter fallback can't drop through to Mod-z (undo)
      // when there's nothing to redo.
      { key: 'Mod-Shift-z', preventDefault: true, run: (view) => { redo(view); return true; } },
      { key: 'Enter', run: continueListCmd },
      { key: 'Tab', run: tabCmd, shift: shiftTabCmd },
    ]),
  );
}

type ChangeRef = CbRef<(doc: string) => void>;
type ScrollRef = CbRef<() => void>;
type LinkRef = CbRef<() => void>;

// The full extension set, rebuilt for setDoc so a loaded file starts with fresh
// undo history. Callbacks are read through refs so they stay current without
// re-creating the editor.
function buildExtensions(onChangeRef: ChangeRef, onScrollRef: ScrollRef, onLinkRef: LinkRef): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    EditorState.allowMultipleSelections.of(true),
    indentUnit.of('  '),
    EditorView.lineWrapping,
    // Spell-checking is done by our own CodeMirror decoration checker (#132), not
    // Chromium's native contenteditable checker — which only flagged caret-local
    // words and never scanned untouched/off-screen lines. Turn the native one OFF
    // so its (partial) squiggles don't double up with ours; `spellcheck()` paints
    // the real ones across the whole viewport and re-checks on scroll/edit.
    EditorView.contentAttributes.of({ spellcheck: 'false' }),
    spellcheck(),
    syntaxHighlighting(sourceHighlightStyle),
    markdown({ extensions: GFM }), // parse GFM (strikethrough/tables/tasklists) so the tree matches the preview
    highlightSelectionMatches(),
    search({ top: true }),
    // Word autocomplete (#120): doc words + a bundled SCOWL dictionary. Placed
    // BEFORE the formatting keymap so its Tab-to-accept (also highest precedence)
    // is tried first — but it only claims Tab while the popup is open, otherwise it
    // falls through to the list-indent Tab below.
    wordAutocomplete(),
    formattingKeymap(onLinkRef), // formatting shortcuts + list keys + link dialog, highest precedence so it wins
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    theme,
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
    }),
    EditorView.domEventHandlers({
      scroll: () => {
        onScrollRef.current?.();
        return false;
      },
    }),
  ];
}

/** Find the `[text](url)` link span the cursor sits in, if any. */
function linkAt(view: EditorView, pos: number): { from: number; to: number } | null {
  const tree = syntaxTree(view.state);
  for (const side of [-1, 1] as const) {
    for (let n: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side); n; n = n.parent) {
      if (n.name === 'Link') return { from: n.from, to: n.to };
    }
  }
  return null;
}

export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(
  { initialDoc, onChange, onScroll, onLink },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The link span requestLink() captured, applied by applyLink/removeLink.
  const linkTargetRef = useRef<{ from: number; to: number } | null>(null);
  // The offline spell engine (once loaded) and the misspelled-word range the last
  // right-click targeted, applied when a suggestion is chosen (#132).
  const engineRef = useRef<SpellEngine | null>(null);
  const spellTargetRef = useRef<{ from: number; to: number } | null>(null);
  // Keep latest callbacks without re-creating the editor.
  const onChangeRef = useRef(onChange);
  const onScrollRef = useRef(onScroll);
  const onLinkRef = useRef(onLink);
  onChangeRef.current = onChange;
  onScrollRef.current = onScroll;
  onLinkRef.current = onLink;

  useImperativeHandle(ref, () => ({
    getText: () => viewRef.current?.state.doc.toString() ?? '',
    getTopLine: () => (viewRef.current ? getTopLine(viewRef.current) : 0),
    scrollToLine: (line) => {
      if (viewRef.current) scrollToLine(viewRef.current, line);
    },
    getScrollTop: () => viewRef.current?.scrollDOM.scrollTop ?? 0,
    setScrollTop: (px) => {
      if (viewRef.current) viewRef.current.scrollDOM.scrollTop = px;
    },
    maxScroll: () => {
      const dom = viewRef.current?.scrollDOM;
      return dom ? Math.max(0, dom.scrollHeight - dom.clientHeight) : 0;
    },
    clientHeight: () => viewRef.current?.scrollDOM.clientHeight ?? 0,
    scrollTopForLine: (line) => (viewRef.current ? scrollTopForLine(viewRef.current, line) : 0),
    refresh: () => viewRef.current?.requestMeasure(),
    alignTo: (line) => {
      const v = viewRef.current;
      if (!v) return;
      // Scroll in the measure cycle's write phase, after CodeMirror has updated
      // the height map for the now-visible editor — otherwise lineBlockAt uses
      // stale (display:none) geometry and the scroll lands on the wrong line.
      v.requestMeasure({ read: () => null, write: () => scrollToLine(v, line) });
    },
    setDoc: (content) => {
      const v = viewRef.current;
      if (!v) return;
      v.setState(EditorState.create({ doc: content, extensions: buildExtensions(onChangeRef, onScrollRef, onLinkRef) }));
    },
    focus: () => viewRef.current?.focus(),
    requestLink: () => {
      const v = viewRef.current;
      if (!v) return null;
      const { state } = v;
      const range = state.selection.main;
      const link = linkAt(v, range.head);
      if (link) {
        const m = LINK_RE.exec(state.doc.sliceString(link.from, link.to));
        if (m) {
          linkTargetRef.current = link;
          return { text: m[1], url: m[2], editing: true };
        }
      }
      linkTargetRef.current = { from: range.from, to: range.to };
      return { text: state.doc.sliceString(range.from, range.to), url: '', editing: false };
    },
    applyLink: (text, url) => {
      const v = viewRef.current;
      const tgt = linkTargetRef.current;
      if (!v || !tgt) return;
      const insert = `[${text.length ? text : url}](${url})`;
      v.dispatch(
        v.state.update({
          changes: { from: tgt.from, to: tgt.to, insert },
          selection: { anchor: tgt.from + insert.length },
          userEvent: 'input.link',
        }),
      );
      linkTargetRef.current = null;
      v.focus();
    },
    removeLink: () => {
      const v = viewRef.current;
      const tgt = linkTargetRef.current;
      if (!v || !tgt) return;
      const m = LINK_RE.exec(v.state.doc.sliceString(tgt.from, tgt.to));
      const plain = m ? m[1] : v.state.doc.sliceString(tgt.from, tgt.to);
      v.dispatch(
        v.state.update({
          changes: { from: tgt.from, to: tgt.to, insert: plain },
          selection: { anchor: tgt.from + plain.length },
          userEvent: 'delete.link',
        }),
      );
      linkTargetRef.current = null;
      v.focus();
    },
  }));

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initialDoc,
        extensions: buildExtensions(onChangeRef, onScrollRef, onLinkRef),
      }),
    });
    viewRef.current = view;

    // Right-click → the editor's spell/edit menu (#132). Compute the misspelled
    // word + suggestions HERE from the offline engine (the native checker no
    // longer drives the menu) and hand them to main to pop the native menu. Skip
    // words in code/links so the menu matches what we actually squiggle.
    const onContextMenu = (e: MouseEvent) => {
      // Suppress the browser's own menu; the native menu is popped by main from the
      // params we send (a no-op suppression in Electron, which shows no default menu).
      e.preventDefault();
      spellTargetRef.current = null;
      let misspelledWord = '';
      let dictionarySuggestions: string[] = [];
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      const engine = engineRef.current;
      if (pos != null && engine) {
        const word = wordAt(view, pos);
        if (word && spellSkipRanges(view.state, word.from, word.to).length === 0 && !engine.correct(word.text)) {
          misspelledWord = word.text;
          dictionarySuggestions = engine.suggest(word.text).slice(0, 8);
          spellTargetRef.current = { from: word.from, to: word.to };
        }
      }
      window.galley?.showEditorContextMenu({ misspelledWord, dictionarySuggestions });
    };
    view.contentDOM.addEventListener('contextmenu', onContextMenu);

    // Seed the engine with the persistent custom words, then re-check; and wire
    // the menu actions back: replace edits the remembered range, add-to-dictionary
    // teaches the engine and re-checks. Guarded so this stays inert without the
    // bridge (browser dev / tests).
    const g = window.galley;
    void loadSpellEngine().then((engine) => {
      engineRef.current = engine;
      return g?.getDictionaryWords?.().then((words) => {
        engine.addPersonal(words ?? []);
        forceRecheck(viewRef.current);
      });
    });
    const unsubReplace = g?.onSpellReplace?.((suggestion) => {
      const tgt = spellTargetRef.current;
      if (!view.hasFocus || !tgt) return; // only the tab whose menu is open acts
      view.dispatch({
        changes: { from: tgt.from, to: tgt.to, insert: suggestion },
        selection: { anchor: tgt.from + suggestion.length },
        userEvent: 'input.spell',
      });
      spellTargetRef.current = null;
      view.focus();
    });
    const unsubAdded = g?.onDictionaryWordAdded?.((word) => {
      engineRef.current?.add(word);
      forceRecheck(viewRef.current);
    });

    return () => {
      view.contentDOM.removeEventListener('contextmenu', onContextMenu);
      unsubReplace?.();
      unsubAdded?.();
      view.destroy();
      viewRef.current = null;
    };
    // initialDoc is intentionally only read on mount (uncontrolled editor).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="editor-host" ref={hostRef} />;
});

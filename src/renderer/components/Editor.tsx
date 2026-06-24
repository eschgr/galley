/**
 * CodeMirror 6 source editor (PRD R16, R19–R28).
 *
 * Composes the editor from CM6 sub-packages (no `basicSetup` meta-package):
 *  - markdown() language for syntax highlighting (R19)
 *  - history + history/default keymaps for undo/redo (R20)
 *  - search panel + keymap for find/replace (R21; Cmd/Ctrl+F)
 *  - line numbers (R22), line wrapping, 2-space indent unit (R28)
 *  - a highest-precedence formatting keymap (R23–R25): bold/italic/inline code/
 *    strikethrough/heading 1–6/fenced code block, plus list-aware Tab (R26) and
 *    a Cmd/Ctrl+K hook that asks the host to open the link dialog (R27). The
 *    wrap/heading/fence rules live in the pure, tested ./editorCommands module;
 *    link parsing needs the live syntax tree, so it stays on the handle below.
 *
 * Exposes an imperative handle (getTopLine / scrollToLine) in 0-based fractional
 * line units — the same units the preview's data-source-line anchors use — so
 * SplitView can keep the two panes aligned (R18). Calls onScroll on user scroll
 * and onChange on edits.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState, Prec, type Extension, type StateEffect } from '@codemirror/state';
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
import {
  wrapEdit,
  unwrapSpan,
  headingEdit,
  fencedEdit,
  listIndentEdit,
  listContinueEdit,
  type EditResult,
} from './editorCommands';

/** Link context handed to the host so it can open the dialog prefilled (R27). */
export interface LinkContext {
  text: string;
  url: string;
  /** True when the cursor sits inside an existing link (edit, not create). */
  editing: boolean;
}

export interface EditorHandle {
  /** Top of the viewport as a 0-based fractional source line. */
  getTopLine(): number;
  /** Scroll so a 0-based fractional source line sits at the viewport top. */
  scrollToLine(line: number): void;
  /** Raw scroll offset (px) of the editor's scroller. */
  getScrollTop(): number;
  /** Set the scroller's scrollTop directly (px) — used by co-arrival blending (#18). */
  setScrollTop(px: number): void;
  /** Max scrollTop of the scroller (scrollHeight - clientHeight), clamped >= 0. */
  maxScroll(): number;
  /** Visible height of the scroller (px) — one screenful, used as the blend window (#18). */
  clientHeight(): number;
  /** The px scrollTop that would put a 0-based fractional source line at the top
   *  — the line-anchored target, without actually scrolling (R18 / #18). */
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
  /** Replace the whole document (e.g. when a file is opened) with fresh undo
   *  history, so undo can't reach back into the previous file. */
  setDoc(content: string): void;
  /** Snapshot the full editor state (doc + undo history + selection) so a tab
   *  switch can restore it later (R39). NOTE: a CM6 EditorState does NOT carry
   *  scrollTop (that lives on view.scrollDOM.scrollTop), so setState() alone
   *  won't restore the scroll position — App stashes a CM6 scroll snapshot per
   *  tab (scrollSnapshot()) and re-applies it via restoreScroll() after setState
   *  (#18). */
  getState(): EditorState | null;
  /** Restore a state captured by getState() when returning to a tab. */
  setState(state: EditorState): void;
  /**
   * Capture the current scroll position as a CM6 ScrollTarget effect anchored to
   * a DOCUMENT POSITION + pixel offset (not a raw scrollTop). Stash this per tab
   * before leaving it; on return, dispatch it via restoreScroll() to re-anchor
   * the scroll THROUGH the measure cycle so it survives CM6's height refinement
   * (#18). Returns null if the view isn't mounted.
   */
  scrollSnapshot(): StateEffect<unknown> | null;
  /**
   * Re-apply a scroll snapshot captured by scrollSnapshot(). MUST be dispatched
   * as its OWN transaction AFTER setState (setState replaces the whole state, so
   * the effect can't ride along inside it). CM re-applies it inside the measure
   * cycle and re-anchors as heights settle (#18).
   *
   * `targetTop` is the raw scrollTop (px) the snapshot was captured at; the
   * height-warming sweep stops once it has warmed the bands up to that depth
   * (plus one extra screenful of safety margin) instead of warming the WHOLE
   * doc, so restoring a tab near the top of a huge doc is ~1-2 measure passes
   * rather than hundreds (#18). Omit it to warm the whole doc (legacy behavior).
   */
  restoreScroll(effect: StateEffect<unknown>, targetTop?: number): void;
  /** Snapshot the link context at the cursor and remember the target range so a
   *  later applyLink/removeLink edits the right span (R27). */
  requestLink(): LinkContext | null;
  /** Insert/replace the remembered range with `[text](url)` (R27). */
  applyLink(text: string, url: string): void;
  /** Strip the remembered link to its plain text (R27). */
  removeLink(): void;
}

interface EditorProps {
  initialDoc: string;
  onChange?: (doc: string) => void;
  onScroll?: () => void;
  /** Cmd/Ctrl+K — the host opens the link dialog (R27). */
  onLink?: () => void;
}

// Source-like highlighting (R19): colour only — no bold/italic/size/strike — so
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
// scrollTopForLine so SplitView can blend toward the editor's own max (#18).
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

// --- Formatting commands (R23–R25) -----------------------------------------
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
// sits inside an existing span so the shortcut toggles it OFF (R24).
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

// --- List-aware Tab / Shift+Tab (R26/R28) ----------------------------------
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

// Enter continues a list with a fresh "1." item (R26b); off a list line it
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
    syntaxHighlighting(sourceHighlightStyle),
    markdown({ extensions: GFM }), // parse GFM (strikethrough/tables/tasklists) so the tree matches the preview
    highlightSelectionMatches(),
    search({ top: true }),
    formattingKeymap(onLinkRef), // R23–R27, highest precedence so it wins
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
  // Keep latest callbacks without re-creating the editor.
  const onChangeRef = useRef(onChange);
  const onScrollRef = useRef(onScroll);
  const onLinkRef = useRef(onLink);
  onChangeRef.current = onChange;
  onScrollRef.current = onScroll;
  onLinkRef.current = onLink;

  useImperativeHandle(ref, () => ({
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
    getState: () => viewRef.current?.state ?? null,
    setState: (state) => viewRef.current?.setState(state),
    scrollSnapshot: () => viewRef.current?.scrollSnapshot() ?? null,
    restoreScroll: (effect, targetTop) => {
      const v = viewRef.current;
      if (!v) return;
      // EditorView.measure() flushes CM's measure loop synchronously (re-measures
      // line heights, re-applies any scroll target, converging in one shot). It's
      // a real method but isn't in @codemirror/view's published .d.ts, so reach it
      // through a narrow typed view. This relies on @codemirror/view ^6.43's
      // internal measure(). Guard the cast: if a future CM6 renames/removes it,
      // skip the warm sweep and just dispatch the snapshot (snapshot alone still
      // re-anchors on CM's own next measure) rather than throwing inside the
      // tab-switch handler.
      const measureFn = (v as unknown as { measure?: (flush?: boolean) => void }).measure;
      if (typeof measureFn !== 'function') {
        v.dispatch({ effects: effect });
        return;
      }
      const flushMeasure = () => measureFn.call(v);
      // A CM6 scroll snapshot anchors to a DOCUMENT POSITION + viewport offset, so
      // dispatching it lands the editor on the RIGHT visible line and keeps it
      // there as heights settle (unlike a raw-scrollTop align, which drifts —
      // #18). But the resulting scrollDOM.scrollTop is `lineBlockAt(anchor).top -
      // offset`, and `block.top` is the cumulative height of the lines ABOVE the
      // anchor. Right after setState those above-viewport lines carry CM's rough
      // per-row ESTIMATE (worst under lineWrapping), and they never re-measure on
      // their own because they stay off-screen above — so the absolute scrollTop
      // (and the scrollbar) would sit short of where the snapshot was captured.
      //
      // Warm the height map first: sweep the viewport from the top down past the
      // target in clientHeight steps so every above-anchor line renders once and
      // gets its true height measured. Then dispatch the snapshot and measure — it
      // now resolves against REAL above-heights, so the editor lands on the exact
      // captured pixel. The sweep is synchronous (no paint between the steps and
      // the final snapshot apply), so the intermediate scroll positions never show.
      const dom = v.scrollDOM;
      // In preview-only mode the editor is display:none → clientHeight 0 and no
      // real geometry to measure. Skip the warm sweep (it can't measure a hidden
      // element and would just spin); dispatch the snapshot anyway — CM stores it
      // and applies it on the next real measure, and SplitView's reveal-time
      // [showEditor] realign is the backstop. Harmless either way (no crash).
      if (dom.clientHeight > 0) {
        const step = dom.clientHeight;
        // Only the lines ABOVE the restored anchor affect block.top (and thus the
        // resolved scrollTop), so warm only DOWN TO the restored depth rather than
        // the whole doc — a tab restored near the top of a multi-thousand-line doc
        // is then ~1-2 measure passes instead of hundreds. We warm ONE extra
        // clientHeight band PAST the target (the `top - step >= targetTop` guard
        // runs the loop body for the band that contains targetTop AND the next
        // one) so the final band's heights are fully measured before the snapshot
        // resolves — keeps 0-rAF restore exact (±25px) even at the boundary.
        // When targetTop is undefined, fall back to warming the whole doc.
        // scrollHeight itself starts estimated and GROWS as the sweep measures
        // real (taller, wrapped) line heights, so re-read the bound each step and
        // cap the iterations so a pathological doc can't loop unbounded.
        const MAX_STEPS = 2000;
        for (let top = 0, i = 0; i < MAX_STEPS; top += step, i++) {
          dom.scrollTop = top;
          flushMeasure(); // render+measure this band of lines
          // Reached the bottom of the (re-measured) doc — nothing more to warm.
          if (top >= Math.max(0, dom.scrollHeight - dom.clientHeight)) break;
          // Warmed up to and one band past the restored depth — stop early.
          if (targetTop != null && top - step >= targetTop) break;
        }
      }
      // Apply the captured snapshot against the warmed (real) height map.
      v.dispatch({ effects: effect });
      flushMeasure();
    },
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
    // TEST SEAM (regression #18 only): expose a READ-ONLY probe of the editor's
    // current top source line, computed by CodeMirror itself from its live height
    // map (the same getTopLine() the app uses). The e2e tab-switch race test reads
    // this to learn where the editor ACTUALLY landed after a switch — paint-
    // independent, so it is valid even at 0 rAF when the gutter DOM hasn't repainted
    // and a DOM scrape would be unreliable. This only READS view geometry: it never
    // dispatches, scrolls, or measures, so it cannot affect the very timing under
    // test, and it changes NO product behavior whether or not the test reads it.
    // (It is always installed because it is purely an inert read accessor; nothing
    // in production calls it.)
    (window as unknown as { __mdtoolTestEditorTopLine?: () => number }).__mdtoolTestEditorTopLine =
      () => (viewRef.current ? getTopLine(viewRef.current) : -1);
    return () => {
      view.destroy();
      viewRef.current = null;
      delete (window as unknown as { __mdtoolTestEditorTopLine?: () => number }).__mdtoolTestEditorTopLine;
    };
    // initialDoc is intentionally only read on mount (uncontrolled editor).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="editor-host" ref={hostRef} />;
});

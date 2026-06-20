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
import { history, historyKeymap, defaultKeymap, indentMore, indentLess } from '@codemirror/commands';
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  indentUnit,
  syntaxTree,
} from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import { wrapEdit, headingEdit, fencedEdit, type EditResult } from './editorCommands';

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

function scrollToLine(view: EditorView, line0: number): void {
  const total = view.state.doc.lines;
  const lineNo = clamp(Math.floor(line0) + 1, 1, total); // 1-based
  const frac = line0 - Math.floor(line0);
  const docLine = view.state.doc.line(lineNo);
  const block = view.lineBlockAt(docLine.from);
  view.scrollDOM.scrollTop = block.top + frac * block.height;
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

const boldCmd = formatCommand((d, f, t) => wrapEdit(d, f, t, '**'));
const italicCmd = formatCommand((d, f, t) => wrapEdit(d, f, t, '*'));
const inlineCodeCmd = formatCommand((d, f, t) => wrapEdit(d, f, t, '`'));
const strikeCmd = formatCommand((d, f, t) => wrapEdit(d, f, t, '~~'));
const fencedCmd = formatCommand(fencedEdit);
const headingCmd = (level: number) => formatCommand((d, f, t) => headingEdit(d, f, t, level));

// --- List-aware Tab / Shift+Tab (R26/R28) ----------------------------------
// At the start of a list line, Tab/Shift+Tab change nesting by one indent unit
// (2 spaces); anywhere else they indent/outdent normally and never escape the
// editor.
const LIST_RE = /^(\s*)(?:[-*+]|\d+\.)\s/;

const tabCmd: Command = (view) => {
  const { state } = view;
  const range = state.selection.main;
  if (range.empty) {
    const line = state.doc.lineAt(range.head);
    const m = LIST_RE.exec(line.text);
    if (m && range.head - line.from <= m[1].length) {
      view.dispatch(
        state.update({
          changes: { from: line.from, insert: '  ' },
          selection: { anchor: range.head + 2 },
          userEvent: 'input.indent',
        }),
      );
      return true;
    }
  }
  return indentMore(view);
};

const shiftTabCmd: Command = (view) => {
  const { state } = view;
  const range = state.selection.main;
  if (range.empty) {
    const line = state.doc.lineAt(range.head);
    const m = LIST_RE.exec(line.text);
    if (m && m[1].length > 0 && range.head - line.from <= m[1].length) {
      const remove = Math.min(2, m[1].length);
      view.dispatch(
        state.update({
          changes: { from: line.from, to: line.from + remove },
          selection: { anchor: Math.max(line.from, range.head - remove) },
          userEvent: 'delete.dedent',
        }),
      );
      return true;
    }
  }
  return indentLess(view);
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
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    markdown(),
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
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // initialDoc is intentionally only read on mount (uncontrolled editor).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="editor-host" ref={hostRef} />;
});

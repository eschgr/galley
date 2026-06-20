/**
 * CodeMirror 6 source editor (PRD R16, R19, R20, R21, R22).
 *
 * Composes the editor from CM6 sub-packages (no `basicSetup` meta-package):
 *  - markdown() language for syntax highlighting (R19)
 *  - history + history/default keymaps for undo/redo (R20)
 *  - search panel + keymap for find/replace (R21; Cmd/Ctrl+F)
 *  - line numbers (R22), line wrapping, 2-space indent unit (R28)
 *  - indentWithTab so Tab indents and never escapes the editor (R26 baseline;
 *    list-aware Tab is part of the later formatting-shortcuts step)
 *
 * Exposes an imperative handle (getTopLine / scrollToLine) in 0-based fractional
 * line units — the same units the preview's data-source-line anchors use — so
 * SplitView can keep the two panes aligned (R18). Calls onScroll on user scroll
 * and onChange on edits.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  keymap,
} from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentUnit } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';

export interface EditorHandle {
  /** Top of the viewport as a 0-based fractional source line. */
  getTopLine(): number;
  /** Scroll so a 0-based fractional source line sits at the viewport top. */
  scrollToLine(line: number): void;
  /** Re-measure layout — call after the editor is re-shown from display:none. */
  refresh(): void;
}

interface EditorProps {
  initialDoc: string;
  onChange?: (doc: string) => void;
  onScroll?: () => void;
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

export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(
  { initialDoc, onChange, onScroll },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Keep latest callbacks without re-creating the editor.
  const onChangeRef = useRef(onChange);
  const onScrollRef = useRef(onScroll);
  onChangeRef.current = onChange;
  onScrollRef.current = onScroll;

  useImperativeHandle(ref, () => ({
    getTopLine: () => (viewRef.current ? getTopLine(viewRef.current) : 0),
    scrollToLine: (line) => {
      if (viewRef.current) scrollToLine(viewRef.current, line);
    },
    refresh: () => viewRef.current?.requestMeasure(),
  }));

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
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
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
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
        ],
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

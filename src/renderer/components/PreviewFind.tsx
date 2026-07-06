/**
 * Find-in-preview bar (#57). A per-tab search over the RENDERED preview text:
 * Ctrl/Cmd+F opens it (routed here by TabView when the editor isn't focused),
 * typing highlights every match, Enter / Shift+Enter (or the ▲/▼ buttons) cycle
 * and scroll the current match into view, and Esc closes it.
 *
 * Highlighting uses the CSS Custom Highlight API (`CSS.highlights` + the
 * `::highlight()` pseudo) rather than wrapping matches in <mark>: the preview HTML
 * is set via dangerouslySetInnerHTML, so mutating it would fight React and corrupt
 * the data-source-line anchor map used for scroll-sync. Highlight ranges paint over
 * the live DOM without changing it — no reflow, no anchor breakage.
 *
 * The match math (query → ranges, next/prev wraparound, the "n of N" label) is the
 * pure, unit-tested previewFind module; this component only owns the DOM plumbing:
 * flattening text nodes, mapping string offsets back to Ranges, and scrolling.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { findMatches, stepMatch, matchLabel } from './previewMatch';

// Global highlight-registry names (one document-wide registry). Only the visible
// tab's open bar populates them; a hidden/closed bar clears them, so the two tabs
// never fight over the registry.
const HL_ALL = 'preview-find-all';
const HL_CURRENT = 'preview-find-current';

export interface PreviewFindHandle {
  /** Open the bar (or, if already open, re-focus and select its input). */
  open(): void;
  /** Close the bar and drop the highlights. */
  close(): void;
  isOpen(): boolean;
}

interface PreviewFindProps {
  /** The `.pane-preview` element; the bar queries its `.preview-scroll` +
   *  `.markdown-preview` to search and scroll. */
  hostRef: RefObject<HTMLDivElement | null>;
  /** Changes whenever the rendered content changes (the doc text), so an open bar
   *  recomputes matches against the new DOM. */
  contentVersion: unknown;
  /** True when this tab is inactive (display:none). Highlights are cleared so the
   *  global registry belongs to the visible tab. */
  hidden: boolean;
}

// True when the CSS Custom Highlight API is available (Chromium ≥105 / this
// Electron). Guarded so a stray environment degrades to "no highlight" instead of
// throwing on mount.
const HAS_HIGHLIGHT =
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

interface TextSpan {
  node: Text;
  start: number;
  end: number;
}

// Flatten the preview's visible text into one string plus a per-text-node index
// map. Skips <style>/<script> and KaTeX internals (whose duplicated/− garbled text
// would produce phantom matches).
function buildTextIndex(root: HTMLElement): { text: string; spans: TextSpan[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const spans: TextSpan[] = [];
  let text = '';
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const parent = n.parentElement;
    const val = n.nodeValue ?? '';
    if (!val || !parent) continue;
    const tag = parent.tagName;
    if (tag === 'STYLE' || tag === 'SCRIPT' || parent.closest('.katex')) continue;
    spans.push({ node: n, start: text.length, end: text.length + val.length });
    text += val;
  }
  return { text, spans };
}

// Map a [start,end) span of the flattened string onto a DOM Range (possibly across
// adjacent text nodes).
function rangeFor(spans: TextSpan[], start: number, end: number): Range | null {
  const s = spans.find((sp) => start >= sp.start && start < sp.end);
  const e = spans.find((sp) => end - 1 >= sp.start && end - 1 < sp.end);
  if (!s || !e) return null;
  const r = document.createRange();
  r.setStart(s.node, start - s.start);
  r.setEnd(e.node, end - e.start);
  return r;
}

function clearHighlights(): void {
  if (!HAS_HIGHLIGHT) return;
  CSS.highlights.delete(HL_ALL);
  CSS.highlights.delete(HL_CURRENT);
}

// Scroll the scroller so `range` sits comfortably inside the viewport, nudging only
// when it's out of (or near) the edges — so cycling doesn't jump the page when the
// match is already visible.
function scrollRangeIntoView(scroller: HTMLElement, range: Range): void {
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return; // collapsed / not laid out
  const box = scroller.getBoundingClientRect();
  const margin = Math.min(scroller.clientHeight * 0.25, 120);
  if (rect.top < box.top + margin) {
    scroller.scrollTop -= box.top + margin - rect.top;
  } else if (rect.bottom > box.bottom - margin) {
    scroller.scrollTop += rect.bottom - (box.bottom - margin);
  }
}

export const PreviewFind = forwardRef<PreviewFindHandle, PreviewFindProps>(function PreviewFind(
  { hostRef, contentVersion, hidden },
  ref,
) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [index, setIndex] = useState(0);
  const [total, setTotal] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  // The current match's DOM ranges, cached so ▲/▼ can re-scroll without rebuilding.
  const rangesRef = useRef<Range[]>([]);

  const scroller = useCallback(
    () => hostRef.current?.querySelector<HTMLElement>('.preview-scroll') ?? null,
    [hostRef],
  );

  // Recompute matches + repaint highlights. Runs whenever the query, case mode,
  // rendered content, open state, or active-index changes. Rebuilding the text
  // index on a mere step is cheap next to layout and keeps the ranges correct after
  // a live edit reflows the preview.
  useEffect(() => {
    if (!open || hidden || !HAS_HIGHLIGHT) {
      clearHighlights();
      return;
    }
    const content = hostRef.current?.querySelector<HTMLElement>('.markdown-preview');
    if (!content || !query) {
      clearHighlights();
      rangesRef.current = [];
      setTotal(0);
      return;
    }
    const { text, spans } = buildTextIndex(content);
    const ranges = findMatches(text, query, caseSensitive)
      .map((m) => rangeFor(spans, m.start, m.end))
      .filter((r): r is Range => r !== null);
    rangesRef.current = ranges;
    setTotal(ranges.length);

    if (ranges.length === 0) {
      clearHighlights();
      return;
    }
    const active = Math.min(index, ranges.length - 1);
    CSS.highlights.set(HL_ALL, new Highlight(...ranges));
    const current = new Highlight(ranges[active]);
    current.priority = 1; // paint the active match over the rest
    CSS.highlights.set(HL_CURRENT, current);
    const sc = scroller();
    if (sc) scrollRangeIntoView(sc, ranges[active]);
  }, [open, hidden, query, caseSensitive, index, contentVersion, hostRef, scroller]);

  // Drop highlights when the tab unmounts.
  useEffect(() => () => clearHighlights(), []);

  useImperativeHandle(ref, () => ({
    open: () => {
      setOpen(true);
      // Focus + select on the next tick so a freshly mounted input exists.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    },
    close: () => doClose(),
    isOpen: () => open,
  }));

  const doClose = () => {
    setOpen(false);
    clearHighlights();
    scroller()?.focus(); // hand focus back so keyboard scrolling resumes
  };

  const step = (forward: boolean) => {
    setIndex((i) => stepMatch(i, rangesRef.current.length, forward));
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      step(!e.shiftKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      doClose();
    }
  };

  if (!open) return null;

  return (
    <div className="preview-find" role="search">
      <input
        ref={inputRef}
        className="preview-find-input"
        type="text"
        aria-label="Find in preview"
        placeholder="Find in preview"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0); // a new query starts at its first match
        }}
        onKeyDown={onInputKeyDown}
      />
      <span className="preview-find-count" aria-live="polite">
        {matchLabel(index, total)}
      </span>
      <button
        type="button"
        className={caseSensitive ? 'preview-find-case is-active' : 'preview-find-case'}
        aria-pressed={caseSensitive}
        title="Match case"
        onClick={() => {
          setCaseSensitive((v) => !v);
          setIndex(0);
        }}
      >
        Aa
      </button>
      <button
        type="button"
        className="preview-find-prev"
        title="Previous match (Shift+Enter)"
        disabled={total === 0}
        onClick={() => step(false)}
      >
        ▲
      </button>
      <button
        type="button"
        className="preview-find-next"
        title="Next match (Enter)"
        disabled={total === 0}
        onClick={() => step(true)}
      >
        ▼
      </button>
      <button type="button" className="preview-find-close" title="Close (Esc)" onClick={doClose}>
        ✕
      </button>
    </div>
  );
});

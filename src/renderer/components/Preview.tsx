/**
 * Live rendered preview (PRD R1–R3, R17). Renders the markdown pipeline output
 * and keeps a line-anchor map (from data-source-line) so SplitView can align it
 * with the editor (R18). Anchor clicks are routed to the system browser (R4) —
 * the renderer never navigates itself.
 */
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';
import '../markdown/preview.css';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { renderMarkdown } from '../markdown/pipeline';

export interface PreviewHandle {
  /** Top of the viewport as a 0-based fractional source line. */
  getTopLine(): number;
  /** Scroll so a 0-based fractional source line sits at the viewport top. */
  scrollToLine(line: number): void;
}

interface PreviewProps {
  source: string;
  onScroll?: () => void;
  /** Fired after the anchor map is (re)built — i.e. once the pane has reflowed
   *  and its line geometry is current. Used to re-align the editor on reveal. */
  onLayout?: () => void;
}

interface Anchor {
  line: number;
  top: number;
}

function buildAnchors(scroller: HTMLElement, content: HTMLElement): Anchor[] {
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const els = content.querySelectorAll<HTMLElement>('[data-source-line]');
  const anchors: Anchor[] = [];
  els.forEach((el) => {
    const line = Number(el.getAttribute('data-source-line'));
    if (Number.isNaN(line)) return;
    anchors.push({ line, top: el.getBoundingClientRect().top - base });
  });
  anchors.sort((a, b) => a.line - b.line || a.top - b.top);
  return anchors;
}

/** Interpolate the viewport-top source line from a scrollTop. */
function topLineFrom(anchors: Anchor[], scrollTop: number): number {
  if (anchors.length === 0) return 0;
  if (scrollTop <= anchors[0].top) return anchors[0].line;
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (scrollTop < b.top) {
      const span = b.top - a.top;
      const f = span > 0 ? (scrollTop - a.top) / span : 0;
      return a.line + f * (b.line - a.line);
    }
  }
  return anchors[anchors.length - 1].line;
}

/** Inverse: the scrollTop that puts a (fractional) source line at the top. */
function scrollTopFor(anchors: Anchor[], line: number): number {
  if (anchors.length === 0) return 0;
  if (line <= anchors[0].line) return anchors[0].top;
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (line < b.line) {
      const span = b.line - a.line;
      const f = span > 0 ? (line - a.line) / span : 0;
      return a.top + f * (b.top - a.top);
    }
  }
  return anchors[anchors.length - 1].top;
}

export const Preview = forwardRef<PreviewHandle, PreviewProps>(function Preview(
  { source, onScroll, onLayout },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const anchorsRef = useRef<Anchor[]>([]);
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;
  const onLayoutRef = useRef(onLayout);
  onLayoutRef.current = onLayout;

  const html = useMemo(() => renderMarkdown(source), [source]);

  // Rebuild anchors after each render and whenever the pane reflows.
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const rebuild = () => {
      anchorsRef.current = buildAnchors(scroller, content);
      onLayoutRef.current?.();
    };
    rebuild();
    const ro = new ResizeObserver(rebuild);
    ro.observe(scroller);
    ro.observe(content);
    return () => ro.disconnect();
  }, [html]);

  useImperativeHandle(ref, () => ({
    getTopLine: () => (scrollRef.current ? topLineFrom(anchorsRef.current, scrollRef.current.scrollTop) : 0),
    scrollToLine: (line) => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollTopFor(anchorsRef.current, line);
    },
  }));

  // R4: open links externally; never navigate the renderer.
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (!anchor) return;
    e.preventDefault();
    const href = anchor.getAttribute('href');
    if (href) void window.mdtool?.openExternal(href);
  };

  return (
    <div
      className="preview-scroll"
      ref={scrollRef}
      onScroll={() => onScrollRef.current?.()}
    >
      <div
        className="markdown-preview"
        ref={contentRef}
        onClick={onClick}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
});

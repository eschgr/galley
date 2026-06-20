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
import { type Anchor, topLineFrom, scrollTopFor } from './scrollSync';

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

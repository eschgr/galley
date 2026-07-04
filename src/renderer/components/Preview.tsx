/**
 * Live rendered preview (markdown rendering — GFM, math, code highlighting;
 * live preview as you type). Renders the markdown pipeline output and keeps a
 * line-anchor map (from data-source-line) so the split view can align it with the
 * editor. Anchor clicks are routed to the system browser — the renderer never
 * navigates itself.
 *
 * Each open tab owns its OWN Preview (one per TabView, #26), so the per-tab
 * reading-position stash/restore that used to live here — restoreScrollTop +
 * reassertRestore + watchImagesForRestore + the onScroll-cancel (#18 reflow-settle
 * machinery) — is gone: a hidden TabView simply keeps its scroller mounted, so
 * its scroll position persists across a switch with no HTML re-swap to clamp.
 */
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';
import '../markdown/preview.css';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { renderMarkdown } from '../markdown/pipeline';
import { type Anchor, topLineFrom, scrollTopFor } from './scrollSync';
import { classifyHref } from './linkRouting';

export interface PreviewHandle {
  /** Top of the viewport as a 0-based fractional source line. */
  getTopLine(): number;
  /** Scroll so a 0-based fractional source line sits at the viewport top. */
  scrollToLine(line: number): void;
  /** Raw scroll offset in px. */
  getScrollTop(): number;
  setScrollTop(px: number): void;
  /** Max scrollTop of the scroller (scrollHeight - clientHeight), clamped >= 0. */
  maxScroll(): number;
  /** Visible height of the scroller (px) — one screenful, used as the blend window (#18). */
  clientHeight(): number;
  /** The px scrollTop that would put a 0-based fractional source line at the top
   *  — the line-anchored target, without actually scrolling (scroll sync / #18). */
  scrollTopForLine(line: number): number;
  /** Jump to the heading whose slug is `id` (a file-link `#fragment` target).
   *  Returns false if no such heading exists. */
  scrollToAnchor(id: string): boolean;
}

interface PreviewProps {
  source: string;
  onScroll?: () => void;
  /** Fired after the anchor map is (re)built — i.e. once the pane has reflowed
   *  and its line geometry is current. Used to re-align the editor on reveal. */
  onLayout?: () => void;
  /** A local-file link was clicked — open it (host resolves it relative to the
   *  active document and opens a tab). External links go to the browser. */
  onOpenLocal?: (href: string) => void;
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
  { source, onScroll, onLayout, onOpenLocal },
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

  // Rebuild anchors after each render and whenever the pane reflows — still needed
  // for scroll-sync (the editor re-aligns to the preview's top line on reveal).
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
    return () => {
      ro.disconnect();
    };
  }, [html]);

  // Scroll the heading whose slug is `id` to the top of the pane. Used by both
  // anchor-link clicks and (via the handle) a freshly opened file:fragment link.
  // Returns whether a matching heading was found.
  const jumpToAnchor = (id: string, behavior: ScrollBehavior): boolean => {
    const target = contentRef.current?.querySelector(`[id="${CSS.escape(id)}"]`);
    if (!target) return false;
    target.scrollIntoView({ behavior, block: 'start' });
    return true;
  };

  useImperativeHandle(ref, () => ({
    getTopLine: () => (scrollRef.current ? topLineFrom(anchorsRef.current, scrollRef.current.scrollTop) : 0),
    scrollToLine: (line) => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollTopFor(anchorsRef.current, line);
    },
    getScrollTop: () => scrollRef.current?.scrollTop ?? 0,
    setScrollTop: (px) => {
      if (scrollRef.current) scrollRef.current.scrollTop = px;
    },
    maxScroll: () => {
      const s = scrollRef.current;
      return s ? Math.max(0, s.scrollHeight - s.clientHeight) : 0;
    },
    clientHeight: () => scrollRef.current?.clientHeight ?? 0,
    scrollTopForLine: (line) => scrollTopFor(anchorsRef.current, line),
    scrollToAnchor: (id) => jumpToAnchor(id, 'auto'), // a just-opened file lands at the target, no animation
  }));

  // In-page anchor links (`#heading`) jump within the preview; every other link
  // opens in the system browser (the renderer never navigates itself).
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href) return;
    e.preventDefault();
    switch (classifyHref(href)) {
      case 'anchor': {
        jumpToAnchor(decodeURIComponent(href.slice(1)), 'smooth');
        break;
      }
      case 'external':
        void window.galley?.openExternal(href); // → system browser
        break;
      case 'local':
        onOpenLocal?.(href); // file path / file:// → open as a tab
        break;
    }
  };

  return (
    <div
      className="preview-scroll"
      ref={scrollRef}
      // Focusable so arrow keys / Page Up-Down scroll the reading pane (and the
      // editor follows via SplitView's keydown → active-pane handling).
      tabIndex={0}
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

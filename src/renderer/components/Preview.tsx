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
import { classifyHref } from './linkRouting';

export interface PreviewHandle {
  /** Top of the viewport as a 0-based fractional source line. */
  getTopLine(): number;
  /** Scroll so a 0-based fractional source line sits at the viewport top. */
  scrollToLine(line: number): void;
  /** Raw scroll offset in px — used to stash/restore reading position per tab. */
  getScrollTop(): number;
  setScrollTop(px: number): void;
  /** Restore the stashed reading position (px) and KEEP re-asserting it through
   *  the reflow-settle window (#18): the tab-switch HTML swap creates brand-new
   *  image/KaTeX nodes whose height is not final in the restore's frame, so a
   *  one-shot scrollTop is CLAMPED too high and never recovers. This sets the px
   *  immediately, then re-applies it on every reflow signal (anchor rebuild /
   *  ResizeObserver / image decode) until scrollHeight has grown enough that the
   *  px is no longer clamped, or a bounded deadline passes. A genuine user scroll
   *  during the window cancels it (we never fight the reader). */
  restoreScrollTop(px: number): void;
  /** Max scrollTop of the scroller (scrollHeight - clientHeight), clamped >= 0. */
  maxScroll(): number;
  /** Visible height of the scroller (px) — one screenful, used as the blend window (#18). */
  clientHeight(): number;
  /** The px scrollTop that would put a 0-based fractional source line at the top
   *  — the line-anchored target, without actually scrolling (R18 / #18). */
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
   *  active document and opens a tab). External links go to the browser (R4). */
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

  // Pending preview-restore through the reflow-settle window (#18). `target` is
  // the stashed px we owe; `deadline` bounds the re-assert window (mirrors
  // SplitView's 800ms reveal horizon); `lastApplied` is the value WE last wrote,
  // so a scroll to any OTHER value is a genuine user scroll and cancels us.
  const restoreRef = useRef<{ target: number; deadline: number; lastApplied: number } | null>(null);

  // Re-assert the pending target if it is still owed and not yet settled. Returns
  // true while a restore is still pending (caller may keep watching), false once
  // it has been cleared (settled, deadline passed, or cancelled).
  const reassertRestore = (): boolean => {
    const scroller = scrollRef.current;
    const pending = restoreRef.current;
    if (!scroller || !pending) return false;
    if (Date.now() > pending.deadline) {
      restoreRef.current = null;
      return false;
    }
    const max = scroller.scrollHeight - scroller.clientHeight;
    // Re-apply the owed px (the browser still clamps to the CURRENT max, but as
    // content grows each re-assert lands closer until the target fits).
    pending.lastApplied = Math.min(pending.target, Math.max(0, max));
    scroller.scrollTop = pending.target;
    // Once the scroller is tall enough that the target is no longer clamped, the
    // assignment above landed exactly on target — we're done.
    if (max >= pending.target) {
      restoreRef.current = null;
      return false;
    }
    return true;
  };

  // Attach decode/onload handlers to the restored content's images so we can
  // re-assert the target the instant a `data:` image grows the scroller — these
  // may resolve WITHOUT a separate observed resize tick.
  const watchImagesForRestore = () => {
    const content = contentRef.current;
    if (!content || !restoreRef.current) return;
    const imgs = content.querySelectorAll('img');
    imgs.forEach((img) => {
      const onGrow = () => reassertRestore();
      if (img.complete && img.naturalHeight > 0) {
        // Already decoded in cache — re-assert on the next frame (its box height
        // is applied by then).
        requestAnimationFrame(onGrow);
        return;
      }
      img.addEventListener('load', onGrow, { once: true });
      // decode() is the earliest signal; on failure the 'load' listener and the
      // ResizeObserver still cover the re-assert, so swallow the rejection.
      img.decode?.().then(onGrow).catch(() => undefined);
    });
  };

  const html = useMemo(() => renderMarkdown(source), [source]);

  // Rebuild anchors after each render and whenever the pane reflows.
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const rebuild = () => {
      // Re-assert any pending preview-restore (#18) BEFORE rebuilding anchors and
      // notifying the layout listener, so the anchor map and the editor re-align
      // to the corrected preview position rather than the clamped one.
      reassertRestore();
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
    restoreRef.current = null; // a fragment jump supersedes any pending restore
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
      restoreRef.current = null; // a plain set supersedes any pending restore
      if (scrollRef.current) scrollRef.current.scrollTop = px;
    },
    restoreScrollTop: (px) => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      if (px <= 0) {
        // Top: no reflow can clamp 0, so a plain set is enough — and don't arm a
        // window that a fresh-tab top restore doesn't need.
        restoreRef.current = null;
        scroller.scrollTop = 0;
        return;
      }
      restoreRef.current = { target: px, deadline: Date.now() + 800, lastApplied: 0 };
      reassertRestore(); // set it now (clamped if short), then re-assert on reflow
      watchImagesForRestore(); // catch data: images that grow without a resize tick
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
  // opens in the system browser (R4 — the renderer never navigates itself).
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
        void window.mdtool?.openExternal(href); // → system browser (R4)
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
      onScroll={() => {
        // A pending restore (#18) re-asserts our OWN target; any scroll to a
        // DIFFERENT value is a genuine user scroll — stop fighting them.
        const pending = restoreRef.current;
        const scroller = scrollRef.current;
        if (pending && scroller && Math.abs(scroller.scrollTop - pending.lastApplied) > 2) {
          restoreRef.current = null;
        }
        onScrollRef.current?.();
      }}
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

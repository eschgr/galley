/**
 * Split view (PRD R45): live rendered view and source editor side by side with a
 * draggable divider, and synchronized scrolling (R18).
 *
 * Pane order is fixed — **rendered view on the left, source editor on the
 * right** — since reading is the primary use. (A dynamic in-app swap of the two
 * is out of scope; see PRD §3/§12.)
 *
 * Two view modes — 'split' (view + editor side by side) and 'preview' (the
 * rendered view fills the window, for reading). The editor stays mounted across
 * switches (hidden with display:none, not unmounted) so edits, undo history, and
 * scroll position survive; it is re-measured when it becomes visible again.
 *
 * Scroll sync uses a single "active leader" pane, chosen by user presence: the
 * pane the pointer is over (covers wheel AND native scrollbar drag — both happen
 * over that pane), falling back to the focused pane when the pointer is over
 * neither (keyboard scrolling). ONLY the leader's scroll drives the follower; the
 * follower's own scroll events — the programmatic echo, and the reflow-induced
 * scrolls fired when images/math decode — are ignored, because the follower is
 * never the pointer-over pane while you are driving. That immunity to
 * follower-induced scrolls is what keeps it from feedback-jumping, with no
 * suppress flags or timing hacks. (Trade-off: typing in the editor while the
 * mouse hovers the preview won't drive the preview until the mouse moves — a
 * minor edge, far better than the feedback jumping it replaces.)
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Editor, type EditorHandle } from './Editor';
import { Preview, type PreviewHandle } from './Preview';
import { blendedFollowerTop } from './scrollSync';
export type { PreviewHandle };

export type ViewMode = 'split' | 'preview';

interface SplitViewProps {
  /** Initial editor content, used once to mount the editor. */
  initialDoc: string;
  /** Current document text (controlled) — drives the preview. */
  source: string;
  /** Called when the user edits the source. */
  onSourceChange: (text: string) => void;
  /** Editor handle, owned by App so it can load files / drive the editor. */
  editorRef: RefObject<EditorHandle>;
  /** Preview handle, owned by App so it can stash/restore reading position per tab. */
  previewRef: RefObject<PreviewHandle>;
  viewMode: ViewMode;
  /** Cmd/Ctrl+K in the editor — host opens the link dialog (R27). */
  onLink?: () => void;
  /** A local-file link was clicked in the preview (R4). */
  onOpenLocal?: (href: string) => void;
}

const MIN_PCT = 20;
const MAX_PCT = 80;

export function SplitView({ initialDoc, source, onSourceChange, editorRef, previewRef, viewMode, onLink, onOpenLocal }: SplitViewProps) {
  // The active leader is the pane the pointer is over (covers wheel + scrollbar
  // drag), falling back to the focused pane (keyboard) when the pointer is over
  // neither. Only the leader drives the follower; the follower's own scroll
  // events are ignored because it isn't the pointer-over pane — no feedback loop.
  const pointerPane = useRef<'editor' | 'preview' | null>(null);
  const focusedPane = useRef<'editor' | 'preview' | null>(null);
  const activeLeader = () => pointerPane.current ?? focusedPane.current;
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  // Width of the editor — the RIGHT pane; the preview (left) flexes to fill.
  const [editorPct, setEditorPct] = useState(50);

  const showEditor = viewMode === 'split';
  const showPreview = true; // the rendered view is shown in both modes
  const showDivider = viewMode === 'split';

  // Re-align the editor to the line the preview is currently showing when the
  // editor returns to view (reveal) — otherwise it comes back from display:none
  // showing its old scroll position and only re-syncs on the next scroll.
  //
  // This is REVEAL-ONLY (keyed on [showEditor]). The tab-switch editor restore
  // lives in App, which restores the editor from its OWN stashed CM6 scroll
  // snapshot (view.scrollSnapshot(), #18) — decoupled from the preview's async
  // anchor rebuild and surviving CM6's height refinement. Deriving the editor's
  // line from preview.getTopLine() on a switch raced that rebuild and landed the
  // editor on the OLD tab's geometry; App's own-stash restore removes the race,
  // so the switch case is no longer here.
  //
  // Timing on reveal is awkward: the editor must re-measure (it was
  // display:none), and the preview reflows a beat later — its pane changes width
  // and, in the real app, the window also doubles on reveal (async, via the main
  // process). So align immediately, on the next frame, and again whenever the
  // preview reports its layout has settled (see onPreviewLayout) for a short
  // window — reading the preview's current top line each time so the editor
  // lands on its final spot.
  const realignUntil = useRef(0);
  useEffect(() => {
    if (!showEditor) return; // preview-only: never scroll the hidden editor
    const ed = editorRef.current;
    const pv = previewRef.current;
    if (!ed) return;
    const align = () => {
      ed.refresh();
      ed.alignTo(pv?.getTopLine() ?? 0);
    };
    realignUntil.current = Date.now() + 800;
    align();
    const raf = requestAnimationFrame(align);
    return () => cancelAnimationFrame(raf);
  }, [showEditor]);

  // The preview re-built its anchor map (it reflowed). Re-align the editor to it,
  // but only briefly after a reveal — so a later manual resize doesn't yank the
  // editor's scroll position.
  const onPreviewLayout = () => {
    if (viewMode !== 'split' || Date.now() > realignUntil.current) return;
    editorRef.current?.alignTo(previewRef.current?.getTopLine() ?? 0);
  };

  // Drive the follower from the leader: keep the line-anchored alignment in the
  // middle, but blend the follower toward its OWN max over the leader's final
  // screenful so both panes reach the bottom together (#18). blendPx = the
  // leader's viewport height (one screenful), but capped at leaderMax so the
  // blend window never extends above scrollTop 0 — otherwise a leader whose
  // content barely exceeds its viewport (clientHeight > maxScroll) would pull the
  // follower off its top even at leaderTop=0.
  const syncFollower = (
    leader: EditorHandle | PreviewHandle,
    follower: EditorHandle | PreviewHandle,
  ) => {
    const lineAnchoredTop = follower.scrollTopForLine(leader.getTopLine());
    const followerMax = follower.maxScroll();
    const leaderMax = leader.maxScroll();
    const blendPx = Math.max(1, Math.min(leader.clientHeight(), leaderMax));
    const target = blendedFollowerTop(lineAnchoredTop, followerMax, leader.getScrollTop(), leaderMax, blendPx);
    // Skip a no-op write; the follower's resulting echo scroll is ignored anyway
    // (it isn't the active leader), so no flag is needed.
    if (Math.abs(target - follower.getScrollTop()) >= 1) follower.setScrollTop(target);
  };

  const onEditorScroll = () => {
    if (viewMode !== 'split' || activeLeader() !== 'editor') return;
    const ed = editorRef.current;
    const pv = previewRef.current;
    if (ed && pv) syncFollower(ed, pv);
  };
  const onPreviewScroll = () => {
    if (viewMode !== 'split' || activeLeader() !== 'preview') return;
    const ed = editorRef.current;
    const pv = previewRef.current;
    if (ed && pv) syncFollower(pv, ed);
  };

  const onDividerDown = (e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDividerMove = (e: React.PointerEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    // Editor is the right pane: its width grows as the divider moves left.
    const pct = ((rect.right - e.clientX) / rect.width) * 100;
    setEditorPct(Math.max(MIN_PCT, Math.min(MAX_PCT, pct)));
  };
  const onDividerUp = (e: React.PointerEvent) => {
    dragging.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  };

  return (
    <div className="split-view" ref={containerRef}>
      <div
        className="pane pane-preview"
        style={{ display: showPreview ? 'block' : 'none' }}
        onPointerEnter={() => (pointerPane.current = 'preview')}
        onPointerLeave={() => { if (pointerPane.current === 'preview') pointerPane.current = null; }}
        onFocusCapture={() => (focusedPane.current = 'preview')}
      >
        <Preview
          ref={previewRef}
          source={source}
          onScroll={onPreviewScroll}
          onLayout={onPreviewLayout}
          onOpenLocal={onOpenLocal}
        />
      </div>
      <div
        className="split-divider"
        role="separator"
        aria-orientation="vertical"
        style={{ display: showDivider ? 'block' : 'none' }}
        onPointerDown={onDividerDown}
        onPointerMove={onDividerMove}
        onPointerUp={onDividerUp}
      />
      <div
        className="pane pane-editor"
        style={{
          display: showEditor ? 'block' : 'none',
          width: viewMode === 'split' ? `${editorPct}%` : '100%',
        }}
        onPointerEnter={() => (pointerPane.current = 'editor')}
        onPointerLeave={() => { if (pointerPane.current === 'editor') pointerPane.current = null; }}
        onFocusCapture={() => (focusedPane.current = 'editor')}
      >
        <Editor
          ref={editorRef}
          initialDoc={initialDoc}
          onChange={onSourceChange}
          onScroll={onEditorScroll}
          onLink={onLink}
        />
      </div>
    </div>
  );
}

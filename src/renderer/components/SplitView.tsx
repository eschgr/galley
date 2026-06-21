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
 * Scroll sync uses an "active pane" lead: only the pane the user is interacting
 * with (hover / focus) drives the other. This avoids the feedback loop a naive
 * two-way sync would create (programmatic scroll of B firing B's scroll handler
 * and echoing back), without timing hacks.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Editor, type EditorHandle } from './Editor';
import { Preview, type PreviewHandle } from './Preview';

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
  viewMode: ViewMode;
  /** Cmd/Ctrl+K in the editor — host opens the link dialog (R27). */
  onLink?: () => void;
  /** A local-file link was clicked in the preview (R4). */
  onOpenLocal?: (href: string) => void;
}

const MIN_PCT = 20;
const MAX_PCT = 80;

export function SplitView({ initialDoc, source, onSourceChange, editorRef, viewMode, onLink, onOpenLocal }: SplitViewProps) {
  const previewRef = useRef<PreviewHandle>(null);
  const active = useRef<'editor' | 'preview' | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  // Width of the editor — the RIGHT pane; the preview (left) flexes to fill.
  const [editorPct, setEditorPct] = useState(50);

  const showEditor = viewMode === 'split';
  const showPreview = true; // the rendered view is shown in both modes
  const showDivider = viewMode === 'split';

  // When the editor returns to view, re-measure it and align it to the line the
  // preview is currently showing — otherwise it reveals at its old scroll
  // position and only re-syncs on the next scroll.
  //
  // Timing is awkward: the editor must re-measure (it was display:none), and the
  // preview reflows a beat later — its pane changes width and, in the real app,
  // the window also doubles on reveal (async, via the main process). So align
  // immediately, on the next frame, and again whenever the preview reports its
  // layout has settled (see onPreviewLayout) for a short window after reveal —
  // reading the preview's current top line each time so the editor lands on the
  // preview's final position.
  const realignUntil = useRef(0);
  useEffect(() => {
    if (!showEditor) return;
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

  const onEditorScroll = () => {
    if (viewMode !== 'split' || active.current !== 'editor') return;
    previewRef.current?.scrollToLine(editorRef.current?.getTopLine() ?? 0);
  };
  const onPreviewScroll = () => {
    if (viewMode !== 'split' || active.current !== 'preview') return;
    editorRef.current?.scrollToLine(previewRef.current?.getTopLine() ?? 0);
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
        // Lead on a deliberate scroll of this pane, not mere hover — otherwise
        // hovering the preview while typing in the editor would steal the lead
        // and the two would drift out of sync. Wheel or keyboard (arrows /
        // Page Up-Down) both count.
        onWheelCapture={() => (active.current = 'preview')}
        onKeyDownCapture={() => (active.current = 'preview')}
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
        // Typing or arrow-key navigation (which can scroll the editor) makes the
        // editor the lead pane, so the preview follows the cursor.
        onKeyDownCapture={() => (active.current = 'editor')}
        onWheelCapture={() => (active.current = 'editor')}
        onFocusCapture={() => (active.current = 'editor')}
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

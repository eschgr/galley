/**
 * Split view (PRD R45): source editor and live preview side by side with a
 * draggable divider, and synchronized scrolling (R18).
 *
 * Two view modes — 'split' (editor + view side by side) and 'preview' (the
 * rendered view fills the window, for reading). The editor stays mounted across
 * switches (hidden with display:none, not unmounted) so edits, undo history, and
 * scroll position survive; it is re-measured when it becomes visible again.
 *
 * Scroll sync uses an "active pane" lead: only the pane the user is interacting
 * with (hover / focus) drives the other. This avoids the feedback loop a naive
 * two-way sync would create (programmatic scroll of B firing B's scroll handler
 * and echoing back), without timing hacks.
 */
import { useEffect, useRef, useState } from 'react';
import { Editor, type EditorHandle } from './Editor';
import { Preview, type PreviewHandle } from './Preview';

export type ViewMode = 'split' | 'preview';

interface SplitViewProps {
  initialDoc: string;
  viewMode: ViewMode;
}

const MIN_PCT = 20;
const MAX_PCT = 80;

export function SplitView({ initialDoc, viewMode }: SplitViewProps) {
  const editorRef = useRef<EditorHandle>(null);
  const previewRef = useRef<PreviewHandle>(null);
  const active = useRef<'editor' | 'preview' | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const [source, setSource] = useState(initialDoc);
  const [leftPct, setLeftPct] = useState(50);

  const showEditor = viewMode === 'split';
  const showPreview = true; // the rendered view is shown in both modes
  const showDivider = viewMode === 'split';

  // Re-measure the editor when it returns to view (display:none hides resize).
  useEffect(() => {
    if (showEditor) editorRef.current?.refresh();
  }, [showEditor]);

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
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setLeftPct(Math.max(MIN_PCT, Math.min(MAX_PCT, pct)));
  };
  const onDividerUp = (e: React.PointerEvent) => {
    dragging.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  };

  return (
    <div className="split-view" ref={containerRef}>
      <div
        className="pane pane-editor"
        style={{
          display: showEditor ? 'block' : 'none',
          width: viewMode === 'split' ? `${leftPct}%` : '100%',
        }}
        onMouseEnter={() => (active.current = 'editor')}
        onFocusCapture={() => (active.current = 'editor')}
      >
        <Editor
          ref={editorRef}
          initialDoc={initialDoc}
          onChange={setSource}
          onScroll={onEditorScroll}
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
        className="pane pane-preview"
        style={{ display: showPreview ? 'block' : 'none' }}
        onMouseEnter={() => (active.current = 'preview')}
      >
        <Preview ref={previewRef} source={source} onScroll={onPreviewScroll} />
      </div>
    </div>
  );
}

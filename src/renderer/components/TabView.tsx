/**
 * One self-contained view per open tab. Each TabView owns its OWN editor +
 * preview + the split layout + the editor↔preview scroll-sync. All open
 * tabs' TabViews stay mounted; only the active one is visible (the rest are
 * display:none via the `hidden` flag). Switching tabs just changes which one is
 * visible — no re-parse, no DOM rebuild, no state-swap. This replaces the old
 * single shared Editor + Preview whose state App swapped on every switch.
 *
 * Source of truth for text: the editor is UNCONTROLLED — initialised from `text`
 * once on mount, never reset on a prop change (CM6 would clobber the cursor/undo).
 * Edits flow UP via onSourceChange; App mirrors them into Tab.text (which drives
 * this tab's preview through the `text` prop). A RELOAD from disk (Ctrl+R /
 * external refresh / keep-mine) is pushed DOWN explicitly: App bumps `docVersion`
 * and this view calls editor.setDoc(text), best-effort restoring the reading line.
 *
 * Pane order is fixed — rendered view on the LEFT, source editor on the RIGHT.
 * Scroll sync uses a single "active leader" pane chosen by user presence (the
 * pointer-over pane, falling back to the focused pane). Only the leader drives the
 * follower; the follower's own echo/reflow scrolls are ignored because it is never
 * the pointer-over pane while you drive — no suppress flags. The leader logic only
 * ever runs in split view, where both panes are visible (a display:none pane has
 * clientHeight 0 — guarded by the `viewMode !== 'split'` early-outs).
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Editor, type EditorHandle } from './Editor';
import { Preview, type PreviewHandle } from './Preview';
import { blendedFollowerTop } from './scrollSync';
import { clampTargetLine } from '../revealLine';
import type { ViewMode } from './SplitView';

/** What App drives on the ACTIVE tab through a ref. */
export interface TabViewHandle {
  /** The editor's current text (the source of truth while mounted). */
  getText(): string;
  /** Top of the editor viewport as a 0-based fractional source line. */
  getTopLine(): number;
  /** Snapshot the link context at the cursor (Ctrl+K). */
  requestLink(): ReturnType<EditorHandle['requestLink']>;
  /** Insert/replace the remembered range with a link. */
  applyLink(text: string, url: string): void;
  /** Strip the remembered link to plain text. */
  removeLink(): void;
  /** Move keyboard focus into the editor. */
  focusEditor(): void;
  /** Jump this tab's preview to a heading slug (a file-link #fragment). Returns
   *  false (and the caller falls back to the top) if no such heading exists. */
  jumpToFragment(id: string): boolean;
  /** Put this tab's preview reading position back at the top. */
  scrollPreviewTop(): void;
  /** Reveal a 1-based target line (open at a specific line): scroll the preview to
   *  it with context + a brief highlight, clamped to the document, and position
   *  the editor to the same line when the source pane is shown. */
  revealLine(line: number): void;
}

interface TabViewProps {
  /** Initial editor content — read once on mount (uncontrolled editor). */
  initialText: string;
  /** Current document text — drives the preview (mirrors the editor via onSourceChange). */
  text: string;
  /** Bumped by App when the doc is RELOADED from disk so this view re-seeds the
   *  editor with `text`. Plain edits do NOT bump it. */
  docVersion: number;
  viewMode: ViewMode;
  /** True when this tab is NOT the active one — rendered but display:none. */
  hidden: boolean;
  /** The user edited this tab's source. */
  onSourceChange: (text: string) => void;
  /** Cmd/Ctrl+K in the editor — host opens the link dialog. */
  onLink?: () => void;
  /** A local-file link was clicked in this tab's preview. */
  onOpenLocal?: (href: string) => void;
}

const MIN_PCT = 20;
const MAX_PCT = 80;

export const TabView = forwardRef<TabViewHandle, TabViewProps>(function TabView(
  { initialText, text, docVersion, viewMode, hidden, onSourceChange, onLink, onOpenLocal },
  ref,
) {
  const editorRef = useRef<EditorHandle>(null);
  const previewRef = useRef<PreviewHandle>(null);

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
  const showDivider = viewMode === 'split';

  useImperativeHandle(ref, () => ({
    getText: () => editorRef.current?.getText() ?? text,
    getTopLine: () => editorRef.current?.getTopLine() ?? 0,
    requestLink: () => editorRef.current?.requestLink() ?? null,
    applyLink: (t, u) => editorRef.current?.applyLink(t, u),
    removeLink: () => editorRef.current?.removeLink(),
    focusEditor: () => editorRef.current?.focus(),
    jumpToFragment: (id) => previewRef.current?.scrollToAnchor(id) ?? false,
    scrollPreviewTop: () => previewRef.current?.setScrollTop(0),
    revealLine: (line) => {
      const line0 = clampTargetLine(line, text.split('\n').length);
      previewRef.current?.revealLine(line0);
      // Keep the editor in step so a later Show Source lands on the same line.
      if (viewMode === 'split') editorRef.current?.scrollToLine(line0);
    },
  }));

  // Reload from disk (Ctrl+R / external refresh / keep-mine): App bumped
  // docVersion, so re-seed the editor with the new text and best-effort restore
  // the reading line (keep the reading position rather than jumping to the
  // top). Skip the very first run (mount already initialised from initialText).
  const firstVersion = useRef(true);
  useEffect(() => {
    if (firstVersion.current) {
      firstVersion.current = false;
      return;
    }
    const keepLine = editorRef.current?.getTopLine() ?? 0;
    editorRef.current?.setDoc(text);
    editorRef.current?.scrollToLine(keepLine); // synchronous → the reset-to-top never paints
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docVersion]);

  // Re-align the editor to the line the preview is currently showing when the
  // editor returns to view (reveal on Show Source) — otherwise it comes back from
  // display:none showing its old scroll position and only re-syncs on the next
  // scroll. REVEAL-ONLY (keyed on [showEditor]); the editor must re-measure (it
  // was display:none) and the preview reflows a beat later, so align immediately,
  // on the next frame, and again whenever the preview reports its layout settled
  // (onPreviewLayout) for a short window.
  // True while a reveal-align is owed because the editor was display:none when
  // source was shown — so the align below couldn't land and must run once the tab
  // becomes visible. Cleared as soon as a visible align runs.
  const pendingRevealAlign = useRef(false);
  const realignUntil = useRef(0);
  useEffect(() => {
    if (!showEditor) return; // preview-only: never scroll the hidden editor
    const ed = editorRef.current;
    const pv = previewRef.current;
    if (!ed) return;
    // Hidden tab: its editor + preview are display:none, so neither alignTo nor
    // getTopLine works yet. Defer the align to when it becomes visible (below).
    if (hidden) {
      pendingRevealAlign.current = true;
      return;
    }
    const align = () => {
      ed.refresh();
      ed.alignTo(pv?.getTopLine() ?? 0);
    };
    realignUntil.current = Date.now() + 800;
    align();
    const raf = requestAnimationFrame(align);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showEditor]);

  // When THIS tab becomes the active (visible) one in split view, re-measure the
  // editor — it may have laid out (or last measured) while display:none. If a
  // reveal-align is still owed (source was shown while this tab was inactive, so
  // the [showEditor] effect couldn't align a display:none editor), perform it now
  // that the editor + preview are on-screen — mirroring the reveal effect (refresh
  // + alignTo, immediately and on the next frame once the now-shown editor has had
  // a measure cycle). Without the flag we'd re-align on EVERY switch, clobbering an
  // already-synced editor's preserved scroll.
  useLayoutEffect(() => {
    if (hidden || viewMode !== 'split') return;
    editorRef.current?.refresh();
    if (!pendingRevealAlign.current) return; // already synced — preserve the scroll
    pendingRevealAlign.current = false;
    const align = () => {
      editorRef.current?.refresh();
      editorRef.current?.alignTo(previewRef.current?.getTopLine() ?? 0);
    };
    realignUntil.current = Date.now() + 800;
    align();
    const raf = requestAnimationFrame(align);
    return () => cancelAnimationFrame(raf);
  }, [hidden, viewMode]);

  // The preview re-built its anchor map (it reflowed). Re-align the editor to it,
  // but only briefly after a reveal — so a later manual resize doesn't yank the
  // editor's scroll position.
  const onPreviewLayout = () => {
    if (viewMode !== 'split' || Date.now() > realignUntil.current) return;
    editorRef.current?.alignTo(previewRef.current?.getTopLine() ?? 0);
  };

  // Drive the follower from the leader: keep the line-anchored alignment in the
  // middle, but blend the follower toward its OWN max over the leader's final
  // screenful so both panes reach the bottom together.
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
    <div
      className="split-view tab-view"
      ref={containerRef}
      // Hidden tabs stay MOUNTED (CM6 + preview keep their state and scroll) but
      // out of view — so a switch is just a visibility flip, no rebuild. `hidden`
      // (display:none) also keeps the e2e selectors matching only the visible
      // pane's .cm-content / .preview-scroll.
      hidden={hidden}
    >
      <div
        className="pane pane-preview"
        onPointerEnter={() => (pointerPane.current = 'preview')}
        onPointerLeave={() => { if (pointerPane.current === 'preview') pointerPane.current = null; }}
        onFocusCapture={() => (focusedPane.current = 'preview')}
      >
        <Preview
          ref={previewRef}
          source={text}
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
          initialDoc={initialText}
          onChange={onSourceChange}
          onScroll={onEditorScroll}
          onLink={onLink}
        />
      </div>
    </div>
  );
});

/**
 * Tab strip (PRD R39/R40). One entry per open file: name, an unsaved-changes dot
 * (R40), an out-of-sync marker, and a close button (R41 — the prompt lives in
 * App). Clicking the label switches tabs; clicking × closes.
 *
 * Tabs are draggable to reorder them (issue #20). While dragging, the strip
 * renders a PREVIEW ORDER: the dragged tab is moved to its prospective landing
 * slot and shown there as a translucent "shadow", with the other tabs shifted to
 * make room — so it's obvious where the drop will land. Reordering never changes
 * which tab is active (that's tracked by id in App).
 *
 * Flicker-free / no red no-drop cursor by design (Electron/Chromium target):
 *  - `dragover` is handled once at the CONTAINER level and ALWAYS calls
 *    preventDefault() + sets dropEffect='move'. There are no per-tab dead zones
 *    (padding, gaps), so the browser never shows the not-allowed cursor.
 *  - The insertion index is derived purely from the cursor X vs each tab's
 *    RESTING midpoint, snapshotted once at drag start (not the live, preview-
 *    shifted layout — see insertIndex.ts for why that matters). We only
 *    re-render when the integer index actually changes, and never clear state
 *    on dragleave — so there's no off/on toggling as the cursor crosses child
 *    buttons.
 */
import { useRef, useState } from 'react';
import type { Tab } from '../App';
import { insertIndexFromMidpoints } from '../insertIndex';

interface TabStripProps {
  tabs: Tab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (draggedId: string, insertIndex: number) => void;
  nameOf: (t: Tab) => string;
}

export function TabStrip({ tabs, activeId, onSelect, onClose, onReorder, nameOf }: TabStripProps) {
  // The tab currently being dragged, and the insertion index (0..n in the
  // ORIGINAL tabs array) the drop would land at. Both clear on drop/dragend.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [insertIndex, setInsertIndex] = useState<number | null>(null);
  // Live refs to each tab row, keyed by id, for midpoint math during dragover.
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // STABLE snapshot of each tab's RESTING midpoint (x of its centre), in
  // original left-to-right order, captured once at drag start. We measure
  // against this fixed array — never the live, preview-shifted layout — so the
  // insertion index is a pure function of the cursor X and can't form a
  // feedback loop with the preview relayout it drives (see insertIndex.ts).
  const midpointsRef = useRef<number[]>([]);

  const endDrag = () => {
    setDraggingId(null);
    setInsertIndex(null);
    midpointsRef.current = [];
  };

  // Compute the insertion index (0..n) from the cursor X using the fixed
  // resting-midpoint snapshot. The integer result only flips once the cursor
  // crosses a snapshot midpoint, giving natural hysteresis with no toggling.
  const indexFromX = (clientX: number): number =>
    insertIndexFromMidpoints(midpointsRef.current, clientX);

  // Some Chromium drag transitions re-evaluate the drop target on `dragenter`
  // (not only `dragover`); preventDefault here too keeps the strip a valid drop
  // target across child boundaries so the not-allowed cursor never flashes.
  const onContainerDragEnter = (e: React.DragEvent) => {
    if (!draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const onContainerDragOver = (e: React.DragEvent) => {
    if (!draggingId) return;
    // ALWAYS allow the drop, everywhere over the strip (tabs, gaps, padding) —
    // this is what keeps the not-allowed (red [x]) cursor from ever appearing.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const next = indexFromX(e.clientX);
    if (next !== insertIndex) setInsertIndex(next);
  };

  const onContainerDrop = (e: React.DragEvent) => {
    if (!draggingId) return;
    e.preventDefault();
    const draggedId = e.dataTransfer.getData('text/plain') || draggingId;
    const target = insertIndex ?? indexFromX(e.clientX);
    if (draggedId) onReorder(draggedId, target);
    endDrag();
  };

  // Preview order shown during a drag: the dragged tab moved to its prospective
  // slot, the others making room. Falls back to the real order when not dragging
  // (or before the first dragover yields an index).
  const fromIndex = draggingId ? tabs.findIndex((t) => t.id === draggingId) : -1;
  let display = tabs;
  if (draggingId && fromIndex !== -1 && insertIndex !== null) {
    const next = tabs.slice();
    const [moved] = next.splice(fromIndex, 1);
    const target = insertIndex > fromIndex ? insertIndex - 1 : insertIndex;
    next.splice(Math.max(0, Math.min(target, next.length)), 0, moved);
    display = next;
  }

  return (
    <div
      className={draggingId ? 'tab-strip is-dragging' : 'tab-strip'}
      role="tablist"
      onDragEnter={onContainerDragEnter}
      onDragOver={onContainerDragOver}
      onDrop={onContainerDrop}
    >
      {display.map((t) => {
        const classes = ['tab'];
        if (t.id === activeId) classes.push('is-active');
        // The dragged tab renders as a translucent shadow in its landing slot.
        if (t.id === draggingId) classes.push('shadow');
        return (
          <div
            key={t.id}
            ref={(el) => {
              if (el) rowRefs.current.set(t.id, el);
              else rowRefs.current.delete(t.id);
            }}
            className={classes.join(' ')}
            draggable
            onDragStart={(e) => {
              // Capture resting midpoints SYNCHRONOUSLY, before the setState
              // below re-renders: at this instant the DOM is still in original
              // order (no insertIndex yet → display === tabs), so each row's
              // live rect is its resting position. Missing rows are skipped to
              // -Infinity so they always count as "to the left" and never break
              // the ascending order the index math relies on.
              midpointsRef.current = tabs.map((tt) => {
                const el = rowRefs.current.get(tt.id);
                if (!el) return -Infinity;
                const r = el.getBoundingClientRect();
                return r.left + r.width / 2;
              });
              setDraggingId(t.id);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', t.id);
            }}
            onDragEnd={endDrag}
          >
            <button
              type="button"
              className="tab-label"
              role="tab"
              aria-selected={t.id === activeId}
              title={t.path}
              onClick={() => onSelect(t.id)}
            >
              {t.conflict && (
                <span className="tab-warn" aria-label="Out of sync" title="Out of sync">●</span>
              )}
              {t.dirty && !t.conflict && (
                <span className="tab-dot" aria-label="Unsaved changes" title="Unsaved changes">●</span>
              )}
              <span className="tab-name">{nameOf(t)}</span>
            </button>
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${nameOf(t)}`}
              title="Close tab"
              onClick={() => onClose(t.id)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Window-resize math for the Show/Hide Source toggle (R45), lifted out of
 * main.ts's `window:setSourceVisible` handler so the doubling / work-area clamp
 * / on-screen nudge is unit-testable without a real BrowserWindow or display.
 *
 * Showing the source roughly doubles the width to make room for the side-by-side
 * editor; hiding it restores the remembered reading width. Either way the result
 * is clamped to the display work area (and a minimum) and nudged horizontally so
 * the window stays fully on-screen. Height and Y are passed through unchanged;
 * only width and X can move.
 *
 * The remembered reading width is state main.ts owns (a per-window Map); it is
 * passed in as `reading` and this function stays pure.
 */

/** The app's minimum window width (matches BrowserWindow `minWidth`). */
export const MIN_WINDOW_WIDTH = 480;

export interface SourceVisibleInput {
  /** Current window size as Electron's `[width, height]`. */
  size: [number, number];
  /** Current window position as Electron's `[x, y]`. */
  position: [number, number];
  /** The matched display's work area (only x/width are used). */
  workArea: { x: number; width: number };
  /** The remembered reading-mode width, or undefined if none is stored yet. */
  reading: number | undefined;
  /** True when revealing the source (widen); false when hiding it (restore). */
  visible: boolean;
}

/** The new window bounds to apply. */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function computeSourceVisibleBounds(input: SourceVisibleInput): WindowBounds {
  const [w, h] = input.size;
  const { x, y } = { x: input.position[0], y: input.position[1] };
  const area = input.workArea;

  // Widen to ~2× when showing; restore the reading width (fallback half) when
  // hiding. Then clamp to [MIN, work-area width].
  let target = input.visible ? Math.min(w * 2, area.width) : input.reading ?? Math.round(w / 2);
  target = Math.round(Math.max(MIN_WINDOW_WIDTH, Math.min(target, area.width)));

  // Nudge X so the (possibly wider) window stays fully within the work area:
  // pull the right edge in first, then clamp the left edge to the work-area origin.
  let nx = x;
  if (nx + target > area.x + area.width) nx = area.x + area.width - target;
  if (nx < area.x) nx = area.x;

  return { x: Math.round(nx), y, width: target, height: h };
}

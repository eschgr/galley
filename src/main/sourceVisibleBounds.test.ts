import { describe, it, expect } from 'vitest';
import { computeSourceVisibleBounds, MIN_WINDOW_WIDTH } from './sourceVisibleBounds';

// A roomy work area so clamping/nudging only engages when a test forces it.
const BIG = { x: 0, width: 4000 };

describe('computeSourceVisibleBounds — showing the source (widen)', () => {
  it('roughly doubles the width, keeping height, Y, and X', () => {
    const b = computeSourceVisibleBounds({
      size: [1000, 1250],
      position: [100, 50],
      workArea: BIG,
      reading: undefined,
      visible: true,
    });
    expect(b).toEqual({ x: 100, y: 50, width: 2000, height: 1250 });
  });

  it('clamps the doubled width to the display work area', () => {
    const b = computeSourceVisibleBounds({
      size: [1000, 800],
      position: [0, 0],
      workArea: { x: 0, width: 1500 }, // 2× would be 2000, over the work area
      reading: undefined,
      visible: true,
    });
    expect(b).toEqual({ x: 0, y: 0, width: 1500, height: 800 }); // pin X/Y/height too
  });

  it('nudges X left so a widened window stays fully on-screen', () => {
    // Window near the right edge; doubling would overflow, so X pulls in.
    const b = computeSourceVisibleBounds({
      size: [800, 600],
      position: [900, 0],
      workArea: { x: 0, width: 1600 }, // right edge at 1600; target 1600
      reading: undefined,
      visible: true,
    });
    // 1600 - 1600 = 0; then clamped to the work-area origin.
    expect(b).toEqual({ x: 0, y: 0, width: 1600, height: 600 });
  });

  it('respects a non-zero work-area origin (multi-monitor) when nudging the RIGHT edge', () => {
    const b = computeSourceVisibleBounds({
      size: [700, 600],
      position: [3000, 100],
      workArea: { x: 2000, width: 1600 }, // secondary display spanning [2000,3600)
      reading: undefined,
      visible: true,
    });
    // width 700*2 = 1400; right edge 3600; 3000 + 1400 = 4400 > 3600 → nx = 3600 - 1400 = 2200.
    expect(b).toEqual({ x: 2200, y: 100, width: 1400, height: 600 });
    expect(b.x).toBeGreaterThanOrEqual(2000); // still within the display origin
  });

  it('clamps the LEFT edge to a non-zero work-area origin (window starts off the display)', () => {
    // Window sits LEFT of the secondary display's origin; the left clamp must
    // pull it back to area.x (2000), not to 0. Guards the `nx < area.x` clamp.
    const b = computeSourceVisibleBounds({
      size: [700, 600],
      position: [1500, 100],
      workArea: { x: 2000, width: 1600 },
      reading: undefined,
      visible: true,
    });
    // width 1400; 1500 + 1400 = 2900 < 3600 (no right nudge); 1500 < 2000 → nx = 2000.
    expect(b).toEqual({ x: 2000, y: 100, width: 1400, height: 600 });
  });
});

describe('computeSourceVisibleBounds — hiding the source (restore)', () => {
  it('restores the remembered reading width', () => {
    const b = computeSourceVisibleBounds({
      size: [2000, 800],
      position: [10, 20],
      workArea: BIG,
      reading: 950,
      visible: false,
    });
    expect(b).toEqual({ x: 10, y: 20, width: 950, height: 800 });
  });

  it('falls back to half the current width when no reading width is stored', () => {
    const b = computeSourceVisibleBounds({
      size: [2000, 800],
      position: [0, 0],
      workArea: BIG,
      reading: undefined,
      visible: false,
    });
    expect(b.width).toBe(1000); // round(2000 / 2)
  });
});

describe('computeSourceVisibleBounds — floors and rounding', () => {
  it('never goes below the minimum window width', () => {
    const b = computeSourceVisibleBounds({
      size: [500, 400],
      position: [0, 0],
      workArea: BIG,
      reading: 100, // absurdly small remembered width
      visible: false,
    });
    expect(b.width).toBe(MIN_WINDOW_WIDTH);
  });

  it('rounds the width to an integer', () => {
    const b = computeSourceVisibleBounds({
      size: [999, 700], // half → 499.5
      position: [0, 0],
      workArea: BIG,
      reading: undefined,
      visible: false,
    });
    expect(Number.isInteger(b.width)).toBe(true);
    expect(b.width).toBe(500);
  });

  it('applies the OUTER round to a fractional target (isolates the final Math.round)', () => {
    // A fractional remembered width reaches the outer round directly (the inner
    // round(w/2) fallback isn't taken here), so this guards the final Math.round
    // that the round(w/2) case can't isolate.
    const b = computeSourceVisibleBounds({
      size: [2000, 800],
      position: [0, 0],
      workArea: BIG,
      reading: 950.6,
      visible: false,
    });
    expect(Number.isInteger(b.width)).toBe(true);
    expect(b.width).toBe(951);
  });
});

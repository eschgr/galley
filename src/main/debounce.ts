/**
 * A minimal trailing-edge debounce: coalesces a burst of calls into one, firing
 * `fn` with the LATEST arguments `waitMs` after the last call.
 *
 * Used to coalesce rapid session writes (PF19): opening/closing/switching tabs
 * in quick succession would otherwise hammer `session.json` on every change, so
 * the renderer's reports are debounced in main before touching disk. Trailing-
 * edge (not leading) so the persisted record reflects the settled tab set, not
 * an intermediate one.
 *
 * Extracted as a tiny pure helper so the coalescing behavior is unit-testable
 * without Electron; the timer source is injectable for the same reason.
 */
export interface Debounced<A extends unknown[]> {
  /** Schedule `fn` to run `waitMs` after this call, superseding any pending run. */
  (...args: A): void;
  /** Cancel a pending run, if any (e.g. on window close). */
  cancel(): void;
}

/** A `setTimeout`/`clearTimeout` pair, injectable so tests can drive time. */
export interface TimerApi {
  set(handler: () => void, ms: number): ReturnType<typeof setTimeout>;
  clear(handle: ReturnType<typeof setTimeout>): void;
}

const realTimers: TimerApi = {
  set: (handler, ms) => setTimeout(handler, ms),
  clear: (handle) => clearTimeout(handle),
};

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
  timers: TimerApi = realTimers,
): Debounced<A> {
  let handle: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;

  const debounced = ((...args: A): void => {
    lastArgs = args;
    if (handle !== null) timers.clear(handle);
    handle = timers.set(() => {
      handle = null;
      const call = lastArgs;
      lastArgs = null;
      if (call) fn(...call);
    }, waitMs);
  }) as Debounced<A>;

  debounced.cancel = (): void => {
    if (handle !== null) {
      timers.clear(handle);
      handle = null;
    }
    lastArgs = null;
  };

  return debounced;
}

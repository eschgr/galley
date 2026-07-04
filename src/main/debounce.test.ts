import { describe, it, expect, vi } from 'vitest';
import { debounce, type TimerApi } from './debounce';

// A controllable timer so the coalescing behavior is tested deterministically,
// without real time. Each `set` records a due time; `advance(ms)` fires anything
// whose deadline has passed (latest scheduled wins, matching a debounce).
function fakeTimers(): TimerApi & { advance(ms: number): void } {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; handler: () => void }>();
  return {
    set(handler, ms) {
      const id = ++seq;
      pending.set(id, { at: now + ms, handler });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clear(handle) {
      pending.delete(handle as unknown as number);
    },
    advance(ms) {
      now += ms;
      for (const [id, entry] of [...pending]) {
        if (entry.at <= now) {
          pending.delete(id);
          entry.handler();
        }
      }
    },
  };
}

describe('debounce', () => {
  it('fires once with the latest args after the wait, coalescing a burst', () => {
    const timers = fakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 500, timers);

    d('a');
    d('b');
    d('c');
    expect(fn).not.toHaveBeenCalled(); // still pending

    timers.advance(500);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('c'); // trailing edge: latest args win
  });

  it('does not fire early — only after the full wait since the LAST call', () => {
    const timers = fakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 500, timers);

    d('x');
    timers.advance(300); // 300ms after first call
    d('y'); // resets the clock
    timers.advance(300); // 600ms after first, but only 300ms after last
    expect(fn).not.toHaveBeenCalled();
    timers.advance(200); // now 500ms after the last call
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('y');
  });

  it('cancel drops a pending run', () => {
    const timers = fakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 500, timers);

    d('a');
    d.cancel();
    timers.advance(500);
    expect(fn).not.toHaveBeenCalled();
  });

  it('a fresh call after firing schedules a new run', () => {
    const timers = fakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 500, timers);

    d('first');
    timers.advance(500);
    expect(fn).toHaveBeenCalledTimes(1);

    d('second');
    timers.advance(500);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('second');
  });
});

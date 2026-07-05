import { describe, it, expect } from 'vitest';
import { SelfWriteTracker } from './selfWriteTracker';

// A controllable clock so TTL behavior is deterministic (no real timers/waits).
function fakeClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('SelfWriteTracker', () => {
  it('recognizes EVERY recent write, not just the latest', () => {
    // This is the crux of the fix: the old single-slot check only knew the last
    // hash, so a watcher event surfacing an earlier burst write ("v1") looked
    // external. The tracker must still recognize it as ours.
    const t = new SelfWriteTracker();
    t.note('/a.md', 'v1');
    t.note('/a.md', 'v2');
    t.note('/a.md', 'v3');
    expect(t.has('/a.md', 'v1')).toBe(true);
    expect(t.has('/a.md', 'v2')).toBe(true);
    expect(t.has('/a.md', 'v3')).toBe(true);
  });

  it('does not recognize a hash it never wrote (a genuine external change)', () => {
    const t = new SelfWriteTracker();
    t.note('/a.md', 'mine');
    expect(t.has('/a.md', 'external')).toBe(false);
  });

  it('is per-path — a write to one path is not a self-write for another', () => {
    const t = new SelfWriteTracker();
    t.note('/a.md', 'h');
    expect(t.has('/a.md', 'h')).toBe(true);
    expect(t.has('/b.md', 'h')).toBe(false);
  });

  it('expires an entry after the TTL', () => {
    const clock = fakeClock();
    const t = new SelfWriteTracker(5_000, clock.now);
    t.note('/a.md', 'h');
    clock.advance(4_999);
    expect(t.has('/a.md', 'h')).toBe(true); // still within TTL
    clock.advance(2);
    expect(t.has('/a.md', 'h')).toBe(false); // TTL elapsed — a later external write with the same bytes would now forward
  });

  it('prunes expired entries on the next note (bounded memory)', () => {
    const clock = fakeClock();
    const t = new SelfWriteTracker(5_000, clock.now);
    t.note('/a.md', 'old');
    clock.advance(6_000); // 'old' is now expired
    t.note('/a.md', 'new'); // triggers a prune of 'old'
    expect(t.has('/a.md', 'old')).toBe(false);
    expect(t.has('/a.md', 'new')).toBe(true);
  });

  it('forget() drops everything tracked for a path', () => {
    const t = new SelfWriteTracker();
    t.note('/a.md', 'h');
    t.forget('/a.md');
    expect(t.has('/a.md', 'h')).toBe(false);
  });
});

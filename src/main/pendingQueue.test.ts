import { describe, it, expect } from 'vitest';
import { PendingQueue } from './pendingQueue';

describe('PendingQueue — queue-while-not-ready, flush-on-ready, pass-through', () => {
  it('starts not-ready and holds delivered items instead of running them', () => {
    const q = new PendingQueue<string>();
    const sink: string[] = [];
    expect(q.isReady).toBe(false);
    q.deliver('a', (x) => sink.push(x));
    q.deliver('b', (x) => sink.push(x));
    expect(sink).toEqual([]); // nothing ran yet
  });

  it('flushes queued items in arrival order and flips to ready', () => {
    const q = new PendingQueue<string>();
    const sink: string[] = [];
    q.deliver('a', (x) => sink.push(x));
    q.deliver('b', (x) => sink.push(x));
    q.deliver('c', (x) => sink.push(x));
    q.flush((x) => sink.push(x));
    expect(sink).toEqual(['a', 'b', 'c']); // FIFO
    expect(q.isReady).toBe(true);
  });

  it('passes items straight through once ready (no queueing)', () => {
    const q = new PendingQueue<string>();
    const sink: string[] = [];
    q.flush((x) => sink.push(x)); // ready, nothing queued
    q.deliver('a', (x) => sink.push(x));
    q.deliver('b', (x) => sink.push(x));
    expect(sink).toEqual(['a', 'b']); // each ran immediately
  });

  it('drains only what was queued; a second flush with an empty queue is a no-op', () => {
    const q = new PendingQueue<string>();
    const sink: string[] = [];
    q.deliver('a', (x) => sink.push(x));
    q.flush((x) => sink.push(x));
    q.flush((x) => sink.push(x)); // nothing left to drain
    expect(sink).toEqual(['a']);
  });

  it('re-arms on suspend so later deliveries queue again until the next flush', () => {
    const q = new PendingQueue<string>();
    const sink: string[] = [];
    q.flush((x) => sink.push(x)); // ready
    q.deliver('live', (x) => sink.push(x)); // runs now
    q.suspend(); // e.g. a crash-reload
    expect(q.isReady).toBe(false);
    q.deliver('queued', (x) => sink.push(x)); // held, not run
    expect(sink).toEqual(['live']);
    q.flush((x) => sink.push(x)); // next did-finish-load
    expect(sink).toEqual(['live', 'queued']);
  });

  it('preserves already-queued items across a suspend (mid-reload re-arm drops nothing)', () => {
    const q = new PendingQueue<string>();
    const sink: string[] = [];
    q.deliver('before', (x) => sink.push(x)); // queued (not ready)
    q.suspend(); // re-arm while an item is still waiting
    q.deliver('after', (x) => sink.push(x)); // also queued
    q.flush((x) => sink.push(x));
    expect(sink).toEqual(['before', 'after']);
  });
});

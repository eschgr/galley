/**
 * A tiny arrival buffer for work that must wait until a consumer is ready
 * (R11–R15 channel file-drops): files delivered before the renderer's
 * `did-finish-load` are queued in arrival order and flushed once it mounts;
 * after that they pass straight through. A crash-reload re-arms the buffer
 * (`suspend`) so files dropped mid-reload queue again rather than being sent to
 * a page that is about to be replaced.
 *
 * Lifted out of main.ts's `pendingChannelFiles` / `rendererReady` pair so the
 * queue-while-not-ready / flush-on-ready / pass-through ordering is unit-testable
 * without Electron. The sink (what to do with each item) is injected, so this
 * stays generic and side-effect-free.
 */
export class PendingQueue<T> {
  private ready = false;
  private queued: T[] = [];

  /** Whether the consumer is ready (items passed to `deliver` run immediately). */
  get isReady(): boolean {
    return this.ready;
  }

  /**
   * Deliver an item: run `sink` now if ready, otherwise hold it (FIFO) until the
   * next `flush`.
   */
  deliver(item: T, sink: (item: T) => void): void {
    if (this.ready) sink(item);
    else this.queued.push(item);
  }

  /**
   * Mark the consumer ready and drain everything queued so far, in arrival
   * order. Idempotent: with nothing queued it just flips the ready flag.
   */
  flush(sink: (item: T) => void): void {
    this.ready = true;
    for (const item of this.queued.splice(0)) sink(item);
  }

  /**
   * Re-arm the buffer: subsequent `deliver` calls queue again until the next
   * `flush`. Held items are preserved (a mid-reload re-arm shouldn't drop files).
   */
  suspend(): void {
    this.ready = false;
  }
}

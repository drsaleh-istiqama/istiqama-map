/**
 * TEST SUPPORT — a virtual clock.
 *
 * Timers with a delay up to `autoUpToMs` fire by themselves (one per real macrotask, in due
 * order) and move the virtual time forward instantly: code that sleeps, paces or backs off
 * runs at full speed while the test can still read how long it "waited". Longer timers (the
 * engine's two-minute interval, cycle backoff) wait for an explicit `advance()`.
 */
import type { Clock } from '../clock';

interface Timer {
  at: number;
  /** Delay that was requested when the timer was set. */
  delay: number;
  fn: () => void;
  auto: boolean;
}

export class TestClock implements Clock {
  time = 1_750_000_000_000;
  /** Value returned by `random()` (0.5 = the middle of every jitter range). */
  randomValue = 0.5;
  /** Every delay that was requested, in order. */
  readonly delays: number[] = [];
  private readonly timers = new Map<number, Timer>();
  private seq = 0;
  private pumping = false;

  constructor(private readonly autoUpToMs = Number.POSITIVE_INFINITY) {}

  now(): number {
    return this.time;
  }

  random(): number {
    return this.randomValue;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = ++this.seq;
    const auto = ms <= this.autoUpToMs;
    this.timers.set(id, { at: this.time + ms, delay: ms, fn, auto });
    this.delays.push(ms);
    if (auto) this.pump();
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /**
   * Requested delays of the timers that wait for `advance()`. The requested delay, not the
   * remaining time: a short auto timer that fires after a long one was set (a debounced
   * counter refresh, say) moves the virtual time and would otherwise make assertions on the
   * scheduling decision depend on the order of macrotasks.
   */
  waiting(): number[] {
    return [...this.timers.values()].filter((t) => !t.auto).map((t) => t.delay);
  }

  /** Remaining time of the timers that wait for `advance()`. */
  remaining(): number[] {
    return [...this.timers.values()].filter((t) => !t.auto).map((t) => t.at - this.time);
  }

  /** Move the virtual time forward, firing every timer that becomes due. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const next = this.earliest((t) => t.at <= target);
      if (!next) break;
      this.fire(next);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    }
    this.time = Math.max(this.time, target);
  }

  private earliest(match: (t: Timer) => boolean): number | null {
    let best: number | null = null;
    for (const [id, t] of this.timers) {
      if (!match(t)) continue;
      if (best === null || t.at < (this.timers.get(best) as Timer).at) best = id;
    }
    return best;
  }

  private fire(id: number): void {
    const t = this.timers.get(id);
    if (!t) return;
    this.timers.delete(id);
    this.time = Math.max(this.time, t.at);
    t.fn();
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    globalThis.setTimeout(() => {
      this.pumping = false;
      const next = this.earliest((t) => t.auto);
      if (next !== null) this.fire(next);
      if (this.earliest((t) => t.auto) !== null) this.pump();
    }, 0);
  }
}

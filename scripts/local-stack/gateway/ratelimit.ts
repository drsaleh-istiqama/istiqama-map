/** In-memory sliding-window rate limiter (single gateway process, development only). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private lastSweep = 0;

  /** Record one hit for `key`; false when more than `max` hits fall inside the window. */
  take(key: string, max: number, windowMs: number, now = Date.now()): boolean {
    this.sweep(now, windowMs);
    const cutoff = now - windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length >= max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }

  /** Milliseconds until the next hit for `key` would be accepted (0 = now). */
  retryAfter(key: string, max: number, windowMs: number, now = Date.now()): number {
    const cutoff = now - windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length < max) return 0;
    return Math.max(0, list[list.length - max]! + windowMs - now);
  }

  reset(key?: string): void {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }

  private sweep(now: number, windowMs: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    const cutoff = now - Math.max(windowMs, 3_600_000);
    for (const [k, list] of this.hits) {
      if (!list.length || list[list.length - 1]! <= cutoff) this.hits.delete(k);
    }
  }
}

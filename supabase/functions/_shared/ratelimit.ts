/**
 * Per-user rate limiting inside a function.
 *
 * IMPORTANT — scope of this limiter: it lives in the memory of ONE worker isolate. The
 * database limiter `private.rate_limit()` is not reachable from here (schema `private` is not
 * exposed through PostgREST and no public wrapper exists), so:
 *   - for `sync_push` / `sync_pull` / `export` / `import` / `admin` the authoritative limit is
 *     the one inside the RPC (shared by all isolates); this limiter only sheds floods early;
 *   - for `tiles` (`tile_projects` is STABLE and cannot call the database limiter) this is
 *     the only limit, and with N warm isolates a user can reach up to N times the configured
 *     rate. Counters are lost when an isolate is recycled.
 *
 * Algorithm: sliding-window counter (two fixed windows, the previous one weighted by the
 * part of it that still overlaps the sliding window). O(1) per hit, bounded memory.
 */
import { errors } from './http.ts';

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  /** Seconds until a retry can succeed (0 when `ok`). */
  retryAfter: number;
}

interface Bucket {
  windowStart: number;
  current: number;
  previous: number;
}

export interface LimiterOptions {
  /** Maximum number of tracked keys; the least recently created are dropped first. */
  maxKeys?: number;
  now?: () => number;
}

export class SlidingWindowLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxKeys: number;
  private readonly now: () => number;
  private hits = 0;

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    opts: LimiterOptions = {},
  ) {
    if (!(limit >= 1) || !(windowMs >= 1)) throw new RangeError('invalid rate limit');
    this.maxKeys = opts.maxKeys ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.buckets.size;
  }

  private roll(bucket: Bucket, now: number): void {
    const start = Math.floor(now / this.windowMs) * this.windowMs;
    if (start === bucket.windowStart) return;
    bucket.previous = start - bucket.windowStart === this.windowMs ? bucket.current : 0;
    bucket.current = 0;
    bucket.windowStart = start;
  }

  private estimate(bucket: Bucket, now: number): number {
    const elapsed = (now - bucket.windowStart) / this.windowMs;
    return bucket.previous * (1 - elapsed) + bucket.current;
  }

  /** Count `cost` requests for `key`. A refused hit is not counted. */
  hit(key: string, cost = 1): RateLimitResult {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        windowStart: Math.floor(now / this.windowMs) * this.windowMs,
        current: 0,
        previous: 0,
      };
      this.buckets.set(key, bucket);
      if (this.buckets.size > this.maxKeys) this.evict(now);
    } else this.roll(bucket, now);

    if (++this.hits % 1024 === 0) this.sweep(now);

    const used = this.estimate(bucket, now);
    if (used + cost > this.limit) {
      return {
        ok: false,
        limit: this.limit,
        remaining: 0,
        retryAfter: this.retryAfter(bucket, now, cost),
      };
    }
    bucket.current += cost;
    return {
      ok: true,
      limit: this.limit,
      remaining: Math.max(0, Math.floor(this.limit - used - cost)),
      retryAfter: 0,
    };
  }

  private retryAfter(bucket: Bucket, now: number, cost: number): number {
    const windowEnd = bucket.windowStart + this.windowMs;
    const excess = this.estimate(bucket, now) + cost - this.limit;
    let waitMs: number;
    if (bucket.previous > 0 && bucket.current + cost <= this.limit) {
      // The weight of the previous window decays linearly: wait until enough of it is gone.
      waitMs = Math.min((excess / bucket.previous) * this.windowMs, windowEnd - now);
    } else {
      // The current window alone is full: its count only starts to decay after it has become
      // the previous window, so the end of the window is the earliest useful retry.
      waitMs = windowEnd - now;
    }
    return Math.max(1, Math.ceil(waitMs / 1000));
  }

  /** Forget keys that have been idle for two full windows. */
  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= 2 * this.windowMs) this.buckets.delete(key);
    }
  }

  private evict(now: number): void {
    this.sweep(now);
    // Map iteration order = insertion order: drop the oldest keys first.
    for (const key of this.buckets.keys()) {
      if (this.buckets.size <= this.maxKeys) break;
      this.buckets.delete(key);
    }
  }
}

const limiters = new Map<string, SlidingWindowLimiter>();

/** One limiter per (name, limit, window) for the lifetime of the isolate. */
export function limiterFor(name: string, limit: number, windowMs: number): SlidingWindowLimiter {
  const id = `${name}:${limit}:${windowMs}`;
  let limiter = limiters.get(id);
  if (!limiter) {
    limiter = new SlidingWindowLimiter(limit, windowMs);
    limiters.set(id, limiter);
  }
  return limiter;
}

/**
 * Throw the standard 429 (`PT429` / `rate_limited`, `Retry-After`) when `userId` exceeded
 * `limit` calls per `windowMs` for the bucket `name`.
 */
export function enforceRateLimit(
  name: string,
  userId: string,
  limit: number,
  windowMs = 60_000,
  cost = 1,
): RateLimitResult {
  const result = limiterFor(name, limit, windowMs).hit(userId, cost);
  if (!result.ok)
    throw errors.rateLimited(
      result.retryAfter,
      `Too many requests: "${name}" is limited to ${limit} calls per ${Math.round(windowMs / 1000)} seconds.`,
    );
  return result;
}

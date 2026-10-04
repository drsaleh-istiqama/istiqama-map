import { describe, expect, it } from 'vitest';
import { HttpError } from './http.ts';
import { SlidingWindowLimiter, enforceRateLimit, limiterFor } from './ratelimit.ts';

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('SlidingWindowLimiter', () => {
  it('allows `limit` hits per window and refuses the next one', () => {
    const c = clock(60_000 * 100); // exactly at a window boundary
    const limiter = new SlidingWindowLimiter(5, 60_000, { now: c.now });
    for (let i = 0; i < 5; i++) {
      const r = limiter.hit('u1');
      expect(r.ok).toBe(true);
      expect(r.remaining).toBe(4 - i);
    }
    const refused = limiter.hit('u1');
    expect(refused.ok).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfter).toBe(60);
  });

  it('keeps users apart', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(2, 60_000, { now: c.now });
    expect(limiter.hit('a').ok).toBe(true);
    expect(limiter.hit('a').ok).toBe(true);
    expect(limiter.hit('a').ok).toBe(false);
    expect(limiter.hit('b').ok).toBe(true);
  });

  it('slides: the previous window counts in proportion to its overlap', () => {
    const c = clock(60_000 * 100);
    const limiter = new SlidingWindowLimiter(10, 60_000, { now: c.now });
    for (let i = 0; i < 10; i++) expect(limiter.hit('u').ok).toBe(true);
    // 30 s into the next window: half of the previous 10 still count → 5 are free
    c.advance(90_000);
    let allowed = 0;
    for (let i = 0; i < 10; i++) if (limiter.hit('u').ok) allowed++;
    expect(allowed).toBe(5);
    // no burst at the window boundary: right after it almost nothing is free
    const c2 = clock(60_000 * 100);
    const l2 = new SlidingWindowLimiter(10, 60_000, { now: c2.now });
    for (let i = 0; i < 10; i++) l2.hit('u');
    c2.advance(60_000 + 600); // 1 % into the next window
    expect(l2.hit('u').ok).toBe(false);
  });

  it('forgets everything after two idle windows', () => {
    const c = clock(60_000 * 100);
    const limiter = new SlidingWindowLimiter(3, 60_000, { now: c.now });
    for (let i = 0; i < 3; i++) limiter.hit('u');
    c.advance(120_000);
    for (let i = 0; i < 3; i++) expect(limiter.hit('u').ok).toBe(true);
    expect(limiter.hit('u').ok).toBe(false);
  });

  it('a refused hit is not counted', () => {
    const c = clock(60_000 * 100);
    const limiter = new SlidingWindowLimiter(1, 60_000, { now: c.now });
    expect(limiter.hit('u').ok).toBe(true);
    for (let i = 0; i < 50; i++) expect(limiter.hit('u').ok).toBe(false);
    c.advance(120_000);
    expect(limiter.hit('u').ok).toBe(true);
  });

  it('announces a retry delay that really is enough', () => {
    const c = clock(60_000 * 100);
    const limiter = new SlidingWindowLimiter(10, 60_000, { now: c.now });
    for (let i = 0; i < 10; i++) limiter.hit('u');
    c.advance(60_000 + 1_000);
    const refused = limiter.hit('u');
    expect(refused.ok).toBe(false);
    expect(refused.retryAfter).toBeGreaterThanOrEqual(1);
    c.advance(refused.retryAfter * 1000);
    expect(limiter.hit('u').ok).toBe(true);
  });

  it('supports weighted hits', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(10, 60_000, { now: c.now });
    expect(limiter.hit('u', 8).ok).toBe(true);
    expect(limiter.hit('u', 3).ok).toBe(false);
    expect(limiter.hit('u', 2).ok).toBe(true);
  });

  it('bounds its memory: oldest keys are dropped beyond maxKeys', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(5, 60_000, { now: c.now, maxKeys: 100 });
    for (let i = 0; i < 1000; i++) limiter.hit(`user-${i}`);
    expect(limiter.size).toBeLessThanOrEqual(100);
    // a dropped key simply starts again
    expect(limiter.hit('user-0').ok).toBe(true);
  });

  it('sweeps idle keys', () => {
    const c = clock(60_000 * 100);
    const limiter = new SlidingWindowLimiter(5, 1_000, { now: c.now });
    for (let i = 0; i < 500; i++) limiter.hit(`idle-${i}`);
    c.advance(10_000);
    for (let i = 0; i < 1100; i++) limiter.hit('busy');
    expect(limiter.size).toBeLessThan(10);
  });

  it('rejects nonsense limits', () => {
    expect(() => new SlidingWindowLimiter(0, 1000)).toThrow(RangeError);
    expect(() => new SlidingWindowLimiter(5, 0)).toThrow(RangeError);
  });
});

describe('enforceRateLimit', () => {
  it('throws the standard 429 with Retry-After once the limit is reached', () => {
    const name = `test-${Math.random()}`;
    for (let i = 0; i < 3; i++) expect(enforceRateLimit(name, 'user', 3).ok).toBe(true);
    let error: unknown;
    try {
      enforceRateLimit(name, 'user', 3);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HttpError);
    const e = error as HttpError;
    expect(e.status).toBe(429);
    expect(e.body()).toMatchObject({ code: 'PT429', message: 'rate_limited' });
    expect(e.body().hint).toMatch(/^Retry in \d+ seconds\.$/);
    expect(Number(e.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // another user is unaffected, the same limiter instance is reused
    expect(enforceRateLimit(name, 'other', 3).ok).toBe(true);
    expect(limiterFor(name, 3, 60_000)).toBe(limiterFor(name, 3, 60_000));
  });
});

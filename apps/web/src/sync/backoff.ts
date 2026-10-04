/**
 * Exponential backoff with jitter. "Equal jitter": half of the exponential delay is fixed,
 * the other half random, so retries of many devices spread out but never fire immediately.
 */

export interface BackoffPolicy {
  /** Delay of the first retry (before jitter). */
  baseMs: number;
  /** Upper bound of the exponential part. */
  maxMs: number;
  factor?: number;
}

/**
 * @param attempt 0 for the first retry, 1 for the second…
 * @param random  uniform [0, 1)
 * @param floorMs server hint (Retry-After): never wait less than this
 */
export function backoffDelay(
  policy: BackoffPolicy,
  attempt: number,
  random: () => number,
  floorMs = 0,
): number {
  const factor = policy.factor ?? 2;
  const exp = Math.min(policy.maxMs, policy.baseMs * Math.pow(factor, Math.max(0, attempt)));
  const jittered = exp / 2 + random() * (exp / 2);
  // A server-provided wait gets a little jitter on top so that clients do not all return at once.
  const floor = floorMs > 0 ? floorMs + random() * Math.min(1000, floorMs * 0.1) : 0;
  return Math.round(Math.max(jittered, floor));
}

/** Retry delays of a failing sync cycle: 5 s, 10 s, 20 s … capped at 10 minutes. */
export const CYCLE_BACKOFF: BackoffPolicy = { baseMs: 5_000, maxMs: 600_000 };
/** Quick in-cycle retries of one request (flaky 3G: the next attempt often succeeds). */
export const REQUEST_BACKOFF: BackoffPolicy = { baseMs: 1_000, maxMs: 8_000 };

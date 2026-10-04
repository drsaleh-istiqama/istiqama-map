/**
 * Time source used by the whole sync layer. Injected everywhere so that unit tests run on a
 * manual clock (fake timers would freeze fake-indexeddb, which schedules through real timers).
 */
import { SyncError } from './errors';

export type TimerHandle = unknown;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  /** Uniform random number in [0, 1) — the jitter source. */
  random(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  random: () => Math.random(),
};

/** Resolves after `ms`; rejects with an `aborted` SyncError when the signal fires first. */
export function sleep(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SyncError('aborted', 'aborted'));
      return;
    }
    const onAbort = (): void => {
      clock.clearTimeout(handle);
      reject(new SyncError('aborted', 'aborted'));
    };
    const handle = clock.setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------------------
// Device clocks jump (NTP, the user fixing the time, a phone that booted with a wrong date).
// Differences of `now()` readings taken at different moments are therefore never trusted
// beyond what the code itself could have scheduled.
// ---------------------------------------------------------------------------------------

/**
 * How long to wait so that `intervalMs` lie between the event at `lastAt` and the next one.
 * Never more than `intervalMs`: after a backward step of the clock `lastAt` lies "in the
 * future" and the plain difference would be the size of the step (an hour-long stall).
 */
export function paceWait(clock: Clock, lastAt: number, intervalMs: number): number {
  return Math.min(intervalMs, Math.max(0, lastAt + intervalMs - clock.now()));
}

/**
 * Time since `at`. A negative difference means that the clock stepped back: the time that
 * really passed is unknown, so it counts as "long ago" and never holds anything back.
 */
export function elapsedSince(clock: Clock, at: number): number {
  const elapsed = clock.now() - at;
  return elapsed < 0 ? Number.POSITIVE_INFINITY : elapsed;
}

/**
 * Whether a stored "not before" deadline has passed. A deadline further ahead than `maxWaitMs`
 * — the longest wait the code ever schedules — was computed under a wrong (future) clock and
 * is due now; otherwise the item would stay blocked until the clock catches up (a year…).
 */
export function isDue(clock: Clock, deadline: number, maxWaitMs: number): boolean {
  const left = deadline - clock.now();
  return left <= 0 || left > maxWaitMs;
}

/** Give the UI thread a turn (between pull pages, batches and photos). */
export function yieldToUi(clock: Clock, signal?: AbortSignal): Promise<void> {
  return sleep(clock, 0, signal);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SyncError('aborted', 'aborted');
}

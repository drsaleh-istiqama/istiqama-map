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
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
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
    const handle = clock.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Give the UI thread a turn (between pull pages, batches and photos). */
export function yieldToUi(clock: Clock, signal?: AbortSignal): Promise<void> {
  return sleep(clock, 0, signal);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SyncError('aborted', 'aborted');
}

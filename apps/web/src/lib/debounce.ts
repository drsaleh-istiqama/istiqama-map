/** A debounced function with explicit control over the pending call. */
export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /** Drops the pending call, if any. */
  cancel(): void;
  /** Runs the pending call now, if any. */
  flush(): void;
  /** True while a call is waiting. */
  pending(): boolean;
}

/**
 * Trailing-edge debounce: `fn` runs once, `waitMs` after the last call, with the arguments
 * of the last call (search box: 250 ms; draft autosave: on every field change).
 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;

  const run = (): void => {
    timer = null;
    const args = lastArgs;
    lastArgs = null;
    if (args) fn(...args);
  };

  const debounced = ((...args: A): void => {
    lastArgs = args;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(run, waitMs);
  }) as Debounced<A>;

  debounced.cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  debounced.flush = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    run();
  };
  debounced.pending = (): boolean => timer !== null;
  return debounced;
}

/**
 * Wraps an async lookup so that only the answer to the latest call is delivered: answers of
 * superseded calls resolve to `undefined` (type-ahead search must never show stale results).
 */
export function latestOnly<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R | undefined> {
  let ticket = 0;
  return async (...args: A): Promise<R | undefined> => {
    const mine = ++ticket;
    const result = await fn(...args);
    return mine === ticket ? result : undefined;
  };
}

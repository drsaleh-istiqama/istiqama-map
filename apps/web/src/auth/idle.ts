/**
 * Idle tracker for the PIN lock (brief §3: lock after 15 minutes without use).
 *
 * "Use" is a pointer press, a key press, a wheel/touch gesture, or the tab becoming visible
 * again before the limit. Time spent hidden counts as idle: nothing refreshes the clock while
 * the tab is in the background, and because mobile browsers freeze timers there, the elapsed
 * time is re-checked the moment the tab is shown again (the wall clock decides, not the timer).
 */
export const DEFAULT_IDLE_MINUTES = 15;
const MIN_IDLE_MINUTES = 1;
const MAX_IDLE_MINUTES = 240;

export interface IdleTrackerOptions {
  timeoutMs: number;
  onIdle: () => void;
  now?: () => number;
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
}

export interface IdleTracker {
  start(): void;
  stop(): void;
  /** Counts as activity (also called by the listeners). */
  touch(): void;
  setTimeoutMs(ms: number): void;
  readonly running: boolean;
}

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/** Clamps the `security.pin_lock_minutes` setting to a sane range (default 15). */
export function idleMinutesFromSetting(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_IDLE_MINUTES;
  return Math.min(MAX_IDLE_MINUTES, Math.max(MIN_IDLE_MINUTES, n));
}

export function createIdleTracker(options: IdleTrackerOptions): IdleTracker {
  const now = options.now ?? (() => Date.now());
  const target = options.target ?? (typeof window !== 'undefined' ? window : undefined);
  const doc = options.doc ?? (typeof document !== 'undefined' ? document : undefined);
  let timeoutMs = options.timeoutMs;
  let lastActivity = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const fire = (): void => {
    clear();
    running = false;
    detach();
    options.onIdle();
  };

  const schedule = (): void => {
    clear();
    if (!running) return;
    const remaining = lastActivity + timeoutMs - now();
    if (remaining <= 0) {
      fire();
      return;
    }
    timer = setTimeout(check, remaining);
  };

  // Timers can fire early or very late (throttling, suspended tabs): always re-read the clock.
  const check = (): void => {
    timer = undefined;
    schedule();
  };

  const onActivity = (): void => {
    if (!running) return;
    if (doc && doc.visibilityState === 'hidden') return; // background noise is not "use"
    // Activity that arrives after the limit (the timer was frozen) must not rescue the session.
    if (now() - lastActivity >= timeoutMs) {
      fire();
      return;
    }
    lastActivity = now();
    schedule();
  };

  const onVisibility = (): void => {
    if (!running || !doc || doc.visibilityState !== 'visible') return;
    if (now() - lastActivity >= timeoutMs) fire();
    else onActivity();
  };

  function attach(): void {
    for (const type of ACTIVITY_EVENTS) {
      target?.addEventListener(type, onActivity, { passive: true, capture: true });
    }
    doc?.addEventListener('visibilitychange', onVisibility);
  }

  function detach(): void {
    for (const type of ACTIVITY_EVENTS) {
      target?.removeEventListener(type, onActivity, { capture: true });
    }
    doc?.removeEventListener('visibilitychange', onVisibility);
  }

  return {
    start() {
      if (running) return;
      running = true;
      lastActivity = now();
      attach();
      schedule();
    },
    stop() {
      if (!running) return;
      running = false;
      clear();
      detach();
    },
    touch: onActivity,
    setTimeoutMs(ms: number) {
      timeoutMs = ms;
      if (running) schedule();
    },
    get running() {
      return running;
    },
  };
}

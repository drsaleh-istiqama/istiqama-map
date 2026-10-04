/**
 * Cross-tab mutual exclusion for sync cycles: only one tab of the installation pushes,
 * pulls and uploads at a time.
 *
 * Preferred: the Web Locks API (released automatically when the tab dies).
 * Fallback (insecure context, old WebView): a lease stored in the IndexedDB `meta` store —
 * acquired with an atomic read-modify-write, renewed while the work runs, and expiring on
 * its own when the owning tab crashes. The lease is best-effort; correctness never depends
 * on it because `sync_push` is idempotent and applying a pull page twice is harmless.
 */
import { type Clock, isDue, sleep } from './clock';
import type { DbPort, LockPort } from './ports';

export const SYNC_LOCK_NAME = 'istiqama-map-sync';
export const META_LEASE = 'sync.lock';

/** The subset of `LockManager` used here. */
export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable?: boolean; mode?: 'exclusive' | 'shared' },
    callback: (lock: unknown | null) => Promise<unknown>,
  ): Promise<unknown>;
}

export interface LeaseOptions {
  /** A lease not renewed for this long is considered abandoned. */
  ttlMs?: number;
  /** Poll interval while waiting for the lock. */
  pollMs?: number;
  /** Give up waiting after this long (`wait: true`). */
  maxWaitMs?: number;
  ownerId?: string;
}

interface Lease {
  owner: string;
  expiresAt: number;
}

type LockResult<T> = { acquired: true; value: T } | { acquired: false };

export function webLock(locks: LockManagerLike, name = SYNC_LOCK_NAME): LockPort {
  return {
    async run<T>(fn: () => Promise<T>, opts: { wait: boolean }): Promise<LockResult<T>> {
      const result = await locks.request(
        name,
        { mode: 'exclusive', ifAvailable: !opts.wait },
        async (lock) => {
          if (lock === null) return { acquired: false } satisfies LockResult<T>;
          return { acquired: true, value: await fn() } satisfies LockResult<T>;
        },
      );
      return result as LockResult<T>;
    },
  };
}

function randomOwner(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function leaseLock(
  db: Pick<DbPort, 'updateMeta'>,
  clock: Clock,
  options: LeaseOptions = {},
): LockPort {
  const ttlMs = options.ttlMs ?? 30_000;
  const pollMs = options.pollMs ?? 500;
  const maxWaitMs = options.maxWaitMs ?? 120_000;
  const owner = options.ownerId ?? randomOwner();

  async function tryAcquire(): Promise<boolean> {
    // A lease that expires further ahead than one TTL was written under a wrong (future)
    // clock by a tab that is gone: it must not lock every tab out until the clock catches up.
    const lease = await db.updateMeta<Lease>(META_LEASE, (cur) =>
      !cur || cur.owner === owner || isDue(clock, cur.expiresAt, ttlMs)
        ? { owner, expiresAt: clock.now() + ttlMs }
        : cur,
    );
    return lease?.owner === owner;
  }

  async function release(): Promise<void> {
    await db.updateMeta<Lease>(META_LEASE, (cur) => (cur && cur.owner === owner ? undefined : cur));
  }

  return {
    async run<T>(fn: () => Promise<T>, opts: { wait: boolean }): Promise<LockResult<T>> {
      // Waiting is counted in polls, not by reading the clock (which may step back).
      let waited = 0;
      while (!(await tryAcquire())) {
        if (!opts.wait || waited >= maxWaitMs) return { acquired: false };
        await sleep(clock, pollMs);
        waited += pollMs;
      }
      let renewTimer: unknown = null;
      let held = true;
      const renew = (): void => {
        renewTimer = clock.setTimeout(() => {
          if (!held) return;
          void tryAcquire()
            .catch(() => false)
            .then(() => {
              if (held) renew();
            });
        }, ttlMs / 3);
      };
      renew();
      try {
        return { acquired: true, value: await fn() };
      } finally {
        held = false;
        if (renewTimer !== null) clock.clearTimeout(renewTimer);
        await release().catch(() => undefined);
      }
    },
  };
}

/** Web Locks when the browser has them, else the IndexedDB lease. */
export function createSyncLock(
  db: Pick<DbPort, 'updateMeta'>,
  clock: Clock,
  locks: LockManagerLike | null | undefined = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { locks?: LockManagerLike }).locks
    : undefined,
): LockPort {
  return locks && typeof locks.request === 'function' ? webLock(locks) : leaseLock(db, clock);
}

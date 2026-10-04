/**
 * The sync engine: single-flight cycles of
 *
 *   register device (once) → push → pull → photos (→ push the photo flips) → heartbeat
 *
 * triggered on start, when the browser comes online, every 2 minutes while online, when
 * the page becomes visible again, shortly after a local write, and by `syncNow()`. Only one
 * tab runs a cycle at a time (`LockPort`); a failing cycle is retried with exponential
 * backoff and jitter.
 */
import type { Signal } from '@preact/signals';
import { CYCLE_BACKOFF, backoffDelay } from './backoff';
import { type Clock, systemClock } from './clock';
import { registerDevice, reportDeviceStatus, revocationOf } from './device';
import { errorKey, toSyncError } from './errors';
import { type PhotoQueue, type PhotoRunOptions, createPhotoQueue } from './photoQueue';
import type {
  AppInfo,
  AuthPort,
  DbPort,
  LockPort,
  NetworkPort,
  PrefsPort,
  ResumableUploader,
  SessionProblem,
} from './ports';
import { type PullOptions, pullChanges, resetSyncedData } from './pull';
import { type PushOptions, pushOutbox } from './push';
import { createStatusSignal, patchStatus } from './status';
import type { SyncStatus, Transport } from './types';

export const META_LAST_SYNC = 'sync.last_sync_at';
export const META_USER = 'sync.user';

/**
 * Why local data is dropped:
 *  - `scope` (default) / `sign_out`: forget everything pulled from the server and the cursor;
 *    unsent work (outbox, photo blobs, drafts, restricted_local, failed_ops) stays so that
 *    the same user can continue after signing in again;
 *  - `user_changed` / `revoked`: remove every local store.
 */
export type ResetReason = 'scope' | 'sign_out' | 'user_changed' | 'revoked';

export interface EngineDeps {
  db: DbPort;
  transport: Transport;
  auth: AuthPort;
  net: NetworkPort;
  prefs: PrefsPort;
  app: AppInfo;
  lock: LockPort;
  uploader: ResumableUploader;
  clock?: Clock;
  /** Status signal to drive (index.ts passes the exported `syncStatus`). */
  status?: Signal<SyncStatus>;
  /** Asks the browser for persistent storage; called once when the engine starts. */
  requestPersistence?: () => Promise<unknown>;
}

export interface EngineOptions {
  /** Regular interval between cycles while online (brief §4.2: two minutes). */
  intervalMs?: number;
  /** Delay before continuing when a cycle stopped at a work cap. */
  continueDelayMs?: number;
  /** A visibility change triggers a cycle only when the last attempt is older than this. */
  minVisibleGapMs?: number;
  /** A cycle starts this long after a local write while online and healthy (0 = never). */
  writeKickDelayMs?: number;
  /** Delay between `enqueuePhotoUpload` and the cycle it triggers (batches several photos). */
  photoKickDelayMs?: number;
  /** Continuation cycles do not send the heartbeat more often than this. */
  heartbeatGapMs?: number;
  push?: Omit<PushOptions, 'signal'>;
  pull?: Omit<PullOptions, 'signal'>;
  photos?: Omit<PhotoRunOptions, 'signal'>;
}

export interface SyncEngine {
  readonly status: Signal<SyncStatus>;
  readonly photos: PhotoQueue;
  start(): void;
  stop(): void;
  /** Runs a cycle now (waiting for another tab if necessary) and resolves when it finished. */
  syncNow(): Promise<void>;
  resetLocalData(reason?: ResetReason): Promise<void>;
  enqueuePhotoUpload(photoId: string): Promise<void>;
  /** The signed-in user changed (sign-in, unlock): sync right away. */
  sessionChanged(): void;
  /** Re-read the pending counters into the status signal. */
  refreshStatus(): Promise<void>;
  /** Resolves when no cycle is running and no notification is in flight (tests, sign-out). */
  whenIdle(): Promise<void>;
}

class SessionProblemError extends Error {
  constructor(readonly reason: SessionProblem['reason']) {
    super(reason);
    this.name = 'SessionProblemError';
  }
}

export function createSyncEngine(deps: EngineDeps, options: EngineOptions = {}): SyncEngine {
  const { db, transport, auth, net, app, lock } = deps;
  const clock = deps.clock ?? systemClock;
  const status = deps.status ?? createStatusSignal();
  const photos = createPhotoQueue({ db, uploader: deps.uploader, net, prefs: deps.prefs, clock });

  const intervalMs = options.intervalMs ?? 120_000;
  const continueDelayMs = options.continueDelayMs ?? 250;
  const minVisibleGapMs = options.minVisibleGapMs ?? 15_000;
  const writeKickDelayMs = options.writeKickDelayMs ?? 4_000;
  const photoKickDelayMs = options.photoKickDelayMs ?? 1_500;
  const heartbeatGapMs = options.heartbeatGapMs ?? 30_000;

  let started = false;
  /** startSync() was called and stopSync() was not: restart after a revocation + new sign-in. */
  let wanted = false;
  let timer: unknown = null;
  let timerDueAt = 0;
  let running: Promise<void> | null = null;
  let notifying: Promise<void> | null = null;
  let again = false;
  let abort: AbortController | null = null;
  let failures = 0;
  let registered = false;
  let authRetried = false;
  let authProblemNotified = false;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let lastHeartbeatAt = Number.NEGATIVE_INFINITY;
  let nextDelay = intervalMs;
  /** A trigger that arrived while a cycle was running wants the next one no later than this. */
  let soonest: number | null = null;
  let lastSeenPendingOps = 0;
  let unsubscribers: Array<() => void> = [];
  let countsQueued = false;

  // -- status -------------------------------------------------------------------------------

  async function refreshCounts(): Promise<void> {
    try {
      const [counts, pendingPhotos, lastSyncAt] = await Promise.all([
        db.counts(),
        photos.pendingCount(),
        db.getMeta<number>(META_LAST_SYNC),
      ]);
      patchStatus(status, {
        pendingOps: counts.pendingOps,
        failedOps: counts.failedOps,
        pendingPhotos,
        lastSyncAt: typeof lastSyncAt === 'number' ? lastSyncAt : null,
      });
      // New local work while online and healthy: do not wait for the two-minute timer.
      if (counts.pendingOps > lastSeenPendingOps && writeKickDelayMs > 0 && failures === 0) {
        scheduleSooner(writeKickDelayMs);
      }
      lastSeenPendingOps = counts.pendingOps;
    } catch {
      // The database may be closing or just wiped; the next change notification retries.
    }
  }

  /** Coalesce bursts of change notifications into one read. */
  function queueCountsRefresh(): void {
    if (countsQueued) return;
    countsQueued = true;
    clock.setTimeout(() => {
      countsQueued = false;
      void refreshCounts();
    }, 50);
  }

  // -- scheduling ---------------------------------------------------------------------------

  function clearTimer(): void {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  }

  function schedule(ms: number): void {
    clearTimer();
    if (!started) return;
    timerDueAt = clock.now() + ms;
    timer = clock.setTimeout(() => {
      timer = null;
      void launch(false);
    }, ms);
  }

  /** Bring the next cycle forward (never postpones an earlier one). */
  function scheduleSooner(ms: number): void {
    if (!started || !net.isOnline()) return;
    if (running) {
      soonest = soonest === null ? ms : Math.min(soonest, ms);
      return;
    }
    if (timer !== null && timerDueAt <= clock.now() + ms) return;
    schedule(ms);
  }

  function launch(wait: boolean): Promise<void> {
    if (running) return running;
    clearTimer();
    let waitForLock = wait;
    running = (async () => {
      try {
        do {
          again = false;
          soonest = null;
          await cycle(waitForLock);
          waitForLock = true; // a requested re-run comes from syncNow()
        } while (again);
      } finally {
        running = null;
        // A trigger that arrived during the cycle may bring the next one forward — but never
        // ahead of the backoff of a failing engine.
        const delay = soonest !== null && failures === 0 ? Math.min(nextDelay, soonest) : nextDelay;
        soonest = null;
        if (started && net.isOnline()) schedule(delay);
      }
    })();
    return running;
  }

  // -- one cycle ----------------------------------------------------------------------------

  async function cycle(waitForLock: boolean): Promise<void> {
    nextDelay = intervalMs;
    if (auth.userId() === null) {
      if (status.peek().state !== 'error') patchStatus(status, { state: 'idle' });
      return;
    }
    const online = net.isOnline();
    patchStatus(status, { online });
    if (!online) {
      if (status.peek().state !== 'error') patchStatus(status, { state: 'idle' });
      return;
    }
    lastAttemptAt = clock.now();
    const controller = new AbortController();
    abort = controller;
    try {
      const held = await lock.run(() => work(controller.signal), { wait: waitForLock });
      // Not acquired: another tab is syncing; its results arrive through the shared database.
      if (!held.acquired) await refreshCounts();
    } catch (e) {
      await fail(e, controller.signal);
    } finally {
      if (abort === controller) abort = null;
    }
  }

  async function work(signal: AbortSignal): Promise<void> {
    await claimForUser();

    patchStatus(status, { state: 'pushing' });
    if (!registered) {
      const answer = await registerDevice({ transport, auth, app }, signal);
      const problem = revocationOf(answer);
      if (problem) throw new SessionProblemError(problem);
      registered = true;
    }
    await pushOutbox({ db, transport, auth, clock }, { ...options.push, signal });

    patchStatus(status, { state: 'pulling' });
    const pulled = await pullChanges({ db, transport, clock }, { ...options.pull, signal });

    patchStatus(status, { state: 'pushing' });
    const uploaded = await photos.run({ ...options.photos, signal });
    // The rows that just became `uploaded` go out in the same cycle.
    if (uploaded.uploaded > 0) await pushOutbox({ db, transport, auth, clock }, { ...options.push, signal });

    const more = !pulled.done || uploaded.more;
    await heartbeat(more, signal);

    if (pulled.done) {
      const now = clock.now();
      await db.setMeta(META_LAST_SYNC, now);
      failures = 0;
      authRetried = false;
      authProblemNotified = false;
      patchStatus(status, { state: 'idle', lastError: null, lastSyncAt: now });
    }
    if (more) {
      patchStatus(status, { state: pulled.done ? 'pushing' : 'pulling' });
      nextDelay = continueDelayMs;
    }
    await refreshCounts();
  }

  /**
   * Heartbeat with the pending counters (sync-status board). Best effort — but its answer is
   * also how a device learns that it was revoked.
   */
  async function heartbeat(continuing: boolean, signal: AbortSignal): Promise<void> {
    if (continuing && clock.now() - lastHeartbeatAt < heartbeatGapMs) return;
    let answer;
    try {
      const [counts, pendingPhotos] = await Promise.all([db.counts(), photos.pendingCount()]);
      lastHeartbeatAt = clock.now();
      const counters = { pendingOps: counts.pendingOps, pendingPhotos };
      answer = await reportDeviceStatus({ transport, auth, app }, counters, signal);
    } catch (e) {
      const err = toSyncError(e);
      if (err.fatalForSession || err.kind === 'aborted') throw err;
      return;
    }
    const problem = revocationOf(answer);
    if (problem) throw new SessionProblemError(problem);
  }

  /**
   * The local stores carry no user id. If somebody else signed in on this device while data
   * of the previous user is still here, nothing of it may be shown to or pushed as the new
   * user: remove it (auth normally calls `resetLocalData('user_changed')` before this point).
   */
  async function claimForUser(): Promise<void> {
    const user = auth.userId();
    const previous = await db.getMeta<string>(META_USER);
    if (previous === user) return;
    if (typeof previous === 'string') {
      await db.wipeAll();
      patchStatus(status, { lastSyncAt: null });
    }
    await db.setMeta(META_USER, user);
    registered = false;
  }

  async function fail(e: unknown, signal: AbortSignal): Promise<void> {
    if (e instanceof SessionProblemError) return revoked(e.reason);
    const err = toSyncError(e);
    if (err.kind === 'aborted' || signal.aborted) {
      // stopSync(), resetLocalData() or the connection went away: not a failure.
      if (status.peek().state !== 'error') patchStatus(status, { state: 'idle' });
      await refreshCounts();
      return;
    }
    if (err.kind === 'session_revoked') return revoked('session_revoked');
    if (err.kind === 'unauthenticated' && !authRetried) {
      // The access token may simply have expired while the phone slept: refresh once.
      authRetried = true;
      const token = await auth.accessToken().catch(() => null);
      if (token) {
        nextDelay = continueDelayMs;
        patchStatus(status, { state: 'error', lastError: errorKey(err) });
        return;
      }
    }
    failures++;
    nextDelay = backoffDelay(CYCLE_BACKOFF, failures - 1, () => clock.random(), err.retryAfterMs ?? 0);
    patchStatus(status, { state: 'error', lastError: errorKey(err) });
    // Not a network/server condition: a defect worth a trace (Sentry picks console.error up).
    if (err.kind === 'unknown') console.error('sync: cycle failed', err.cause ?? err);
    if (err.kind === 'unauthenticated' && !authProblemNotified) {
      // Local data stays; the user has to sign in again. Cycles keep trying (with backoff),
      // so syncing resumes by itself once a valid session exists.
      authProblemNotified = true;
      notify({ reason: 'not_authenticated', wiped: false });
    }
    await refreshCounts();
  }

  /** sync.md §7.11: a revoked session or device wipes everything stored on the device. */
  async function revoked(reason: SessionProblem['reason']): Promise<void> {
    halt();
    let wiped = false;
    try {
      await db.wipeAll();
      wiped = true;
    } catch (e) {
      console.error('sync: could not wipe local data after revocation', e);
    }
    registered = false;
    patchStatus(status, {
      state: 'error',
      lastError: 'sync.error_revoked',
      ...(wiped ? { pendingOps: 0, pendingPhotos: 0, failedOps: 0, lastSyncAt: null } : {}),
    });
    notify({ reason, wiped });
  }

  /** Tell auth after the cycle unwound, so that auth may call back into this engine. */
  function notify(problem: SessionProblem): void {
    const previous = notifying ?? Promise.resolve();
    const current: Promise<void> = previous
      .then(() => auth.onSessionProblem(problem))
      .catch((e: unknown) => console.error('sync: auth.onSessionProblem failed', e))
      .finally(() => {
        if (notifying === current) notifying = null;
      });
    notifying = current;
  }

  // -- lifecycle ----------------------------------------------------------------------------

  function halt(): void {
    started = false;
    again = false;
    clearTimer();
    for (const off of unsubscribers) off();
    unsubscribers = [];
  }

  function begin(): void {
    if (started) return;
    started = true;
    failures = 0;
    authRetried = false;
    authProblemNotified = false;
    registered = false;
    patchStatus(status, { online: net.isOnline(), state: 'idle', lastError: null });
    unsubscribers = [net.onChange(onConnectivity), net.onVisible(onVisible), db.watch(queueCountsRefresh)];
    void refreshCounts();
    void launch(false);
  }

  function onConnectivity(online: boolean): void {
    patchStatus(status, { online });
    if (online) {
      failures = 0;
      void launch(false);
    } else {
      clearTimer();
      // Requests in flight cannot finish; aborting requeues the batch (same op ids later).
      abort?.abort();
    }
  }

  function onVisible(): void {
    if (!net.isOnline()) return;
    if (clock.now() - lastAttemptAt >= minVisibleGapMs) void launch(false);
  }

  async function settle(): Promise<void> {
    while (running) await running.catch(() => undefined);
  }

  return {
    status,
    photos,

    start() {
      wanted = true;
      if (!started && deps.requestPersistence) void deps.requestPersistence().catch(() => undefined);
      begin();
    },

    stop() {
      wanted = false;
      halt();
      abort?.abort();
      if (status.peek().state !== 'error') patchStatus(status, { state: 'idle' });
    },

    async syncNow() {
      if (auth.userId() === null) return;
      failures = 0; // the user asked: do not wait for the backoff
      if (running) {
        again = true;
        await running;
        return;
      }
      await launch(true);
    },

    async resetLocalData(reason: ResetReason = 'scope') {
      abort?.abort();
      again = false;
      await settle();
      clearTimer();
      const everything = reason === 'user_changed' || reason === 'revoked';
      await lock.run(
        async () => {
          if (everything) {
            await db.wipeAll();
          } else {
            await resetSyncedData(db, null);
            await db.deleteMeta(META_LAST_SYNC);
          }
        },
        { wait: true },
      );
      registered = false;
      failures = 0;
      lastSeenPendingOps = 0;
      patchStatus(status, { lastSyncAt: null, lastError: null, state: 'idle' });
      await refreshCounts();
      if (started) void launch(false);
    },

    async enqueuePhotoUpload(photoId) {
      await photos.enqueue(photoId);
      await refreshCounts();
      scheduleSooner(photoKickDelayMs);
    },

    sessionChanged() {
      if (!wanted) return;
      failures = 0;
      authRetried = false;
      authProblemNotified = false;
      if (!started) begin();
      else if (auth.userId() !== null) void launch(false);
    },

    refreshStatus: refreshCounts,

    async whenIdle() {
      for (;;) {
        await settle();
        if (!notifying) return;
        await notifying;
      }
    },
  };
}

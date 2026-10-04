/**
 * Pull: page through `sync_pull` until `done` (docs/contracts/sync.md §5).
 *
 *  - the cursor is stored in `meta` in the same transaction as the rows of its page, never
 *    before: after a crash the page is simply requested again (re-applying is idempotent);
 *  - `reset: true` or a changed `scope_epoch` discards the synced tables first (the outbox,
 *    photo blobs, drafts and restricted_local survive) and restarts from a null cursor; the
 *    discard is marked in `meta` before it starts, so a crash in the middle is finished by
 *    the next pull instead of leaving stale rows under a fresh cursor;
 *  - work per cycle is capped and the UI thread gets a turn between pages;
 *  - a page that cannot be stored in one transaction (slow or memory-starved phone) is
 *    requested again in smaller pages from the same cursor, and that smaller size is kept.
 */
import { REQUEST_BACKOFF, backoffDelay } from './backoff';
import { type Clock, paceWait, sleep, throwIfAborted, yieldToUi } from './clock';
import { SyncError, toSyncError } from './errors';
import type { DbPort } from './ports';
import type { PullPage, Transport } from './types';

/** Meta key of the pull position. */
export const META_PULL_STATE = 'sync.pull';

export interface PullState {
  /** Opaque server cursor; null = start a first round. */
  cursor: unknown | null;
  /** `scope_epoch` the local data belongs to. */
  epoch: string | null;
  /** True once a round reached `done` for this epoch (the local copy is complete). */
  complete?: boolean;
  /**
   * Set before the synced tables are discarded and removed afterwards. Found at the start of
   * a pull, it means the discard was interrupted (crash, closed tab): it is done again first.
   */
  wipePending?: boolean;
}

/**
 * Page-size knowledge that outlives one `pullChanges` call (the engine keeps one per page
 * load): after a page could not be stored, later cycles do not ask for more than `ceiling`.
 */
export interface PullTuning {
  ceiling: number | null;
}

export interface PullDeps {
  db: DbPort;
  transport: Transport;
  clock: Clock;
}

export interface PullOptions {
  signal?: AbortSignal;
  /** Rows per page (server clamps to 1..1000; the brief asks for 500). */
  pageSize?: number;
  /** Cap of pages per cycle; the engine continues right away when more is waiting. */
  maxPages?: number;
  maxAttempts?: number;
  maxInlineWaitMs?: number;
  /** Minimum spacing between two calls (server limit: 600 calls / minute / user). */
  minIntervalMs?: number;
  /** A page that takes longer than this to store halves the page size (slow phones). */
  slowApplyMs?: number;
  /** Smallest page asked for after a page could not be stored. */
  minApplyPageSize?: number;
  /** Shared across calls by the engine (see `PullTuning`). */
  tuning?: PullTuning;
}

export interface PullOutcome {
  pages: number;
  rows: number;
  /** False when the cycle stopped at `maxPages` with more data waiting. */
  done: boolean;
  /** True when the synced tables were discarded during this run. */
  reset: boolean;
}

const MIN_PAGE_SIZE = 50;
/** Smallest page requested again after a page could not be stored (see `minApplyPageSize`). */
const MIN_APPLY_PAGE_SIZE = 20;
/** Give up on storing smaller pages after this many refusals in one call. */
const MAX_APPLY_RETRIES = 8;

function countRows(page: PullPage): number {
  let n = 0;
  for (const c of page.changes) n += (c.rows?.length ?? 0) + (c.gone?.length ?? 0);
  return n;
}

/** Forget the pull position (and remember which epoch the next data will belong to). */
export async function clearPullState(db: DbPort, epoch: string | null = null): Promise<void> {
  if (epoch === null) await db.deleteMeta(META_PULL_STATE);
  else
    await db.setMeta(META_PULL_STATE, { cursor: null, epoch, complete: false } satisfies PullState);
}

/** Discard everything that came from the server and start over (sync.md §5.2). */
export async function resetSyncedData(db: DbPort, epoch: string | null = null): Promise<void> {
  // Crash safety: the marker goes first. A reset interrupted after it is completed by the
  // next pull; without it a fresh first round (live rows only, no tombstones) would leave
  // rows deleted on the server in the local copy for ever.
  await db.setMeta(META_PULL_STATE, {
    cursor: null,
    epoch,
    complete: false,
    wipePending: true,
  } satisfies PullState);
  await db.resetScopedData();
  await clearPullState(db, epoch);
}

let warnedApplyRetry = false;

export async function pullChanges(deps: PullDeps, options: PullOptions = {}): Promise<PullOutcome> {
  const { db, transport, clock } = deps;
  const signal = options.signal;
  const maxPages = Math.max(1, options.maxPages ?? 20);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const maxInlineWaitMs = options.maxInlineWaitMs ?? 10_000;
  const minIntervalMs = options.minIntervalMs ?? 120;
  const slowApplyMs = options.slowApplyMs ?? 1_500;
  const minApplyPage = Math.max(1, options.minApplyPageSize ?? MIN_APPLY_PAGE_SIZE);
  const tuning = options.tuning;
  const fullPage = Math.min(1000, Math.max(1, options.pageSize ?? 500));
  const ceiling = (): number => Math.min(fullPage, tuning?.ceiling ?? fullPage);
  let limit = ceiling();

  const outcome: PullOutcome = { pages: 0, rows: 0, done: false, reset: false };
  let stored = await db.getMeta<PullState>(META_PULL_STATE);
  if (stored?.wipePending === true) {
    // A previous reset was interrupted: finish it before anything is pulled on top.
    await resetSyncedData(db, stored.epoch ?? null);
    outcome.reset = true;
    stored = await db.getMeta<PullState>(META_PULL_STATE);
  }
  let cursor: unknown | null = stored?.cursor ?? null;
  let epoch: string | null = stored?.epoch ?? null;
  let complete = stored?.complete ?? false;
  let lastCallAt = Number.NEGATIVE_INFINITY;
  let recoveredCursor = false;
  let applyRetries = 0;

  async function fetchPage(): Promise<PullPage> {
    for (let attempt = 0; ; attempt++) {
      try {
        throwIfAborted(signal);
        const wait = paceWait(clock, lastCallAt, minIntervalMs);
        if (wait > 0) await sleep(clock, wait, signal);
        lastCallAt = clock.now();
        return await transport.pull(cursor, limit, { signal });
      } catch (e) {
        const err = toSyncError(e);
        if (!err.retryable || signal?.aborted) throw err;
        const delay = backoffDelay(
          REQUEST_BACKOFF,
          attempt,
          () => clock.random(),
          err.retryAfterMs ?? 0,
        );
        if (attempt + 1 >= maxAttempts || delay > maxInlineWaitMs) throw err;
        await sleep(clock, delay, signal);
      }
    }
  }

  while (outcome.pages < maxPages) {
    throwIfAborted(signal);
    let page: PullPage;
    try {
      page = await fetchPage();
    } catch (e) {
      const err = toSyncError(e);
      // A cursor the server cannot read is useless: start again from scratch, once.
      if (
        err.kind === 'invalid' &&
        /invalid_cursor/.test(err.message) &&
        cursor !== null &&
        !recoveredCursor
      ) {
        recoveredCursor = true;
        await resetSyncedData(db, epoch);
        cursor = null;
        complete = false;
        outcome.reset = true;
        continue;
      }
      throw err;
    }

    const pageEpoch = typeof page.scope_epoch === 'string' ? page.scope_epoch : null;
    const epochChanged = pageEpoch !== null && epoch !== null && pageEpoch !== epoch;
    if (page.reset === true || epochChanged) {
      const requestedFrom = cursor;
      await resetSyncedData(db, pageEpoch ?? epoch);
      outcome.reset = true;
      complete = false;
      cursor = null;
      epoch = pageEpoch ?? epoch;
      if (page.reset !== true && requestedFrom !== null) {
        // The page was an increment of the old scope: useless on an empty store. Start over.
        continue;
      }
      // Otherwise the response already is the first page of the fresh round (§5.2).
    }
    if (pageEpoch !== null) epoch = pageEpoch;
    const nextComplete = complete || page.done;

    const startedAt = clock.now();
    try {
      await db.applyPage({
        changes: page.changes,
        meta: [
          {
            key: META_PULL_STATE,
            value: { cursor: page.cursor, epoch, complete: nextComplete } satisfies PullState,
          },
        ],
      });
    } catch (e) {
      const err = toSyncError(e);
      const size = countRows(page);
      // Nothing of the page was stored (one transaction) and the cursor did not move. A full
      // device or a cancelled cycle is reported; anything else may be the size of the
      // transaction: ask for the same position again in smaller pages.
      if (err.kind === 'storage_full' || err.kind === 'aborted' || signal?.aborted) throw err;
      if (size <= minApplyPage || applyRetries >= MAX_APPLY_RETRIES) throw err;
      applyRetries++;
      limit = Math.max(minApplyPage, Math.floor(Math.min(limit, size) / 2));
      if (tuning) tuning.ceiling = limit;
      if (!warnedApplyRetry) {
        warnedApplyRetry = true;
        console.warn(
          `sync: a pulled page of ${size} rows could not be stored; asking for ${limit} rows`,
          err.cause ?? err,
        );
      }
      continue;
    }
    complete = nextComplete;
    cursor = page.cursor;
    outcome.pages++;
    outcome.rows += countRows(page);

    if (page.done) {
      outcome.done = true;
      return outcome;
    }
    if (page.cursor === null || page.cursor === undefined) {
      throw new SyncError('bad_response', 'sync_pull: missing cursor on an unfinished round');
    }

    // Keep the phone responsive: shrink pages that take long to store, recover slowly.
    const took = clock.now() - startedAt;
    if (took > slowApplyMs) limit = Math.max(Math.min(MIN_PAGE_SIZE, limit), Math.floor(limit / 2));
    else if (took < slowApplyMs / 4) limit = Math.min(ceiling(), limit * 2);
    await yieldToUi(clock, signal);
  }
  return outcome;
}

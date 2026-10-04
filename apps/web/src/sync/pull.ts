/**
 * Pull: page through `sync_pull` until `done` (docs/contracts/sync.md §5).
 *
 *  - the cursor is stored in `meta` in the same transaction as the rows of its page, never
 *    before: after a crash the page is simply requested again (re-applying is idempotent);
 *  - `reset: true` or a changed `scope_epoch` discards the synced tables first (the outbox,
 *    photo blobs, drafts and restricted_local survive) and restarts from a null cursor;
 *  - work per cycle is capped and the UI thread gets a turn between pages.
 */
import { REQUEST_BACKOFF, backoffDelay } from './backoff';
import { type Clock, sleep, throwIfAborted, yieldToUi } from './clock';
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

function countRows(page: PullPage): number {
  let n = 0;
  for (const c of page.changes) n += (c.rows?.length ?? 0) + (c.gone?.length ?? 0);
  return n;
}

/** Forget the pull position (and remember which epoch the next data will belong to). */
export async function clearPullState(db: DbPort, epoch: string | null = null): Promise<void> {
  if (epoch === null) await db.deleteMeta(META_PULL_STATE);
  else await db.setMeta(META_PULL_STATE, { cursor: null, epoch, complete: false } satisfies PullState);
}

/** Discard everything that came from the server and start over (sync.md §5.2). */
export async function resetSyncedData(db: DbPort, epoch: string | null = null): Promise<void> {
  // Order matters for crash safety: without a cursor the next pull starts from null anyway.
  await clearPullState(db, epoch);
  await db.resetScopedData();
}

export async function pullChanges(deps: PullDeps, options: PullOptions = {}): Promise<PullOutcome> {
  const { db, transport, clock } = deps;
  const signal = options.signal;
  const maxPages = Math.max(1, options.maxPages ?? 20);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const maxInlineWaitMs = options.maxInlineWaitMs ?? 10_000;
  const minIntervalMs = options.minIntervalMs ?? 120;
  const slowApplyMs = options.slowApplyMs ?? 1_500;
  const fullPage = Math.min(1000, Math.max(1, options.pageSize ?? 500));
  let limit = fullPage;

  const stored = await db.getMeta<PullState>(META_PULL_STATE);
  let cursor: unknown | null = stored?.cursor ?? null;
  let epoch: string | null = stored?.epoch ?? null;
  let complete = stored?.complete ?? false;
  const outcome: PullOutcome = { pages: 0, rows: 0, done: false, reset: false };
  let lastCallAt = Number.NEGATIVE_INFINITY;
  let recoveredCursor = false;

  async function fetchPage(): Promise<PullPage> {
    for (let attempt = 0; ; attempt++) {
      try {
        throwIfAborted(signal);
        const wait = lastCallAt + minIntervalMs - clock.now();
        if (wait > 0) await sleep(clock, wait, signal);
        lastCallAt = clock.now();
        return await transport.pull(cursor, limit, { signal });
      } catch (e) {
        const err = toSyncError(e);
        if (!err.retryable || signal?.aborted) throw err;
        const delay = backoffDelay(REQUEST_BACKOFF, attempt, () => clock.random(), err.retryAfterMs ?? 0);
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
      if (err.kind === 'invalid' && /invalid_cursor/.test(err.message) && cursor !== null && !recoveredCursor) {
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
    if (page.done) complete = true;

    const startedAt = clock.now();
    try {
      await db.applyPage({
        changes: page.changes,
        meta: [{ key: META_PULL_STATE, value: { cursor: page.cursor, epoch, complete } satisfies PullState }],
      });
    } catch (e) {
      throw toSyncError(e);
    }
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
    if (took > slowApplyMs) limit = Math.max(MIN_PAGE_SIZE, Math.floor(limit / 2));
    else if (took < slowApplyMs / 4) limit = Math.min(fullPage, limit * 2);
    await yieldToUi(clock, signal);
  }
  return outcome;
}

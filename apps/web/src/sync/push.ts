/**
 * Push: drain the local outbox through `sync_push` (docs/contracts/sync.md §4, §7).
 *
 *  - batches of ≤ 50, sent strictly one after the other;
 *  - a batch lists parents before children (registry order, then creation order);
 *  - ops are marked inflight before the request and acknowledged one by one afterwards;
 *  - a whole-call failure (network drop, timeout, 429, 5xx…) puts the SAME ops back in the
 *    queue — they keep their `op_id`, so a batch the server did apply comes back `duplicate`;
 *  - no operation ever disappears: it is either acknowledged or moved to `failed_ops`.
 */
import { REQUEST_BACKOFF, backoffDelay } from './backoff';
import { type Clock, sleep, throwIfAborted, yieldToUi } from './clock';
import type { SyncError} from './errors';
import { toSyncError } from './errors';
import type { AuthPort, DbPort, OutboxOp, SyncTableInfo } from './ports';
import type { PushOp, PushResult, Transport } from './types';

export const PUSH_BATCH_SIZE = 50;

export interface PushDeps {
  db: DbPort;
  transport: Transport;
  auth: Pick<AuthPort, 'deviceId'>;
  clock: Clock;
}

export interface PushOptions {
  signal?: AbortSignal;
  /** ≤ 50 (the server refuses more). */
  batchSize?: number;
  /** Attempts per batch inside one cycle before giving up until the next cycle. */
  maxAttempts?: number;
  /** Never wait longer than this inside a cycle; a longer wait is left to the engine's backoff. */
  maxInlineWaitMs?: number;
  /** Minimum spacing between two `sync_push` calls (server limit: 120 calls / minute / user). */
  minIntervalMs?: number;
}

export interface PushOutcome {
  batches: number;
  sent: number;
  applied: number;
  merged: number;
  conflicts: number;
  duplicates: number;
  rejected: number;
}

/**
 * Tables whose rows are referenced by other tables. A delete of such a row is sent after
 * the operations on its dependants, so that "edit a child, then delete the parent" (creation
 * order) is not turned into "delete the parent, child rejected with parent_deleted".
 */
const DEPENDANTS: Readonly<Record<string, readonly string[]>> = {
  localities: ['projects'],
  donors: ['project_donors'],
  projects: [
    'project_land',
    'project_facilities',
    'project_maintenance',
    'project_photos',
    'project_donors',
    'project_staff',
    'community_profiles',
    'staff_compensation',
    'community_sensitive',
  ],
  persons: ['project_staff', 'staff_compensation', 'person_merge_requests'],
  project_staff: ['staff_compensation'],
};

/**
 * Order operations for sending: registry order (parents before children), then creation
 * order (`seq`). Operations on the same table therefore always keep their creation order.
 */
export function orderOps(ops: readonly OutboxOp[], tables: readonly SyncTableInfo[]): OutboxOp[] {
  const rank = new Map<string, number>();
  tables.forEach((t, i) => rank.set(t.name, i));
  const unknown = tables.length; // unknown tables go last; the server answers `unknown_table`
  const upsertRank = (table: string): number => rank.get(table) ?? unknown;
  const deleteRank = (table: string): number => {
    let r = upsertRank(table);
    for (const child of DEPENDANTS[table] ?? []) r = Math.max(r, (rank.get(child) ?? -1) + 0.5);
    return r;
  };
  const keyed = ops.map((op) => ({ op, key: op.kind === 'delete' ? deleteRank(op.table) : upsertRank(op.table) }));
  keyed.sort((a, b) => a.key - b.key || a.op.seq - b.op.seq);
  return keyed.map((k) => k.op);
}

export function toWireOp(op: OutboxOp): PushOp {
  const wire: PushOp = {
    op_id: op.op_id,
    table: op.table,
    id: op.id,
    kind: op.kind,
    base_version: op.base_version,
    client_ts: op.client_ts,
  };
  if (op.kind === 'upsert') wire.fields = op.fields;
  return wire;
}

/** Whole-call refusals that are about the call or the device, not about one operation. */
const CALL_LEVEL_MESSAGES = /invalid_ops|too_many_ops|invalid_device_id|device_mismatch/;

/**
 * A definite 4xx for the whole call that no retry can fix and that may be caused by a single
 * operation (an unexpected database error escaping the per-op sub-transaction). Such a batch
 * is re-sent one operation at a time; the operation that still fails is parked in
 * `failed_ops` so that it cannot block the queue forever.
 */
function isolatable(err: SyncError): boolean {
  return (
    err.kind === 'invalid' &&
    (err.status === 400 || err.status === 422) &&
    !err.code.startsWith('PGRST') &&
    !CALL_LEVEL_MESSAGES.test(err.message)
  );
}

function emptyOutcome(): PushOutcome {
  return { batches: 0, sent: 0, applied: 0, merged: 0, conflicts: 0, duplicates: 0, rejected: 0 };
}

function count(outcome: PushOutcome, result: PushResult): void {
  if (result.status === 'applied') outcome.applied++;
  else if (result.status === 'merged') outcome.merged++;
  else if (result.status === 'conflict') outcome.conflicts++;
  else if (result.status === 'duplicate') outcome.duplicates++;
  else outcome.rejected++;
}

export async function pushOutbox(deps: PushDeps, options: PushOptions = {}): Promise<PushOutcome> {
  const { db, transport, auth, clock } = deps;
  const signal = options.signal;
  const batchSize = Math.min(PUSH_BATCH_SIZE, Math.max(1, options.batchSize ?? PUSH_BATCH_SIZE));
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const maxInlineWaitMs = options.maxInlineWaitMs ?? 10_000;
  const minIntervalMs = options.minIntervalMs ?? 600;
  const outcome = emptyOutcome();
  const deviceId = auth.deviceId();
  let lastSendAt = Number.NEGATIVE_INFINITY;

  /** Send one batch; inflight ops are requeued before any error leaves this function. */
  async function send(ops: OutboxOp[]): Promise<PushResult[]> {
    const wire = ops.map(toWireOp);
    const seqs = ops.map((o) => o.seq);
    for (let attempt = 0; ; attempt++) {
      try {
        throwIfAborted(signal);
        const wait = lastSendAt + minIntervalMs - clock.now();
        if (wait > 0) await sleep(clock, wait, signal);
        lastSendAt = clock.now();
        outcome.batches++;
        return await transport.push(wire, deviceId, { signal });
      } catch (e) {
        const err = toSyncError(e);
        const delay = err.retryable
          ? backoffDelay(REQUEST_BACKOFF, attempt, () => clock.random(), err.retryAfterMs ?? 0)
          : Number.POSITIVE_INFINITY;
        if (attempt + 1 >= maxAttempts || delay > maxInlineWaitMs || signal?.aborted) {
          await db.requeueInflight(seqs);
          throw err;
        }
        try {
          await sleep(clock, delay, signal);
        } catch (aborted) {
          await db.requeueInflight(seqs);
          throw aborted;
        }
      }
    }
  }

  async function acknowledge(ops: OutboxOp[], results: PushResult[]): Promise<void> {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i] as OutboxOp;
      const result = results[i] as PushResult;
      try {
        await db.ackOp(op, result);
      } catch (e) {
        // The op stays inflight; the next cycle requeues it and the server answers `duplicate`.
        throw toSyncError(e);
      }
      count(outcome, result);
    }
    outcome.sent += ops.length;
  }

  async function sendIsolated(ops: OutboxOp[]): Promise<void> {
    for (const op of ops) {
      const [claimed] = await db.markInflight([op.seq]);
      if (!claimed) continue;
      let results: PushResult[];
      try {
        results = await send([claimed]);
      } catch (e) {
        const err = toSyncError(e);
        if (!isolatable(err)) throw err;
        // `send` requeued it; record the refusal instead of retrying it forever.
        results = [
          {
            op_id: claimed.op_id,
            status: 'rejected',
            error: { code: 'call_failed', message: err.message, sqlstate: err.code || undefined },
          },
        ];
      }
      await acknowledge([claimed], results);
    }
  }

  // Leftovers of a run that died between "sent" and "acknowledged" (crash, reload, power loss).
  await db.requeueInflight();

  for (let pass = 0; pass < 100; pass++) {
    throwIfAborted(signal);
    const pending = await db.pendingOps();
    if (pending.length === 0) break;
    const ordered = orderOps(pending, db.tables);
    const position = new Map<number, number>();
    ordered.forEach((op, i) => position.set(op.seq, i));

    for (let start = 0; start < ordered.length; start += batchSize) {
      throwIfAborted(signal);
      const planned = ordered.slice(start, start + batchSize).map((o) => o.seq);
      // Claim atomically and send the payload as it is NOW (edits may have been coalesced in).
      const ops = await db.markInflight(planned);
      if (ops.length === 0) continue;
      ops.sort((a, b) => (position.get(a.seq) ?? 0) - (position.get(b.seq) ?? 0));
      let results: PushResult[];
      try {
        results = await send(ops);
      } catch (e) {
        const err = toSyncError(e);
        if (!isolatable(err)) throw err;
        await sendIsolated(ops);
        continue;
      }
      await acknowledge(ops, results);
      await yieldToUi(clock, signal);
    }
  }
  return outcome;
}

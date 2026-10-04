/**
 * Outbox helpers for the sync engine: claim operations, apply the server's answer to each of
 * them (docs/contracts/sync.md §4.1), recover after a crash, and manage rejected operations.
 *
 * What an answer does to the device
 *   applied / merged (and duplicate of those)
 *       the op is dropped; `_dirty` is cleared when nothing else is queued for the row.
 *       The row's `version` — and the `base_version` of operations still queued for it — moves
 *       to the acknowledged version only when that version is exactly "our base + 1", i.e.
 *       when no other device wrote in between. After a merge the row keeps its old version
 *       until the pull delivers the merged row, so an edit made in that window is still
 *       compared with the foreign changes by the server instead of overwriting them blindly.
 *   natural-key redirect (`row_id`)
 *       the server applied the insert to an existing row: the local row takes that id (or is
 *       dropped when the canonical row is already here) and queued operations follow it.
 *   conflict
 *       the conflicting fields take the server's values, the row is flagged `_conflict`.
 *   rejected
 *       the op moves to `failed_ops`; the local row keeps the user's data and is flagged
 *       `_failed`. Nothing is reverted silently: the user retries, edits (which re-queues
 *       the work) or discards. A rejected op only keeps the fields no LATER op of the same
 *       row changed (`yieldToLaterOps`): the user's newest value wins after a pull, in what
 *       "retry" re-sends and in what "discard" restores.
 *   restricted rows held in `restricted_local`
 *       deleted from the device as soon as no operation is queued for them any more.
 */
import { completenessScore } from '../lib/completeness';
import { completenessChildren, type StoredProject } from './derive';
import { db, type DeleteSnapshot, type FailedOp, type OutboxOp } from './dexie';
import {
  DbError,
  afterChildChange,
  failedOpsForRow,
  findLocal,
  isInsertOp,
  opsForRow,
  projectIdOf,
  putLocal,
  removeLocalRow,
} from './write';
import { tableDef } from './tables';
import type { PushError, PushOp, PushResult, TableName } from './types';

type AnyRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------------------
// Reading the queue
// ---------------------------------------------------------------------------------------

/** The operation as `sync_push` expects it. */
export function toPushOp(op: OutboxOp): PushOp {
  return {
    op_id: op.op_id,
    table: op.table,
    id: op.row_id,
    kind: op.kind,
    base_version: op.base_version,
    // a delete carries no fields, except the natural key of a blind (restricted) row
    fields: op.fields,
    client_ts: op.created_at,
  };
}

/**
 * Operations waiting to be sent, oldest first (creation order = parents before children).
 * With `userId`, operations queued by another user of this device are left out.
 */
export async function pendingOps(limit?: number, userId?: string | null): Promise<OutboxOp[]> {
  let c = db.outbox.orderBy('seq').filter((o) => o.state === 'pending');
  if (userId !== undefined && userId !== null) {
    c = c.filter((o) => o.user_id === null || o.user_id === userId);
  }
  return limit === undefined ? c.toArray() : c.limit(limit).toArray();
}

export interface QueueCounts {
  /** Operations in the outbox (pending + inflight). */
  pendingOps: number;
  /** Operations parked in `failed_ops`. */
  failedOps: number;
}

export async function queueCounts(): Promise<QueueCounts> {
  const [pending, failed] = await Promise.all([db.outbox.count(), db.failed_ops.count()]);
  return { pendingOps: pending, failedOps: failed };
}

// ---------------------------------------------------------------------------------------
// Claiming and recovering
// ---------------------------------------------------------------------------------------

/**
 * Marks operations as handed to the transport (one transaction) and returns their current
 * content. Operations that vanished meanwhile (coalesced, cancelled) or are already inflight
 * are skipped. From now on `mutate()` never changes them.
 */
export async function markInflight(
  ops: ReadonlyArray<number | Pick<OutboxOp, 'seq'>>,
): Promise<OutboxOp[]> {
  const seqs = ops
    .map((o) => (typeof o === 'number' ? o : o.seq))
    .filter((s): s is number => typeof s === 'number');
  return db.transaction('rw', db.outbox, async () => {
    const claimed: OutboxOp[] = [];
    for (const op of await db.outbox.bulkGet(seqs)) {
      if (!op || op.state !== 'pending') continue;
      op.state = 'inflight';
      op.attempts += 1;
      await db.outbox.put(op);
      claimed.push(op);
    }
    return claimed;
  });
}

/**
 * Puts inflight operations back to pending — after a failed request, and at start-up after
 * a crash. `attempts` stays, so they are sent again unchanged under the same `op_id` (the
 * push is idempotent). Returns how many were requeued.
 */
export async function requeueInflight(seqs?: readonly number[]): Promise<number> {
  return db.transaction('rw', db.outbox, async () => {
    const inflight = await db.outbox.where('state').equals('inflight').toArray();
    const wanted = seqs ? inflight.filter((o) => seqs.includes(o.seq!)) : inflight;
    for (const op of wanted) await db.outbox.update(op.seq!, { state: 'pending' });
    return wanted.length;
  });
}

/**
 * Moves the `base_version` of the operations still queued for a row up to `version`. Call it
 * only when the row is known to contain nothing but this device's own changes up to that
 * version (see the file header).
 */
export async function rebaseQueuedOps(
  table: TableName,
  rowId: string,
  version: number,
): Promise<number> {
  const ops = await opsForRow(table, rowId);
  let n = 0;
  for (const op of ops) {
    if (op.base_version < version) {
      await db.outbox.update(op.seq!, { base_version: version });
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------------------
// ackOp
// ---------------------------------------------------------------------------------------

export interface AckOutcome {
  /** False when the op was not in the outbox any more (answered twice, another tab). */
  handled: boolean;
  /** The status that was acted on (`duplicate` resolved to its original status). */
  status?: Exclude<PushResult['status'], 'duplicate'>;
}

function applyConflictValues(
  row: AnyRecord,
  result: PushResult,
  pendingFields: ReadonlySet<string>,
): string[] {
  const touched: string[] = [];
  const values = result.server_values ?? {};
  for (const field of result.conflict_fields ?? []) {
    if (!(field in values)) continue; // restricted tables: values are never returned
    if (field === 'geom') {
      const point = (values.geom ?? {}) as { lon?: unknown; lat?: unknown };
      if (!pendingFields.has('lon') && !pendingFields.has('lat')) {
        row.lon = point.lon ?? null;
        row.lat = point.lat ?? null;
        touched.push('lon', 'lat');
      }
    } else if (!pendingFields.has(field)) {
      row[field] = values[field];
      touched.push(field);
    }
  }
  return touched;
}

async function refreshDirtyFlags(row: AnyRecord, table: TableName, id: string): Promise<void> {
  const queued = (await opsForRow(table, id)).length;
  const failed = (await failedOpsForRow(table, id)).length;
  if (failed > 0) row._failed = 1;
  else delete row._failed;
  if (queued > 0 || failed > 0) row._dirty = 1;
  else delete row._dirty;
}

// ---------------------------------------------------------------------------------------
// Field ownership: a rejected op vs later ops of the same row
// ---------------------------------------------------------------------------------------

type OpContent = Pick<OutboxOp, 'kind' | 'base_version' | 'fields' | 'before'>;

/**
 * A rejected operation proves that the server stored nothing of it, so its content may still
 * change (sync.md §4.1: the same `op_id` may be sent again). Once a LATER operation of the
 * same row changes a field, the rejected operation no longer owns that field — otherwise a
 * pull would show, "retry" would re-send and "discard" would restore a value older than the
 * user's newest one. Returns what the rejected operation keeps, or `null` when nothing is left.
 *
 *   - update: superseded fields are removed. The later operation recorded the rejected
 *     (never stored) value as its `before`; the rejected operation's `before` — what the
 *     server really has — moves to the first later operation that changes the field, so that
 *     discarding THAT operation also goes back to the server's value.
 *   - insert: it must stay a complete row, so a superseded field takes the newest value (a
 *     cleared one is left out, as when coalescing). An insert whose every field a later
 *     operation carries (a blind write of a restricted row is always complete) is dropped.
 *
 * `later` are the later operations, oldest first. Their `before` is updated in the outbox
 * (a no-op for an operation that is not queued any more).
 */
async function yieldToLaterOps(
  op: OpContent,
  later: readonly OutboxOp[],
): Promise<Pick<OutboxOp, 'fields' | 'before'> | null> {
  const unchanged = { fields: op.fields, before: op.before };
  if (op.kind !== 'upsert') return unchanged;
  const owners = new Map<string, OutboxOp[]>();
  for (const q of later) {
    if (q.kind !== 'upsert') continue;
    for (const k of Object.keys(q.fields)) {
      const list = owners.get(k);
      if (list) list.push(q);
      else owners.set(k, [q]);
    }
  }
  const superseded = Object.keys(op.fields).filter((k) => owners.has(k));
  if (superseded.length === 0) return unchanged;

  const fields = { ...op.fields };
  if (isInsertOp(op)) {
    if (Object.keys(fields).every((k) => owners.has(k))) return null;
    for (const k of superseded) {
      const newest = owners.get(k)!.at(-1)!.fields[k];
      if (newest === null || newest === undefined) delete fields[k];
      else fields[k] = newest;
    }
    return { fields, before: op.before };
  }

  const before = op.before ? { ...op.before } : undefined;
  const handOver = new Map<OutboxOp, AnyRecord>();
  for (const k of superseded) {
    delete fields[k];
    if (!before || !(k in before)) continue;
    const first = owners.get(k)![0]!;
    if (!isInsertOp(first)) {
      const moved = handOver.get(first) ?? { ...(first.before ?? {}) };
      moved[k] = before[k];
      handOver.set(first, moved);
    }
    delete before[k];
  }
  for (const [q, moved] of handOver) {
    if (q.seq !== undefined) await db.outbox.update(q.seq, { before: moved });
  }
  if (Object.keys(fields).length === 0) return null;
  return { fields, before };
}

/**
 * An operation of a row was acknowledged: older rejected operations of the row lose the
 * fields it carried (see `yieldToLaterOps`).
 */
async function yieldOlderFailedOps(op: OutboxOp): Promise<void> {
  if (op.kind !== 'upsert') return;
  const older = (await failedOpsForRow(op.table, op.row_id)).filter((f) => f.seq < (op.seq ?? 0));
  for (const f of older) {
    const kept = await yieldToLaterOps(f, [op]);
    if (!kept) await db.failed_ops.delete(f.id!);
    else if (kept.fields !== f.fields)
      await db.failed_ops.update(f.id!, { fields: kept.fields, before: kept.before });
  }
}

async function parkAsFailed(op: OutboxOp, error: PushError | undefined): Promise<void> {
  const { seq, state: _state, ...rest } = op;
  // Edits made while the op was on the wire are queued behind it and own their fields.
  const later = (await opsForRow(op.table, op.row_id)).filter((q) => (q.seq ?? 0) > (seq ?? 0));
  const kept = await yieldToLaterOps(op, later);
  if (kept) {
    const failed: FailedOp = {
      ...rest,
      fields: kept.fields,
      seq: seq ?? 0,
      error: error ?? { code: 'unknown' },
      failed_at: Date.now(),
    };
    if (kept.before) failed.before = kept.before;
    else delete failed.before;
    await db.failed_ops.add(failed);
  }
  const hit = await findLocal(op.table, op.row_id);
  if (hit) {
    await refreshDirtyFlags(hit.row, op.table, op.row_id);
    await putLocal(op.table, hit.row, hit.where, op.project_id);
  }
}

/** Children rejected only because their parent was missing get another chance once it exists. */
async function requeueOrphans(parentTable: TableName, parentId: string): Promise<void> {
  const candidates = await db.failed_ops
    .filter((f) => f.error.code === 'parent_missing' || f.error.code === 'parent_required')
    .toArray();
  const mine = candidates.filter(
    (f) =>
      (parentTable === 'projects' && f.project_id === parentId) ||
      Object.entries(tableDef(f.table).refs).some(
        ([col, t]) => t === parentTable && f.fields[col] === parentId,
      ),
  );
  if (mine.length > 0) await requeueFailed(mine);
}

/**
 * Applies one result of `sync_push` to the device, atomically. Accepts `(result)` or
 * `(op, result)`; the operation is always looked up by `result.op_id`. An op that is no
 * longer in the outbox is ignored.
 */
export async function ackOp(result: PushResult): Promise<AckOutcome>;
export async function ackOp(
  op: { op_id: string } | null | undefined,
  result: PushResult,
): Promise<AckOutcome>;
export async function ackOp(
  a: PushResult | { op_id: string } | null | undefined,
  b?: PushResult,
): Promise<AckOutcome> {
  const result = (b ?? a) as PushResult;
  return db.transaction('rw', db.tables, async () => {
    const op = await db.outbox.where('op_id').equals(result.op_id).first();
    if (!op) return { handled: false };
    await db.outbox.delete(op.seq!);

    if (result.status === 'rejected') {
      await parkAsFailed(op, result.error);
      return { handled: true, status: 'rejected' };
    }
    const status =
      result.status === 'duplicate' ? (result.original_status ?? 'applied') : result.status;
    const table = op.table;
    const version = typeof result.version === 'number' ? result.version : undefined;
    // The server has this op's values now: an older rejected op must not bring back its own.
    await yieldOlderFailedOps(op);

    if (op.kind === 'delete') {
      // The row left the device when the user deleted it; nothing to restore any more.
      return { handled: true, status };
    }

    const rowId = op.row_id;
    const hit = await findLocal(table, rowId);
    let remaining = await opsForRow(table, rowId);

    // Natural key: the server applied the insert to its existing row.
    if (result.row_id && result.row_id !== rowId) {
      const canonical = result.row_id;
      for (const q of remaining) {
        await db.outbox.update(q.seq!, {
          row_id: canonical,
          base_version: version ?? q.base_version,
          // a redirected insert is an update of the canonical row: never resend created_at
          fields: Object.fromEntries(Object.entries(q.fields).filter(([k]) => k !== 'created_at')),
        });
      }
      for (const f of await failedOpsForRow(table, rowId))
        await db.failed_ops.update(f.id!, { row_id: canonical });
      if (hit) {
        if (hit.where === 'restricted_local') await db.restricted_local.delete(rowId);
        else await db.table(table).delete(rowId);
        const canonicalHere = await findLocal(table, canonical);
        const keep = hit.where === 'restricted_local' ? remaining.length > 0 : !canonicalHere;
        if (keep) {
          const moved: AnyRecord = { ...hit.row, id: canonical };
          if (version !== undefined) moved.version = version;
          await refreshDirtyFlags(moved, table, canonical);
          await putLocal(table, moved, hit.where, op.project_id);
        } else if (canonicalHere && canonicalHere.where === 'store' && remaining.length > 0) {
          // The canonical row is already here: the edits still queued for it show on top.
          const merged: AnyRecord = { ...canonicalHere.row };
          for (const q of remaining) {
            for (const [k, v] of Object.entries(q.fields)) if (k !== 'created_at') merged[k] = v;
          }
          await refreshDirtyFlags(merged, table, canonical);
          await putLocal(table, merged, 'store', op.project_id);
        }
      }
      await afterChildChange(table, op.project_id);
      return { handled: true, status };
    }

    // Restricted rows on a device without restricted capability: purge once acknowledged.
    if (hit?.where === 'restricted_local') {
      if (remaining.length === 0 && (await failedOpsForRow(table, rowId)).length === 0) {
        await db.restricted_local.delete(rowId);
      }
      return { handled: true, status };
    }

    if (!hit) return { handled: true, status };
    const row = hit.row;
    const localVersion = typeof row.version === 'number' ? row.version : 0;

    // "Pure" acknowledgement: the new version is exactly ours on top of the base we edited.
    const pure = status === 'applied' && version !== undefined && version === op.base_version + 1;
    if (pure && version !== undefined) {
      if (version > localVersion) row.version = version;
      await rebaseQueuedOps(table, rowId, version);
      remaining = await opsForRow(table, rowId);
    }

    if (status === 'conflict') {
      const pendingFields = new Set(remaining.flatMap((q) => Object.keys(q.fields)));
      const touched = applyConflictValues(row, result, pendingFields);
      row._conflict = 1;
      row._conflict_fields = result.conflict_fields ?? touched;
      row._conflict_version = version ?? localVersion;
    }

    await refreshDirtyFlags(row, table, rowId);
    if (table === 'projects' && row._dirty !== 1) {
      // Nothing local is outstanding: until the pull brings the server's number, show the estimate.
      const p = row as unknown as StoredProject;
      p._cmp = completenessScore(p, await completenessChildren(rowId));
    }
    await putLocal(table, row, hit.where, op.project_id);

    if (isInsertOp(op)) await requeueOrphans(table, rowId);
    return { handled: true, status };
  });
}

// ---------------------------------------------------------------------------------------
// Rejected operations ("needs attention")
// ---------------------------------------------------------------------------------------

export function listFailedOps(): Promise<FailedOp[]> {
  return db.failed_ops.orderBy(':id').toArray();
}

async function requeueFailed(failed: FailedOp[]): Promise<void> {
  const ordered = failed.slice().sort((x, y) => x.seq - y.seq);
  const requeued = new Set<number>();
  for (const f of ordered) {
    const { id, error: _error, failed_at: _failedAt, seq: _seq, ...rest } = f;
    await db.failed_ops.delete(id!);
    // Same op_id: the server stored nothing for a rejected operation. It goes to the end of
    // the queue, so it must not carry a field that an edit queued after it changed.
    const later = (await opsForRow(f.table, f.row_id)).filter(
      (q) => (q.seq ?? 0) > f.seq && !requeued.has(q.seq ?? 0),
    );
    const kept = await yieldToLaterOps(f, later);
    if (kept) {
      const op: OutboxOp = { ...rest, fields: kept.fields, state: 'pending' };
      if (kept.before) op.before = kept.before;
      else delete op.before;
      requeued.add(await db.outbox.add(op));
    }
    const hit = await findLocal(f.table, f.row_id);
    if (hit) {
      await refreshDirtyFlags(hit.row, f.table, f.row_id);
      await putLocal(f.table, hit.row, hit.where, f.project_id);
    }
  }
}

/**
 * Queues rejected operations again under their `op_id`, in their original order (e.g. after
 * the cause was fixed on the server, or a missing parent now exists) — with their content
 * minus the fields a later edit of the row owns (`yieldToLaterOps`). Without `ids`: all.
 * Returns how many were handled.
 */
export async function retryFailedOps(ids?: readonly number[]): Promise<number> {
  return db.transaction('rw', db.tables, async () => {
    const all = ids
      ? (await db.failed_ops.bulkGet([...ids])).filter((f): f is FailedOp => !!f)
      : await listFailedOps();
    await requeueFailed(all);
    return all.length;
  });
}

async function restoreSnapshot(
  table: TableName,
  snapshot: DeleteSnapshot,
  projectId: string | null,
): Promise<void> {
  const rowId = String(snapshot.row.id);
  if (!(await findLocal(table, rowId)) && Object.keys(snapshot.row).length > 1) {
    await putLocal(table, { ...snapshot.row }, 'store', projectId);
  }
  for (const [childTable, rows] of Object.entries(snapshot.children ?? {})) {
    for (const r of rows ?? []) {
      const t = childTable as TableName;
      if (!(await findLocal(t, String(r.id)))) await putLocal(t, { ...r }, 'store', projectId);
    }
  }
  for (const rec of snapshot.restricted ?? []) {
    if (!(await db.restricted_local.get(rec.id))) await db.restricted_local.put(rec);
  }
}

/**
 * The user gives up a rejected operation. The device goes back to what the server has:
 *   - rejected insert  → the local row is removed (with what hangs below it);
 *   - rejected update  → the changed fields take their previous values again, unless a newer
 *                        queued edit owns them;
 *   - rejected delete  → the removed rows are restored.
 */
export async function discardFailedOp(id: number): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    const f = await db.failed_ops.get(id);
    if (!f) throw new DbError('op_not_found', String(id));
    await db.failed_ops.delete(id);

    if (f.kind === 'delete') {
      if (f.snapshot) await restoreSnapshot(f.table, f.snapshot, f.project_id);
      const hit = await findLocal(f.table, f.row_id);
      if (hit) {
        await refreshDirtyFlags(hit.row, f.table, f.row_id);
        await putLocal(f.table, hit.row, hit.where, f.project_id);
      }
      await afterChildChange(f.table, f.project_id);
      return;
    }

    const hit = await findLocal(f.table, f.row_id);
    if (!hit) return;
    const queued = await opsForRow(f.table, f.row_id);
    const otherFailed = await failedOpsForRow(f.table, f.row_id);
    const version = typeof hit.row.version === 'number' ? hit.row.version : 0;

    if (isInsertOp(f) && version === 0 && queued.length === 0 && otherFailed.length === 0) {
      // The server never got the row: nothing to go back to.
      await removeLocalRow(f.table, f.row_id);
      await afterChildChange(f.table, f.project_id);
      return;
    }
    const owned = new Set([...queued, ...otherFailed].flatMap((o) => Object.keys(o.fields)));
    for (const [field, previous] of Object.entries(f.before ?? {})) {
      if (!owned.has(field)) hit.row[field] = previous;
    }
    await refreshDirtyFlags(hit.row, f.table, f.row_id);
    const projectId = await projectIdOf(f.table, hit.row);
    if (f.table === 'projects') {
      const p = hit.row as unknown as StoredProject;
      p._cmp =
        hit.row._dirty === 1
          ? completenessScore(p, await completenessChildren(f.row_id))
          : (p.completeness ?? 0);
    }
    await putLocal(f.table, hit.row, hit.where, projectId);
    await afterChildChange(f.table, projectId);
  });
}

/** Removes the `_conflict` flag of a row (e.g. after the reviewer's decision was seen). */
export async function clearConflictFlag(table: TableName, id: string): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    const hit = await findLocal(table, id);
    if (!hit || hit.row._conflict !== 1) return;
    delete hit.row._conflict;
    delete hit.row._conflict_fields;
    delete hit.row._conflict_version;
    await putLocal(table, hit.row, hit.where, await projectIdOf(table, hit.row));
  });
}

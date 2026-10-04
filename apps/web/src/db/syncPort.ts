/**
 * The local database as the sync engine sees it: one object with exactly the operations the
 * engine needs (claim / acknowledge operations, apply pulled pages, meta, photo blobs).
 * Structurally compatible with `DbPort` of `src/sync/ports.ts` (checked in
 * `syncPort.test.ts`); `src/db` itself does not import anything from `src/sync`.
 */
import { liveQuery } from 'dexie';
import {
  ackOp,
  markInflight,
  pendingOps,
  queueCounts,
  requeueInflight,
  type QueueCounts,
} from './ack';
import { applyPage, resetScopedData, wipeAllLocalData, type PullPageInput } from './apply';
import { dropPhotoBlob, photoBlob } from './blobs';
import { publicRow } from './bundle';
import { db, type OutboxOp, type PhotoBlobKind } from './dexie';
import { deleteMeta, getMeta, listMeta, setMeta, updateMeta } from './meta';
import { SYNC_TABLES, isTableName } from './tables';
import type { PushKind, PushResult, Row, TableName } from './types';
import { DbError, findLocal, mutate } from './write';

/** A queued operation with the field names of the wire format (`id`, `client_ts`). */
export interface SyncOp {
  seq: number;
  op_id: string;
  table: string;
  id: string;
  kind: PushKind;
  base_version: number;
  fields: Record<string, unknown>;
  client_ts: string;
  attempts: number;
}

const toSyncOp = (op: OutboxOp): SyncOp => ({
  seq: op.seq ?? 0,
  op_id: op.op_id,
  table: op.table,
  id: op.row_id,
  kind: op.kind,
  base_version: op.base_version,
  fields: op.kind === 'delete' ? {} : op.fields,
  client_ts: op.created_at,
  attempts: op.attempts,
});

/**
 * Calls `listener` whenever the outbox, the rejected operations or `meta` change — in this
 * tab or another one. Returns the unsubscribe function.
 */
export function watchQueues(listener: () => void): () => void {
  let first = true;
  const subscription = liveQuery(async () => {
    // Values, not counts: Dexie re-runs key-only queries only when keys come and go.
    const [outbox, failed, meta] = await Promise.all([
      db.outbox.toArray(),
      db.failed_ops.count(),
      db.meta.toArray(),
    ]);
    return outbox.length + failed + meta.length;
  }).subscribe({
    next: () => {
      if (first) {
        first = false;
        return;
      }
      listener();
    },
    error: () => {
      /* the database was closed (wipe, version change): nothing to report */
    },
  });
  return () => subscription.unsubscribe();
}

export const syncPort = {
  /** Registry order = parents before children. */
  tables: SYNC_TABLES as ReadonlyArray<{ name: string; restricted?: boolean }>,

  async pendingOps(): Promise<SyncOp[]> {
    return (await pendingOps()).map(toSyncOp);
  },

  async markInflight(seqs: readonly number[]): Promise<SyncOp[]> {
    return (await markInflight(seqs)).map(toSyncOp);
  },

  requeueInflight(seqs?: readonly number[]): Promise<number> {
    return requeueInflight(seqs);
  },

  async ackOp(op: { op_id: string }, result: PushResult): Promise<void> {
    await ackOp(op, result);
  },

  counts(): Promise<QueueCounts> {
    return queueCounts();
  },

  watch: watchQueues,

  async applyPage(page: PullPageInput): Promise<void> {
    await applyPage(page);
  },

  async resetScopedData(): Promise<void> {
    await resetScopedData();
  },

  wipeAll(): Promise<void> {
    return wipeAllLocalData();
  },

  getMeta,
  setMeta,
  deleteMeta,
  listMeta,
  updateMeta,

  /** The local copy of a row (restricted rows held in `restricted_local` included). */
  async getRow(table: string, id: string): Promise<Record<string, unknown> | undefined> {
    if (!isTableName(table)) return undefined;
    const hit = await findLocal(table, id);
    return hit ? publicRow(hit.row) : undefined;
  },

  async mutate(table: string, id: string, patch: Record<string, unknown>): Promise<void> {
    if (!isTableName(table)) throw new DbError('table_not_writable', table);
    await mutate(table, id, patch as Partial<Row<TableName>>);
  },

  photoBlob(photoId: string, kind: PhotoBlobKind): Promise<Blob | undefined> {
    return photoBlob(photoId, kind);
  },

  dropPhotoBlob(photoId: string, kind: PhotoBlobKind): Promise<void> {
    return dropPhotoBlob(photoId, kind);
  },
};

export type SyncPort = typeof syncPort;

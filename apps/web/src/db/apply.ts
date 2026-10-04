/**
 * The read path used by pull: writing server rows into the local stores
 * (docs/contracts/sync.md §5, §7.8–7.11).
 *
 *  - a tombstone (`deleted_at` set) or a `gone` id removes the local row; for a project all
 *    its children go with it;
 *  - a server row for an id that has queued (or rejected, unresolved) local operations is
 *    stored as "server row + the local fields on top" and stays `_dirty`;
 *  - a row the user deleted locally and that is not pushed yet is never resurrected — the
 *    fresh server row only replaces the copy kept for a possible undo;
 *  - applying the same rows twice is harmless.
 */
import {
  decorateMany,
  invalidateDeriveCaches,
  refreshLocalityProjects,
  refreshProjects,
  type StoredProject,
} from './derive';
import { db, type FailedOp, type OutboxOp } from './dexie';
import { resetMetaCaches } from './meta';
import { COMPLETENESS_CHILD_TABLES, SYNC_TABLES, isTableName, tableDef } from './tables';
import type { PullChange, RestrictedTableName, Row, TableName } from './types';
import { findLocal, putLocal, removeLocalRow } from './write';

type AnyRecord = Record<string, unknown>;

export interface ApplyStats {
  /** Rows written (inserted or replaced). */
  upserted: number;
  /** Rows removed by tombstones or `gone`. */
  removed: number;
  /** Server rows not stored because the user deleted the row locally. */
  skipped: number;
}

/** Rows per transaction when a caller hands over more than one page at once. */
const CHUNK = 500;

type QueuedLike = Pick<OutboxOp, 'kind' | 'fields' | 'snapshot'> & {
  seq?: number;
  failedId?: number;
};

async function operationsByRow(
  table: TableName,
  ids: string[],
): Promise<Map<string, QueuedLike[]>> {
  const map = new Map<string, QueuedLike[]>();
  if (ids.length === 0) return map;
  const [queued, failed] = await Promise.all([db.outbox.count(), db.failed_ops.count()]);
  if (queued === 0 && failed === 0) return map;
  const keys = ids.map((id) => [table, id]);
  const add = (rowId: string, op: QueuedLike): void => {
    const list = map.get(rowId);
    if (list) list.push(op);
    else map.set(rowId, [op]);
  };
  if (queued > 0) {
    const ops: OutboxOp[] = await db.outbox.where('[table+row_id]').anyOf(keys).toArray();
    for (const op of ops) add(op.row_id, op);
  }
  if (failed > 0) {
    const ops: FailedOp[] = await db.failed_ops.where('[table+row_id]').anyOf(keys).toArray();
    for (const op of ops)
      add(op.row_id, {
        kind: op.kind,
        fields: op.fields,
        snapshot: op.snapshot,
        seq: op.seq,
        failedId: op.id,
      });
  }
  for (const list of map.values()) list.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return map;
}

/** Projects that have any queued or rejected work (their completeness is estimated locally). */
async function busyProjectIds(): Promise<Set<string>> {
  const [a, b] = await Promise.all([
    db.outbox.orderBy('project_id').uniqueKeys(),
    db.failed_ops.orderBy('project_id').uniqueKeys(),
  ]);
  const out = new Set<string>();
  for (const k of [...a, ...b]) if (typeof k === 'string') out.add(k);
  return out;
}

async function applyChunk(
  table: TableName,
  rows: ReadonlyArray<AnyRecord>,
  gone: readonly string[],
  stats: ApplyStats,
): Promise<void> {
  const def = tableDef(table);
  const store = db.table(table);
  const liveIds: string[] = [];
  for (const r of rows) {
    if (r.deleted_at === null || r.deleted_at === undefined) liveIds.push(String(r.id));
  }

  const opsByRow = await operationsByRow(table, liveIds);
  const isProjects = table === 'projects';
  const isLocalities = table === 'localities';
  const isChild = def.scopeCol === 'project_id';
  const busy = isProjects || isChild ? await busyProjectIds() : new Set<string>();

  // Existing copies are needed for projects (child-derived state), localities (a rename
  // changes the search tokens of their projects) and for conflict flags.
  const existing = new Map<string, AnyRecord>();
  if (liveIds.length > 0) {
    let wanted: string[] = [];
    if (isProjects || isLocalities) wanted = liveIds;
    else {
      const flagged = new Set((await store.where('_conflict').equals(1).primaryKeys()) as string[]);
      if (flagged.size > 0) wanted = liveIds.filter((id) => flagged.has(id));
    }
    if (wanted.length > 0) {
      const found = (await store.bulkGet(wanted)) as Array<AnyRecord | undefined>;
      for (const r of found) if (r) existing.set(String(r.id), r);
    }
  }

  const toPut: AnyRecord[] = [];
  const doomed: string[] = [];
  const estimate = new Set<string>(); // projects whose completeness must be estimated locally
  const newProjects: string[] = [];
  const touchedProjects = new Set<string>();
  const renamedLocalities: string[] = [];

  for (const incoming of rows) {
    const id = String(incoming.id);
    if (incoming.deleted_at !== null && incoming.deleted_at !== undefined) {
      doomed.push(id);
      continue;
    }
    const ops = opsByRow.get(id) ?? [];
    const del = ops.find((o) => o.kind === 'delete');
    if (del) {
      // Deleted on this device, not pushed (or rejected and unresolved): keep it deleted,
      // but remember the newest server copy for a possible undo.
      const snapshot = { ...(del.snapshot ?? {}), row: { ...incoming } };
      if (del.failedId !== undefined) await db.failed_ops.update(del.failedId, { snapshot });
      else if (del.seq !== undefined) await db.outbox.update(del.seq, { snapshot });
      stats.skipped++;
      continue;
    }

    const row: AnyRecord = { ...incoming };
    const upserts = ops.filter((o) => o.kind === 'upsert');
    if (upserts.length > 0) {
      for (const op of upserts) {
        for (const [k, v] of Object.entries(op.fields)) {
          if (k !== 'created_at') row[k] = v;
        }
      }
      row._dirty = 1;
      if (upserts.some((o) => o.failedId !== undefined)) row._failed = 1;
    }

    const prev = existing.get(id);
    if (prev && prev._conflict === 1) {
      const at = typeof prev._conflict_version === 'number' ? prev._conflict_version : 0;
      if (!(typeof row.version === 'number' && row.version > at)) {
        row._conflict = 1;
        row._conflict_fields = prev._conflict_fields;
        row._conflict_version = prev._conflict_version;
      }
    }

    if (isProjects) {
      const p = row as unknown as StoredProject;
      const before = prev as unknown as StoredProject | undefined;
      if (before) {
        if (before._om === 1) p._om = 1;
        p._cover = before._cover ?? null;
        p._cover_thumb = before._cover_thumb ?? null;
        if (p._dirty === 1 && typeof before._u === 'number') p._u = before._u;
      } else {
        newProjects.push(id);
      }
      if (p._dirty === 1 || busy.has(id)) estimate.add(id);
    } else if (isChild && typeof row.project_id === 'string') {
      touchedProjects.add(row.project_id);
    } else if (
      isLocalities &&
      (!prev || prev.name_ar !== row.name_ar || prev.name_latin !== row.name_latin)
    ) {
      renamedLocalities.push(id);
    }
    toPut.push(row);
  }

  await decorateMany(table, toPut as unknown as Array<Row<TableName>>);
  if (toPut.length > 0) await store.bulkPut(toPut);
  stats.upserted += toPut.length;

  for (const id of [...doomed, ...gone]) {
    const removed = await removeLocalRow(table, id);
    if (!removed) continue;
    stats.removed++;
    const pid = removed.row.project_id;
    if (isChild && typeof pid === 'string') touchedProjects.add(pid);
  }

  if (table === 'admin_areas' || table === 'localities') invalidateDeriveCaches(table);
  // Projects already on the device show the new locality names in their search tokens. (A
  // first sync pulls localities before any project: the lookup finds nothing.)
  if (renamedLocalities.length > 0) await refreshLocalityProjects(renamedLocalities);

  // --- project state that depends on children ------------------------------------------
  if (isProjects) {
    if (newProjects.length > 0) {
      // Children normally arrive after their project; look for earlier ones only when there
      // can be any (never during a first sync, where the child stores are still empty).
      const [photos, maintenance] = await Promise.all([
        db.project_photos.count(),
        db.project_maintenance.count(),
      ]);
      if (photos > 0 || maintenance > 0) {
        await refreshProjects(newProjects, { maintenance: maintenance > 0, cover: photos > 0 });
      }
    }
    if (estimate.size > 0) await refreshProjects(estimate, { completeness: true });
  } else if (touchedProjects.size > 0) {
    const counts = (COMPLETENESS_CHILD_TABLES as readonly TableName[]).includes(table);
    const dirtyParents = counts ? [...touchedProjects].filter((id) => busy.has(id)) : [];
    if (table === 'project_maintenance')
      await refreshProjects(touchedProjects, { maintenance: true });
    else if (table === 'project_photos') await refreshProjects(touchedProjects, { cover: true });
    if (dirtyParents.length > 0) await refreshProjects(dirtyParents, { completeness: true });
  }

  // A reviewer's decision arrived: the flag on the row it was about can go.
  if (table === 'sync_conflicts') {
    for (const c of toPut) {
      if (c.state === 'open' || !isTableName(c.table_name) || typeof c.row_id !== 'string')
        continue;
      const stillOpen = await db.sync_conflicts
        .where('[table_name+row_id]')
        .equals([c.table_name, c.row_id])
        .filter((x) => x.state === 'open')
        .count();
      if (stillOpen > 0) continue;
      const hit = await findLocal(c.table_name, c.row_id);
      if (hit && hit.row._conflict === 1) {
        delete hit.row._conflict;
        delete hit.row._conflict_fields;
        delete hit.row._conflict_version;
        await putLocal(c.table_name, hit.row, hit.where, null);
      }
    }
  }
}

/**
 * Writes pulled rows of one table. `rows` are full server rows (tombstones included),
 * `gone` are ids that left the caller's scope. Runs in its own transaction(s) of at most
 * 500 rows, or inside the caller's transaction when there is one.
 */
export async function applyServerRows<T extends TableName>(
  table: T,
  rows: ReadonlyArray<Row<T>>,
  gone: readonly string[] = [],
): Promise<ApplyStats> {
  const stats: ApplyStats = { upserted: 0, removed: 0, skipped: 0 };
  const all = rows as unknown as ReadonlyArray<AnyRecord>;
  if (all.length === 0 && gone.length === 0) return stats;
  for (let i = 0; i === 0 || i < all.length; i += CHUNK) {
    const chunk = all.slice(i, i + CHUNK);
    const goneNow = i === 0 ? gone : [];
    // The scope must be an `async` function: Dexie only keeps the transaction alive across
    // native awaits it can see (a plain arrow returning the promise commits too early).
    await db.transaction('rw', db.tables, async () => {
      await applyChunk(table, chunk, goneNow, stats);
    });
  }
  return stats;
}

export interface PullPageInput {
  changes: ReadonlyArray<
    PullChange | { table: string; rows?: Array<Record<string, unknown>>; gone?: string[] }
  >;
  /** Meta entries (the pull cursor, the scope epoch) stored in the SAME transaction as the rows. */
  meta?: ReadonlyArray<{ key: string; value: unknown }>;
}

/**
 * Writes one `sync_pull` page and its meta entries atomically, tables in the order given
 * (the server sends parents first). A crash can never leave a cursor that is ahead of the
 * stored rows. Unknown tables are ignored (a newer server).
 */
export async function applyPage(page: PullPageInput): Promise<ApplyStats> {
  const stats: ApplyStats = { upserted: 0, removed: 0, skipped: 0 };
  await db.transaction('rw', db.tables, async () => {
    for (const change of page.changes) {
      if (!isTableName(change.table)) continue;
      await applyChunk(
        change.table,
        (change.rows ?? []) as ReadonlyArray<AnyRecord>,
        change.gone ?? [],
        stats,
      );
    }
    for (const entry of page.meta ?? []) await db.meta.put({ key: entry.key, value: entry.value });
  });
  return stats;
}

// ---------------------------------------------------------------------------------------
// Scope reset and wipe
// ---------------------------------------------------------------------------------------

export interface ResetSummary {
  /** Rows with unsent work that stayed on the device. */
  keptDirtyRows: number;
  /** Restricted rows with unsent work that were moved to `restricted_local`. */
  movedRestricted: number;
  /** Operations still queued. */
  keptOps: number;
  /** Rejected operations still waiting for the user. */
  keptFailedOps: number;
}

/**
 * Discards the synced copy of the server data (scope_epoch changed, `reset: true`, another
 * user signed in) so that the next pull starts from scratch.
 *
 * What happens to work that is not on the server yet — nothing of it is lost:
 *   - `outbox` and `failed_ops` are untouched: every queued operation is still pushed (or
 *     stays under "needs attention"). An operation the new scope no longer allows comes back
 *     `rejected/out_of_scope` and lands in `failed_ops`, where the user can see it.
 *   - Rows that carry unsent work (`_dirty`: created or edited here, or with a rejected
 *     operation) stay in their stores exactly as the user left them, so the work remains
 *     visible and editable. When the fresh pull delivers the server row it is merged under
 *     the pending fields as usual.
 *   - Rows deleted locally stay deleted (their copy lives inside the delete operation).
 *   - Dirty rows of restricted tables are moved to `restricted_local`, where the collector
 *     rule applies (purged once acknowledged), whatever the new capabilities are.
 *   - `drafts`, `photo_blobs` (photos not uploaded yet AND cached thumbnails), `meta`,
 *     `restricted_local` and `packs` are kept. Thumbnails of rows that do not come back can
 *     be freed later with `pruneOrphanPhotoBlobs()`.
 * Everything else in the synced stores is removed. Pull cursors live in `meta` and belong
 * to the sync engine, which clears them together with this call.
 */
export async function resetScopedData(): Promise<ResetSummary> {
  const summary: ResetSummary = {
    keptDirtyRows: 0,
    movedRestricted: 0,
    keptOps: 0,
    keptFailedOps: 0,
  };
  await db.transaction('rw', db.tables, async () => {
    for (const def of SYNC_TABLES) {
      const store = db.table(def.name);
      const dirty = (await store.where('_dirty').equals(1).toArray()) as AnyRecord[];
      await store.clear();
      if (dirty.length === 0) continue;
      if (def.restricted) {
        for (const row of dirty) {
          let projectId: string | null = typeof row.project_id === 'string' ? row.project_id : null;
          if (!projectId && typeof row.project_staff_id === 'string') {
            const queued = await db.outbox
              .where('[table+row_id]')
              .equals([def.name, String(row.id)])
              .first();
            projectId = queued?.project_id ?? null;
          }
          await db.restricted_local.put({
            id: String(row.id),
            table: def.name as RestrictedTableName,
            parent_id: String(row[def.scopeCol ?? 'project_id'] ?? ''),
            project_id: projectId,
            row: row as unknown as Row<RestrictedTableName>,
            updated_at: Date.now(),
          });
        }
        summary.movedRestricted += dirty.length;
      } else {
        await store.bulkPut(dirty);
        summary.keptDirtyRows += dirty.length;
      }
    }
    summary.keptOps = await db.outbox.count();
    summary.keptFailedOps = await db.failed_ops.count();
  });
  invalidateDeriveCaches();
  return summary;
}

/**
 * Removes EVERYTHING from the device: synced rows, queues, drafts, photos, meta, packs.
 * For a revoked session or device (sync.md §7.11) — unsent work is lost on purpose there.
 */
export async function wipeAllLocalData(): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
  invalidateDeriveCaches();
  resetMetaCaches();
}

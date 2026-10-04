/**
 * The write path. `mutate()` is THE write primitive of the app: one transaction that
 *   (a) writes the optimistic local row (`_dirty: 1`), never touching server-managed columns,
 *   (b) appends an outbox operation or coalesces into the row's pending one
 *       (docs/contracts/sync.md §7 "client obligations"),
 *   (c) keeps search tokens and the other derived index fields current.
 *
 * Coalescing rules
 *   - an insert followed by updates is ONE insert carrying the final values;
 *   - updates of a synced row are ONE update: union of the fields, earliest `base_version`;
 *   - an operation that was ever handed to the transport (`attempts > 0`) is frozen — the
 *     server may have applied it under its `op_id` — so later edits get a new operation;
 *   - two `record_state` transitions of a synced project are never folded into one;
 *   - an edit that points to a row created later in the queue (e.g. a new locality) gets its
 *     own operation behind that row, so a parent always precedes its children;
 *   - deleting a row the server never saw removes its queued operations instead of adding one.
 */
import { completenessScore } from '../lib/completeness';
import { isValidLonLat } from '../lib/geo';
import { uuidv7 } from '../lib/uuidv7';
import {
  completenessChildren,
  decorate,
  invalidateDeriveCaches,
  refreshProjects,
  type StoredProject,
} from './derive';
import { db, type DeleteSnapshot, type FailedOp, type OutboxOp, type RestrictedLocalRecord } from './dexie';
import { getLocalSession, type LocalSession } from './meta';
import {
  COMPLETENESS_CHILD_TABLES,
  PROJECT_CHILD_TABLES,
  canPush,
  tableDef,
  writableColumns,
  type SyncTableDef,
} from './tables';
import type { RestrictedTableName, Row, TableName } from './types';

export type DbErrorCode =
  | 'row_not_found'
  | 'table_not_writable'
  | 'immutable_field'
  | 'invalid_coordinates'
  | 'op_not_found';

export class DbError extends Error {
  constructor(
    readonly code: DbErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'DbError';
  }
}

type AnyRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------------------
// Small helpers shared with ack.ts / apply.ts
// ---------------------------------------------------------------------------------------

/** Queued operations of a row, oldest first. */
export function opsForRow(table: TableName, id: string): Promise<OutboxOp[]> {
  return db.outbox.where('[table+row_id]').equals([table, id]).sortBy('seq');
}

/** Rejected operations of a row, in their original order. */
export function failedOpsForRow(table: TableName, id: string): Promise<FailedOp[]> {
  return db.failed_ops.where('[table+row_id]').equals([table, id]).sortBy('seq');
}

/** An insert carries `created_at` (sync.md §7.5); updates never do. */
export function isInsertOp(op: Pick<OutboxOp, 'kind' | 'fields' | 'base_version'>): boolean {
  return op.kind === 'upsert' && op.base_version === 0 && 'created_at' in op.fields;
}

export interface LocalHit {
  row: AnyRecord;
  /** Where the row lives: its own store, or `restricted_local`. */
  where: 'store' | 'restricted_local';
}

/** The local copy of a row, wherever it lives. */
export async function findLocal(table: TableName, id: string): Promise<LocalHit | undefined> {
  if (tableDef(table).restricted) {
    const rec = await db.restricted_local.get(id);
    if (rec && rec.table === table) return { row: rec.row as unknown as AnyRecord, where: 'restricted_local' };
  }
  const row = (await db.table(table).get(id)) as AnyRecord | undefined;
  return row ? { row, where: 'store' } : undefined;
}

export async function projectIdOf(table: TableName, row: AnyRecord): Promise<string | null> {
  if (table === 'projects') return typeof row.id === 'string' ? row.id : null;
  if (typeof row.project_id === 'string') return row.project_id;
  if (table === 'staff_compensation' && typeof row.project_staff_id === 'string') {
    const staff = await db.project_staff.get(row.project_staff_id);
    return staff?.project_id ?? null;
  }
  return null;
}

/** Writes a row to its store (derived fields refreshed) or to `restricted_local`. */
export async function putLocal(
  table: TableName,
  row: AnyRecord,
  where: LocalHit['where'],
  projectId: string | null,
): Promise<void> {
  if (where === 'restricted_local') {
    const def = tableDef(table);
    const rec: RestrictedLocalRecord = {
      id: String(row.id),
      table: table as RestrictedTableName,
      parent_id: String(row[def.scopeCol ?? 'project_id'] ?? ''),
      project_id: projectId,
      row: row as unknown as Row<RestrictedTableName>,
      updated_at: Date.now(),
    };
    await db.restricted_local.put(rec);
    return;
  }
  await db.table(table).put(await decorate(table, row as unknown as Row<TableName>));
}

/** Recomputes what a project shows about its children after one of them changed. */
export async function afterChildChange(table: TableName, projectId: string | null): Promise<void> {
  if (table === 'admin_areas' || table === 'localities') invalidateDeriveCaches(table);
  if (!projectId || table === 'projects') return;
  if (table === 'project_maintenance') {
    await refreshProjects([projectId], { maintenance: true });
  } else if ((COMPLETENESS_CHILD_TABLES as readonly TableName[]).includes(table)) {
    await refreshProjects([projectId], { completeness: true, cover: table === 'project_photos' });
  }
}

/**
 * Removes a row from the device together with what hangs below it, and returns what was
 * removed. Queued operations are NOT touched here.
 *   projects       → every child row, restricted rows of the project
 *   project_staff  → its compensation rows
 *   project_photos → its stored blobs
 */
export async function removeLocalRow(table: TableName, id: string): Promise<DeleteSnapshot | undefined> {
  const hit = await findLocal(table, id);
  const snapshot: DeleteSnapshot = { row: hit?.row ?? { id } };
  const children: NonNullable<DeleteSnapshot['children']> = {};
  const restricted: RestrictedLocalRecord[] = [];

  const dropStaffChildren = async (staffIds: string[]): Promise<void> => {
    if (staffIds.length === 0) return;
    const comp = await db.staff_compensation.where('project_staff_id').anyOf(staffIds).toArray();
    if (comp.length > 0) {
      (children.staff_compensation ??= []).push(...(comp as unknown as AnyRecord[]));
      await db.staff_compensation.bulkDelete(comp.map((c) => c.id));
    }
    const local = await db.restricted_local
      .where('[table+parent_id]')
      .anyOf(staffIds.map((s) => ['staff_compensation', s]))
      .toArray();
    if (local.length > 0) {
      restricted.push(...local);
      await db.restricted_local.bulkDelete(local.map((r) => r.id));
    }
  };

  if (table === 'projects') {
    for (const child of PROJECT_CHILD_TABLES) {
      const rows = (await db.table(child).where('project_id').equals(id).toArray()) as AnyRecord[];
      if (rows.length === 0) continue;
      children[child] = rows;
      await db.table(child).bulkDelete(rows.map((r) => String(r.id)));
      if (child === 'project_staff') await dropStaffChildren(rows.map((r) => String(r.id)));
    }
    const local = await db.restricted_local.where('project_id').equals(id).toArray();
    if (local.length > 0) {
      restricted.push(...local);
      await db.restricted_local.bulkDelete(local.map((r) => r.id));
    }
    await db.photo_blobs.where('project_id').equals(id).delete();
  } else if (table === 'project_staff') {
    await dropStaffChildren([id]);
  } else if (table === 'project_photos') {
    await db.photo_blobs.where('photo_id').equals(id).delete();
  }

  if (hit?.where === 'restricted_local') await db.restricted_local.delete(id);
  else await db.table(table).delete(id);

  if (Object.keys(children).length > 0) snapshot.children = children;
  if (restricted.length > 0) snapshot.restricted = restricted;
  return hit ? snapshot : Object.keys(children).length > 0 || restricted.length > 0 ? snapshot : undefined;
}

// ---------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a === null || a === undefined) && (b === null || b === undefined);
  }
  if (typeof a === 'object' && typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => (n < 10 ? '0' + n : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Database defaults of NOT NULL columns, so that a local row is complete before the first sync. */
function insertDefaults(table: TableName, nowMs: number): AnyRecord {
  switch (table) {
    case 'projects':
      return { status: 'active', record_state: 'draft', completeness: 0, search_norm: '' };
    case 'localities':
      return { status: 'proposed', name_norm: '' };
    case 'donors':
      return { name_norm: '' };
    case 'persons':
      return { name_normalized: '' };
    case 'project_maintenance':
      return { reported_on: localDate(nowMs), priority: 'medium', state: 'open' };
    case 'project_photos':
      return { is_cover: false, category: 'unspecified', upload_state: 'pending' };
    case 'staff_compensation':
      return { effective_from: localDate(nowMs) };
    case 'community_profiles':
      return {
        daawa_activities: [],
        social_features: [],
        livelihoods: [],
        religious_issues: [],
        religious_challenges: [],
        social_challenges: [],
        proposed_activities: [],
      };
    case 'person_merge_requests':
      return { state: 'pending' };
    default:
      return {};
  }
}

/**
 * A complete, not yet stored row for forms: fresh UUIDv7 (unless `values.id` is given), every
 * column present (database defaults, else `null`), `version` 0. Pass it to
 * `mutate(table, row.id, row, { insert: true })` or put it into a bundle for
 * `saveProjectBundle()`.
 */
export function newRow<T extends TableName>(table: T, values: Partial<Row<T>> = {}): Row<T> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const row: AnyRecord = {};
  for (const c of tableDef(table).columns) row[c] = null;
  Object.assign(row, insertDefaults(table, nowMs), {
    id: uuidv7(),
    version: 0,
    created_at: nowIso,
    updated_at: nowIso,
    created_by: null,
    updated_by: null,
    deleted_at: null,
  });
  for (const [k, v] of Object.entries(values as AnyRecord)) {
    if (v !== undefined) row[k] = v;
  }
  return row as unknown as Row<T>;
}

function checkPoint(def: SyncTableDef, row: AnyRecord): void {
  if (!def.geomPoint) return;
  const lon = row.lon ?? null;
  const lat = row.lat ?? null;
  if (lon === null && lat === null) return;
  if (!isValidLonLat({ lon, lat })) throw new DbError('invalid_coordinates', `${String(lon)}, ${String(lat)}`);
}

// ---------------------------------------------------------------------------------------
// mutate
// ---------------------------------------------------------------------------------------

/**
 * Creates (`opts.insert`) or changes a row locally and queues the change for the server.
 * Server-managed columns, unknown names and `undefined` values in `patch` are ignored.
 * A patch that changes nothing queues nothing.
 *
 * @throws DbError `row_not_found` (update of a row that is not on the device),
 *         `table_not_writable`, `immutable_field` (parent link of an existing row),
 *         `invalid_coordinates` (lon/lat out of range or only one of them)
 */
export async function mutate<T extends TableName>(
  table: T,
  id: string,
  patch: Partial<Row<T>>,
  opts: { insert?: boolean } = {},
): Promise<void> {
  const def = tableDef(table);
  const writable = writableColumns(table);
  if (writable.size === 0) throw new DbError('table_not_writable', table);

  await db.transaction('rw', db.tables, async () => {
    const session = await getLocalSession();
    const changes: AnyRecord = {};
    for (const [k, v] of Object.entries(patch as AnyRecord)) {
      if (v !== undefined && writable.has(k)) changes[k] = v;
    }
    const hit = await findLocal(table, id);
    if (hit) {
      await updateRow(def, id, hit, changes, session);
    } else if (opts.insert) {
      await insertRow(def, id, changes, session);
    } else {
      throw new DbError('row_not_found', `${table} ${id}`);
    }
  });
}

async function insertRow(def: SyncTableDef, id: string, changes: AnyRecord, session: LocalSession): Promise<void> {
  const table = def.name;
  if (!canPush(table, 'insert')) throw new DbError('table_not_writable', table);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const row: AnyRecord = {};
  for (const c of def.columns) row[c] = null;
  Object.assign(row, insertDefaults(table, nowMs), changes, {
    id,
    version: 0,
    created_at: nowIso,
    updated_at: nowIso,
    created_by: session.userId,
    updated_by: session.userId,
    deleted_at: null,
    _dirty: 1,
  });
  checkPoint(def, row);

  const writable = writableColumns(table);
  const fields: AnyRecord = {};
  for (const c of def.columns) {
    const v = row[c];
    if (writable.has(c) && v !== null && v !== undefined) fields[c] = v;
  }
  // The offline entry time: accepted by the server on insert only.
  fields.created_at = nowIso;

  const projectId = await projectIdOf(table, row);
  if (table === 'projects') {
    const p = row as unknown as StoredProject;
    p._u = nowMs;
    p._cmp = completenessScore(p, { photos: false, land: false, facilities: false, staff: false, community: false });
  }
  const where: LocalHit['where'] = def.restricted && !session.canSeeRestricted ? 'restricted_local' : 'store';
  await putLocal(table, row, where, projectId);
  await db.outbox.add({
    op_id: uuidv7(),
    table,
    row_id: id,
    kind: 'upsert',
    base_version: 0,
    fields,
    state: 'pending',
    attempts: 0,
    created_at: nowIso,
    project_id: projectId,
    user_id: session.userId,
  });
  await afterChildChange(table, projectId);
}

/** Two different `record_state` targets on a synced project must reach the server separately. */
function crossesStateTransition(table: TableName, last: OutboxOp, diff: AnyRecord): boolean {
  return (
    table === 'projects' &&
    !isInsertOp(last) &&
    'record_state' in diff &&
    'record_state' in last.fields &&
    last.fields.record_state !== diff.record_state
  );
}

/** True when the edit points to a row whose insert is queued behind `last`. */
async function referencesLaterRow(def: SyncTableDef, last: OutboxOp, diff: AnyRecord): Promise<boolean> {
  for (const [col, refTable] of Object.entries(def.refs)) {
    const refId = diff[col];
    if (typeof refId !== 'string') continue;
    const refOps = await opsForRow(refTable, refId);
    if (refOps.some((o) => (o.seq ?? 0) > (last.seq ?? 0) && isInsertOp(o))) return true;
  }
  return false;
}

async function updateRow(
  def: SyncTableDef,
  id: string,
  hit: LocalHit,
  changes: AnyRecord,
  session: LocalSession,
): Promise<void> {
  const table = def.name;
  const current = hit.row;
  const diff: AnyRecord = {};
  for (const [k, v] of Object.entries(changes)) {
    if (!valuesEqual(current[k], v)) diff[k] = v;
  }
  if (def.geomPoint && ('lon' in diff || 'lat' in diff)) {
    // lon and lat always travel together.
    diff.lon = ('lon' in changes ? changes.lon : current.lon) ?? null;
    diff.lat = ('lat' in changes ? changes.lat : current.lat) ?? null;
    checkPoint(def, diff);
  }
  const keys = Object.keys(diff);
  if (keys.length === 0) return;
  for (const c of def.immutableCols) {
    if (c in diff) throw new DbError('immutable_field', `${table}.${c}`);
  }
  if (!canPush(table, 'update')) throw new DbError('table_not_writable', table);

  const nowMs = Date.now();
  const next: AnyRecord = { ...current, ...diff, _dirty: 1 };
  const projectId = await projectIdOf(table, next);

  // A rejected operation proves the server stored nothing, so its content may be changed:
  // editing a row that "needs attention" folds the rejected operations into the new one.
  const failed = (await failedOpsForRow(table, id)).filter((f) => f.kind === 'upsert');
  const ops = await opsForRow(table, id);
  const last = ops[ops.length - 1];

  if (failed.length > 0) {
    let fields: AnyRecord = {};
    let before: AnyRecord = {};
    let base = typeof current.version === 'number' ? current.version : 0;
    let insert = false;
    for (const f of failed) {
      fields = { ...fields, ...f.fields };
      before = { ...(f.before ?? {}), ...before };
      base = Math.min(base, f.base_version);
      insert = insert || isInsertOp(f);
    }
    for (const k of keys) {
      if (!(k in before) && !insert) before[k] = current[k] ?? null;
      if (insert && (diff[k] === null || diff[k] === undefined)) delete fields[k];
      else fields[k] = diff[k];
    }
    await db.failed_ops.bulkDelete(failed.map((f) => f.id!));
    delete next._failed;
    await db.outbox.add({
      op_id: uuidv7(),
      table,
      row_id: id,
      kind: 'upsert',
      base_version: base,
      fields,
      before,
      state: 'pending',
      attempts: 0,
      created_at: failed[0]!.created_at,
      project_id: projectId,
      user_id: session.userId,
    });
  } else if (
    last &&
    last.kind === 'upsert' &&
    last.state === 'pending' &&
    last.attempts === 0 &&
    !crossesStateTransition(table, last, diff) &&
    !(await referencesLaterRow(def, last, diff))
  ) {
    const insert = isInsertOp(last);
    const fields = { ...last.fields };
    const before = { ...(last.before ?? {}) };
    for (const k of keys) {
      if (insert) {
        // An insert carries final values only; a cleared field is simply not sent.
        if (diff[k] === null || diff[k] === undefined) delete fields[k];
        else fields[k] = diff[k];
      } else {
        if (!(k in before)) before[k] = current[k] ?? null;
        fields[k] = diff[k];
      }
    }
    await db.outbox.update(last.seq!, insert ? { fields } : { fields, before });
  } else {
    const before: AnyRecord = {};
    for (const k of keys) before[k] = current[k] ?? null;
    await db.outbox.add({
      op_id: uuidv7(),
      table,
      row_id: id,
      kind: 'upsert',
      base_version: typeof current.version === 'number' ? current.version : 0,
      fields: { ...diff },
      before,
      state: 'pending',
      attempts: 0,
      created_at: new Date(nowMs).toISOString(),
      project_id: projectId,
      user_id: session.userId,
    });
  }

  if (table === 'projects') {
    const p = next as unknown as StoredProject;
    p._u = nowMs;
    p._cmp = completenessScore(p, await completenessChildren(id));
  }
  await putLocal(table, next, hit.where, projectId);
  await afterChildChange(table, projectId);
}

// ---------------------------------------------------------------------------------------
// softDelete
// ---------------------------------------------------------------------------------------

/**
 * Deletes a row for the user: it disappears from the device at once (with the children of a
 * project) and a delete operation is queued. The removed rows are kept inside the operation
 * so that a rejected delete can be undone (`discardFailedOp`). A row the server never saw is
 * simply dropped together with its queued operations. Unknown ids are ignored.
 */
export async function softDelete(table: TableName, id: string): Promise<void> {
  if (!canPush(table, 'delete')) throw new DbError('table_not_writable', table);
  await db.transaction('rw', db.tables, async () => {
    const hit = await findLocal(table, id);
    if (!hit) return;
    const session = await getLocalSession();
    const row = hit.row;
    const ops = await opsForRow(table, id);
    const version = typeof row.version === 'number' ? row.version : 0;
    const serverMayKnow = version > 0 || ops.some((o) => o.attempts > 0 || o.state === 'inflight');
    const projectId = await projectIdOf(table, row);
    const snapshot = (await removeLocalRow(table, id)) ?? { row };

    if (!serverMayKnow) {
      // Insert (+ edits) and delete cancel out; so do the operations of everything that
      // hung below the row, none of which can have been sent before its parent.
      await db.outbox.bulkDelete(ops.map((o) => o.seq!));
      await db.failed_ops.where('[table+row_id]').equals([table, id]).delete();
      const dropped: Array<[TableName, string]> = [];
      for (const [childTable, rows] of Object.entries(snapshot.children ?? {})) {
        for (const r of rows ?? []) dropped.push([childTable as TableName, String(r.id)]);
      }
      for (const rec of snapshot.restricted ?? []) dropped.push([rec.table, rec.id]);
      for (const [childTable, childId] of dropped) {
        await db.outbox.where('[table+row_id]').equals([childTable, childId]).delete();
        await db.failed_ops.where('[table+row_id]').equals([childTable, childId]).delete();
      }
    } else {
      await db.outbox.add({
        op_id: uuidv7(),
        table,
        row_id: id,
        kind: 'delete',
        base_version: version,
        fields: {},
        snapshot,
        state: 'pending',
        attempts: 0,
        created_at: new Date().toISOString(),
        project_id: projectId,
        user_id: session.userId,
      });
    }
    await afterChildChange(table, projectId);
  });
}

/**
 * The local database (IndexedDB through Dexie), name `istiqama-map`.
 *
 *  - one store per syncable table, keyed by `id`, holding LIVE rows only (a tombstone or a
 *    local delete removes the row), plus local derived fields that drive the indexes
 *    (`derive.ts`);
 *  - local-only stores: `outbox`, `failed_ops`, `photo_blobs`, `drafts`, `meta`,
 *    `restricted_local`, `packs`.
 *
 * Schema changes: append a step to `SCHEMA` (never edit a released step). Dexie adds and
 * removes indexes itself; a step needs an `upgrade` function only when stored objects must
 * be rewritten (for example to fill a new derived field).
 */
import Dexie, { type Table, type Transaction } from 'dexie';
import type {
  IsoTimestamp,
  PushError,
  PushKind,
  RestrictedTableName,
  Row,
  TableName,
  Uuid,
} from './types';

export const DB_NAME = 'istiqama-map';

// ---------------------------------------------------------------------------------------
// Local-only records
// ---------------------------------------------------------------------------------------

/** Rows removed by a local delete, kept so that a rejected delete can be undone. */
export interface DeleteSnapshot {
  row: Record<string, unknown>;
  /** Children dropped locally together with a project: table → rows. */
  children?: Partial<Record<TableName, Array<Record<string, unknown>>>>;
  /** Restricted rows of the project that only lived in `restricted_local`. */
  restricted?: RestrictedLocalRecord[];
}

export interface OutboxOp {
  /** Auto-increment key = creation order = push order. */
  seq?: number;
  /** Idempotency key (UUIDv7), generated once; never changes on retry. */
  op_id: Uuid;
  table: TableName;
  row_id: Uuid;
  kind: PushKind;
  /** Version of the row the edit was made on; 0 = created on this device. */
  base_version: number;
  /** Upsert: changed fields (all fields on insert). Empty for deletes. */
  fields: Record<string, unknown>;
  /** `pending` = waiting; `inflight` = handed to the transport, answer unknown. */
  state: 'pending' | 'inflight';
  /** How often the op was handed to the transport. `> 0` freezes the op (no coalescing). */
  attempts: number;
  /** When the (first) edit was made on the device: `client_ts` on the wire. */
  created_at: IsoTimestamp;
  /** Project the row belongs to (the row itself for `projects`), when known. */
  project_id: Uuid | null;
  /** Who made the edit (the engine must not push another user's operations). */
  user_id: Uuid | null;
  /** Local values of the changed fields before the first edit of this op (undo for discard). */
  before?: Record<string, unknown>;
  /** Delete ops: what was removed locally. */
  snapshot?: DeleteSnapshot;
}

export interface FailedOp extends Omit<OutboxOp, 'seq' | 'state'> {
  /** Auto-increment key. */
  id?: number;
  /** `seq` the op had in the outbox (retry keeps the original order). */
  seq: number;
  error: PushError;
  /** Epoch milliseconds. */
  failed_at: number;
}

export type PhotoBlobKind = 'full' | 'thumb';

export interface PhotoBlobRecord {
  /** `<photo_id>:<kind>`. */
  id: string;
  photo_id: Uuid;
  kind: PhotoBlobKind;
  /** The image. Engines that cannot store Blobs get an ArrayBuffer + `mime` instead. */
  data: Blob | ArrayBuffer;
  mime: string;
  bytes: number;
  project_id: Uuid | null;
  /** Epoch milliseconds. */
  created_at: number;
}

export interface DraftRecord {
  key: string;
  value: unknown;
  /** Epoch milliseconds of the last save. */
  updatedAt: number;
}

export interface MetaRecord {
  key: string;
  value: unknown;
}

/**
 * A restricted row (salary, sensitive community data) entered on a device without restricted
 * capability. It never enters the normal stores and is deleted once the server acknowledged
 * its operation (brief §3).
 */
export interface RestrictedLocalRecord {
  id: Uuid;
  table: RestrictedTableName;
  /** `project_id` (community_sensitive) or `project_staff_id` (staff_compensation). */
  parent_id: Uuid;
  project_id: Uuid | null;
  row: Row<RestrictedTableName>;
  /** Epoch milliseconds. */
  updated_at: number;
}

/** A downloaded offline map pack (owned by `src/map`; only `code` is fixed here). */
export interface PackRecord {
  code: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------

/** `_dirty` and `_conflict` are sparse (only rows that carry the flag are indexed). */
const FLAGS = '_dirty, _conflict';
const child = (extra = ''): string => `id, project_id${extra ? ', ' + extra : ''}, ${FLAGS}`;

const V1_STORES: Record<string, string> = {
  // --- synced tables (private.sync_tables order) ---------------------------------------
  countries: `id, iso2, ${FLAGS}`,
  admin_areas: `id, parent_id, [country_id+level], ${FLAGS}`,
  branches: `id, country_id, ${FLAGS}`,
  option_values: `id, list_key, ${FLAGS}`,
  fx_rates: `id, [currency+effective_date], ${FLAGS}`,
  localities: `id, country_id, admin_area_id, _cell, *_tokens, ${FLAGS}`,
  donors: `id, *_tokens, ${FLAGS}`,
  // _fn / _fu: [facet, sort key, id] entries — list by name / updated with any single filter
  // (country, branch, admin area, type, status, record state, creator, incomplete, open
  // maintenance) straight from the index. _cell: grid cell for bbox queries.
  projects: `id, locality_id, _cell, *_tokens, *_fn, *_fu, ${FLAGS}`,
  project_land: child(),
  project_facilities: child(),
  // _mk: [priority rank, -reported day, id] for OPEN entries only (maintenance list, badge)
  project_maintenance: child('[project_id+state], _mk'),
  project_photos: child(),
  project_donors: child('donor_id'),
  persons: `id, phone_e164, [_name+id], *_tokens, ${FLAGS}`,
  project_staff: child('person_id'),
  community_profiles: child(),
  staff_compensation: `id, project_staff_id, ${FLAGS}`,
  community_sensitive: child(),
  person_merge_requests: `id, source_person_id, target_person_id, state, ${FLAGS}`,
  sync_conflicts: `id, [table_name+row_id], project_id, state, ${FLAGS}`,
  notifications: `id, _unread, created_at, ${FLAGS}`,
  map_packs: `id, code, ${FLAGS}`,
  // --- local only ----------------------------------------------------------------------
  outbox: '++seq, &op_id, [table+row_id], state, project_id',
  failed_ops: '++id, &op_id, [table+row_id], project_id',
  photo_blobs: 'id, photo_id, project_id',
  drafts: 'key, updatedAt',
  meta: 'key',
  restricted_local: 'id, [table+parent_id], project_id',
  packs: 'code',
};

export interface SchemaStep {
  version: number;
  /** Full or partial store definitions of this version (Dexie syntax; `null` drops a store). */
  stores: Record<string, string | null>;
  /** Rewrites stored objects when moving to this version. */
  upgrade?: (tx: Transaction) => PromiseLike<unknown> | void;
}

export const SCHEMA: readonly SchemaStep[] = [{ version: 1, stores: V1_STORES }];

export const SCHEMA_VERSION: number = SCHEMA[SCHEMA.length - 1]!.version;

type SyncedTables = { [T in TableName]: Table<Row<T>, string> };

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface IstiqamaDexie extends SyncedTables {
  outbox: Table<OutboxOp, number>;
  failed_ops: Table<FailedOp, number>;
  photo_blobs: Table<PhotoBlobRecord, string>;
  drafts: Table<DraftRecord, string>;
  meta: Table<MetaRecord, string>;
  restricted_local: Table<RestrictedLocalRecord, string>;
  packs: Table<PackRecord, string>;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class IstiqamaDexie extends Dexie {
  /** True after another tab asked for a newer schema: this connection was closed. */
  outdated = false;

  constructor(name: string = DB_NAME, schema: readonly SchemaStep[] = SCHEMA) {
    super(name);
    for (const step of schema) {
      const v = this.version(step.version).stores(step.stores);
      if (step.upgrade) v.upgrade(step.upgrade);
    }
    // A newer app version (another tab, or the updated service worker) wants to upgrade the
    // schema: release the connection instead of blocking it. The shell reloads the page.
    this.on('versionchange', () => {
      this.outdated = true;
      this.close();
    });
  }

  /** Typed access to the store of a synced table. */
  rows<T extends TableName>(name: T): Table<Row<T>, string> {
    return this.table(name) as Table<Row<T>, string>;
  }
}

/** The app-wide database handle (opened lazily by the first query). */
export const db: IstiqamaDexie = new IstiqamaDexie();

/** Stores a write path may touch; every write transaction uses the same scope so they nest. */
export function allStores(): Table[] {
  return db.tables;
}

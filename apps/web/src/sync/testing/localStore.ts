/**
 * TEST SUPPORT — a small reference implementation of `DbPort` on Dexie.
 *
 * It implements the client obligations of docs/contracts/sync.md that belong to the local
 * database (coalescing, acknowledgement, re-applying pending fields over pulled rows,
 * tombstones, `gone`, restricted_local purge) so that the sync engine can be exercised end
 * to end — in unit tests with fake-indexeddb and in the live integration tests, where two
 * instances with different database names simulate two devices. Never imported by the app.
 */
import Dexie, { type Table } from 'dexie';
import type {
  DbPort,
  LocalCounts,
  OutboxOp,
  PageToApply,
  PhotoKind,
  SyncTableInfo,
} from '../ports';
import type { AppliedStatus, PushResult } from '../types';
import { PROJECT_CHILDREN, REGISTRY, isRestricted } from './registry';

type Row = Record<string, unknown> & { id: string };

interface StoredOp extends OutboxOp {
  state: 'pending' | 'inflight';
}

interface FailedOp extends OutboxOp {
  error: PushResult['error'] | null;
  failed_at: number;
}

interface StoredBlob {
  photo_id: string;
  kind: PhotoKind;
  bytes: ArrayBuffer;
  type: string;
}

interface RestrictedLocal {
  table: string;
  id: string;
  row: Row;
}

export interface LocalStoreOptions {
  /**
   * True (default) = a field collector's device: rows of restricted tables live in
   * `restricted_local` until the server acknowledged them, then they are deleted.
   */
  collector?: boolean;
  now?: () => number;
}

function uuid(): string {
  return crypto.randomUUID();
}

export class LocalStore implements DbPort {
  readonly tables: readonly SyncTableInfo[] = REGISTRY;
  readonly dexie: Dexie;
  private readonly collector: boolean;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly name: string,
    options: LocalStoreOptions = {},
  ) {
    this.collector = options.collector ?? true;
    this.now = options.now ?? Date.now;
    this.dexie = new Dexie(name);
    const stores: Record<string, string> = {
      outbox: '++seq, op_id, [table+id], state',
      failed_ops: '++seq, op_id',
      meta: 'key',
      photo_blobs: '[photo_id+kind], photo_id',
      restricted_local: '[table+id]',
      drafts: 'key',
    };
    for (const t of REGISTRY) {
      stores[t.name] = PROJECT_CHILDREN.includes(t.name)
        ? 'id, project_id'
        : t.name === 'staff_compensation'
          ? 'id, project_staff_id'
          : 'id';
    }
    this.dexie.version(1).stores(stores);
  }

  // -- helpers ------------------------------------------------------------------------------

  private t<T = Row>(name: string): Table<T> {
    return this.dexie.table(name) as Table<T>;
  }

  private get outbox(): Table<StoredOp, number> {
    return this.dexie.table('outbox') as Table<StoredOp, number>;
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private usesRestrictedLocal(table: string): boolean {
    return this.collector && isRestricted(table);
  }

  private opsForRow(table: string, id: string): Promise<StoredOp[]> {
    return this.outbox.where('[table+id]').equals([table, id]).sortBy('seq');
  }

  close(): void {
    this.dexie.close();
  }

  async destroy(): Promise<void> {
    this.dexie.close();
    await Dexie.delete(this.name);
  }

  // -- writes made by the application (twin of src/db mutate / softDelete) ------------------

  async mutate(table: string, id: string, patch: Record<string, unknown>): Promise<void> {
    await this.dexie.transaction('rw', this.dexie.tables, async () => {
      const local = this.usesRestrictedLocal(table);
      const current = local
        ? (await this.t<RestrictedLocal>('restricted_local').get([table, id]))?.row
        : await this.t(table).get(id);
      const baseVersion = typeof current?.version === 'number' ? current.version : 0;
      const next: Row = { ...(current ?? { id, version: 0 }), ...patch, id, _dirty: 1 };
      if (local) await this.t<RestrictedLocal>('restricted_local').put({ table, id, row: next });
      else await this.t(table).put(next);

      const ops = await this.opsForRow(table, id);
      const last = ops[ops.length - 1];
      const stateChange =
        'record_state' in patch || (last !== undefined && 'record_state' in last.fields);
      if (
        last &&
        last.kind === 'upsert' &&
        last.state === 'pending' &&
        last.attempts === 0 &&
        !stateChange
      ) {
        // Coalesce: union of fields, oldest base_version and the op id are kept (never sent).
        await this.outbox.update(last.seq, { fields: { ...last.fields, ...patch } });
      } else {
        await this.outbox.add({
          op_id: uuid(),
          table,
          id,
          kind: 'upsert',
          base_version: baseVersion,
          fields: { ...patch },
          client_ts: new Date(this.now()).toISOString(),
          attempts: 0,
          state: 'pending',
        } as StoredOp);
      }
    });
    this.emit();
  }

  async softDelete(table: string, id: string): Promise<void> {
    await this.dexie.transaction('rw', this.dexie.tables, async () => {
      const ops = await this.opsForRow(table, id);
      const neverSent = ops.every((o) => o.attempts === 0 && o.state === 'pending');
      const createdHere = ops.length > 0 && ops[0]?.base_version === 0 && ops[0]?.kind === 'upsert';
      const row = await this.getRow(table, id);
      const childIds: Array<[string, string]> = [];
      if (table === 'projects') {
        for (const child of PROJECT_CHILDREN) {
          for (const r of await this.t(child).where('project_id').equals(id).toArray())
            childIds.push([child, r.id]);
        }
      }
      await this.removeLocalRow(table, id);
      if (createdHere && neverSent) {
        // Insert + delete that the server never saw cancel out (together with the children's ops).
        await this.outbox.bulkDelete(ops.map((o) => o.seq));
        for (const [childTable, childId] of childIds) {
          const childOps = await this.opsForRow(childTable, childId);
          await this.outbox.bulkDelete(childOps.filter((o) => o.attempts === 0).map((o) => o.seq));
        }
        return;
      }
      await this.outbox.add({
        op_id: uuid(),
        table,
        id,
        kind: 'delete',
        base_version: typeof row?.version === 'number' ? row.version : 0,
        fields: {},
        client_ts: new Date(this.now()).toISOString(),
        attempts: 0,
        state: 'pending',
      } as StoredOp);
    });
    this.emit();
  }

  private async removeLocalRow(table: string, id: string): Promise<void> {
    await this.t(table).delete(id);
    await this.t<RestrictedLocal>('restricted_local').delete([table, id]);
    if (table === 'projects') {
      for (const child of PROJECT_CHILDREN) {
        const rows = await this.t(child).where('project_id').equals(id).toArray();
        for (const r of rows) await this.removeLocalRow(child, r.id);
      }
    } else if (table === 'project_staff') {
      await this.t('staff_compensation').where('project_staff_id').equals(id).delete();
    } else if (table === 'project_photos') {
      await this.t<StoredBlob>('photo_blobs').where('photo_id').equals(id).delete();
    }
  }

  // -- DbPort: outbox -----------------------------------------------------------------------

  async pendingOps(): Promise<OutboxOp[]> {
    const ops = await this.outbox.where('state').equals('pending').toArray();
    return ops.map(({ state: _state, ...op }) => op);
  }

  async allOps(): Promise<StoredOp[]> {
    return this.outbox.orderBy('seq').toArray();
  }

  async failedOps(): Promise<FailedOp[]> {
    return this.t<FailedOp>('failed_ops').toArray();
  }

  async markInflight(seqs: readonly number[]): Promise<OutboxOp[]> {
    const claimed: OutboxOp[] = [];
    await this.dexie.transaction('rw', this.outbox, async () => {
      for (const seq of seqs) {
        const op = await this.outbox.get(seq);
        if (!op || op.state !== 'pending') continue;
        const attempts = op.attempts + 1;
        await this.outbox.update(seq, { state: 'inflight', attempts });
        const { state: _state, ...rest } = op;
        claimed.push({ ...rest, attempts });
      }
    });
    return claimed;
  }

  async requeueInflight(seqs?: readonly number[]): Promise<number> {
    const n = await this.dexie.transaction('rw', this.outbox, async () => {
      const inflight = await this.outbox.where('state').equals('inflight').toArray();
      const wanted = seqs ? inflight.filter((o) => seqs.includes(o.seq)) : inflight;
      for (const op of wanted) await this.outbox.update(op.seq, { state: 'pending' });
      return wanted.length;
    });
    if (n > 0) this.emit();
    return n;
  }

  async ackOp(op: OutboxOp, result: PushResult): Promise<void> {
    await this.dexie.transaction('rw', this.dexie.tables, async () => {
      const stored = await this.outbox.get(op.seq);
      if (!stored || stored.op_id !== op.op_id) return; // already acknowledged (another tab)
      await this.outbox.delete(op.seq);

      if (result.status === 'rejected') {
        await this.t<FailedOp>('failed_ops').add({
          ...op,
          error: result.error ?? null,
          failed_at: this.now(),
        } as FailedOp);
        return;
      }
      const status: AppliedStatus =
        result.status === 'duplicate' ? (result.original_status ?? 'applied') : result.status;

      // Device rule for restricted tables: gone from the device once acknowledged.
      if (this.usesRestrictedLocal(op.table)) {
        const remaining = await this.opsForRow(op.table, op.id);
        if (remaining.length === 0)
          await this.t<RestrictedLocal>('restricted_local').delete([op.table, op.id]);
        return;
      }
      if (op.kind === 'delete') {
        await this.removeLocalRow(op.table, op.id);
        return;
      }
      if (result.row_id && result.row_id !== op.id) {
        // Natural key: the server applied the op to its existing row, which arrives by pull.
        await this.t(op.table).delete(op.id);
        return;
      }
      const row = await this.t(op.table).get(op.id);
      if (!row) return;
      const remaining = await this.opsForRow(op.table, op.id);
      const pendingFields = new Set(remaining.flatMap((o) => Object.keys(o.fields)));
      const next: Row = { ...row };
      if (status === 'conflict') {
        for (const field of result.conflict_fields ?? []) {
          const value = result.server_values?.[field];
          if (field === 'geom') {
            const point = (value ?? {}) as { lon?: unknown; lat?: unknown };
            if (!pendingFields.has('lon')) next.lon = point.lon ?? null;
            if (!pendingFields.has('lat')) next.lat = point.lat ?? null;
          } else if (
            result.server_values &&
            field in result.server_values &&
            !pendingFields.has(field)
          ) {
            next[field] = value;
          }
        }
      }
      if (remaining.length === 0) {
        if (typeof result.version === 'number') next.version = result.version;
        delete next._dirty;
      }
      await this.t(op.table).put(next);
    });
    this.emit();
  }

  async counts(): Promise<LocalCounts> {
    const [pendingOps, failedOps] = await Promise.all([
      this.outbox.count(),
      this.t('failed_ops').count(),
    ]);
    return { pendingOps, failedOps };
  }

  watch(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -- DbPort: pull -------------------------------------------------------------------------

  async applyPage(page: PageToApply): Promise<void> {
    await this.dexie.transaction('rw', this.dexie.tables, async () => {
      for (const change of page.changes) {
        if (!this.tables.some((t) => t.name === change.table)) continue;
        const table = this.t(change.table);
        for (const incoming of change.rows ?? []) {
          const id = String(incoming.id);
          if (incoming.deleted_at !== null && incoming.deleted_at !== undefined) {
            await this.removeLocalRow(change.table, id);
            continue;
          }
          const pending = await this.opsForRow(change.table, id);
          if (pending.some((o) => o.kind === 'delete')) continue; // deleted locally, not sent yet
          if (pending.length === 0) {
            await table.put({ ...incoming, id });
            continue;
          }
          // Never overwrite local edits: pulled row first, pending fields on top.
          const overlay = Object.assign({}, ...pending.map((o) => o.fields)) as Record<
            string,
            unknown
          >;
          await table.put({ ...incoming, ...overlay, id, _dirty: 1 });
        }
        for (const id of change.gone ?? []) await this.removeLocalRow(change.table, id);
      }
      const meta = this.t<{ key: string; value: unknown }>('meta');
      for (const entry of page.meta) await meta.put({ key: entry.key, value: entry.value });
    });
    this.emit();
  }

  async resetScopedData(): Promise<void> {
    await this.dexie.transaction('rw', this.dexie.tables, async () => {
      for (const info of this.tables) {
        // Rows that still carry unsent edits stay visible; everything else is discarded.
        await this.t(info.name)
          .filter((row) => row._dirty !== 1)
          .delete();
      }
    });
    this.emit();
  }

  async wipeAll(): Promise<void> {
    await this.dexie.transaction('rw', this.dexie.tables, async () => {
      for (const table of this.dexie.tables) await table.clear();
    });
    this.emit();
  }

  // -- DbPort: meta -------------------------------------------------------------------------

  async getMeta<T>(key: string): Promise<T | undefined> {
    const entry = await this.t<{ key: string; value: T }>('meta').get(key);
    return entry?.value;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.t('meta').put({ key, value } as unknown as Row);
    this.emit();
  }

  async deleteMeta(key: string): Promise<void> {
    await this.t('meta').delete(key);
    this.emit();
  }

  async listMeta<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    return this.t<{ key: string; value: T }>('meta').where('key').startsWith(prefix).sortBy('key');
  }

  async updateMeta<T>(
    key: string,
    fn: (current: T | undefined) => T | undefined,
  ): Promise<T | undefined> {
    const meta = this.t<{ key: string; value: T }>('meta');
    const result = await this.dexie.transaction('rw', meta, async () => {
      const next = fn((await meta.get(key))?.value);
      if (next === undefined) await meta.delete(key);
      else await meta.put({ key, value: next });
      return next;
    });
    this.emit();
    return result;
  }

  // -- DbPort: rows and photos --------------------------------------------------------------

  async getRow(table: string, id: string): Promise<Record<string, unknown> | undefined> {
    const row = await this.t(table).get(id);
    if (row) return row;
    return (await this.t<RestrictedLocal>('restricted_local').get([table, id]))?.row;
  }

  async allRows(table: string): Promise<Row[]> {
    return this.t(table).toArray();
  }

  async restrictedLocal(): Promise<RestrictedLocal[]> {
    return this.t<RestrictedLocal>('restricted_local').toArray();
  }

  async putPhotoBlob(photoId: string, kind: PhotoKind, blob: Blob): Promise<void> {
    // Stored as bytes: structured-cloning a Blob is not available in every test environment.
    await this.t<StoredBlob>('photo_blobs').put({
      photo_id: photoId,
      kind,
      bytes: await blob.arrayBuffer(),
      type: blob.type,
    });
  }

  async photoBlob(photoId: string, kind: PhotoKind): Promise<Blob | undefined> {
    const stored = await this.t<StoredBlob>('photo_blobs').get([photoId, kind]);
    return stored ? new Blob([stored.bytes], { type: stored.type }) : undefined;
  }

  async dropPhotoBlob(photoId: string, kind: PhotoKind): Promise<void> {
    await this.t<StoredBlob>('photo_blobs').delete([photoId, kind]);
  }
}

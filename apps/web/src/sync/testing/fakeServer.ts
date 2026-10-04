/**
 * TEST SUPPORT — an in-memory server speaking the sync protocol of docs/contracts/sync.md,
 * with scriptable failures. One `FakeServer` is shared by any number of simulated devices
 * (`transportFor(deviceId)`).
 *
 * Implemented faithfully enough for the client logic under test: the idempotency ledger,
 * versions, field-level merge with conflicts (changes of the calling device are ignored),
 * soft deletes, natural keys of the one-per-project tables, parent checks, the paged change
 * feed with a stable window, tombstones, `gone`, `reset` and `scope_epoch`.
 */
import { SyncError } from '../errors';
import type { DeviceAnswer, PullChange, PullPage, PushOp, PushResult, Transport } from '../types';
import { ONE_PER_PROJECT, PROJECT_CHILDREN, REGISTRY, isRestricted } from './registry';

type ServerRow = Record<string, unknown> & { id: string; version: number; deleted_at: string | null };

interface Stamp {
  xid: number;
}

interface Change {
  version: number;
  fields: string[];
  device: string;
}

interface Cursor {
  e: string;
  lo: number;
  hi: number | null;
  /** Position inside the round: table index and last id sent. */
  t?: number;
  id?: string;
  first?: boolean;
}

export interface FakeConflict {
  id: string;
  table_name: string;
  row_id: string;
  field: string;
  server_value: unknown;
  client_value: unknown;
  client_device_id: string;
  state: 'open';
}

type Step =
  | { kind: 'fail'; error: unknown }
  /** Apply the request on the server, then lose the response. */
  | { kind: 'drop' };

const rank = new Map(REGISTRY.map((t, i) => [t.name, i]));

export class FakeServer {
  epoch = 'epoch-1';
  /** Every call fails like a dead network while true. */
  offline = false;
  deviceRevoked = false;
  sessionOk = true;
  /** Restricted tables are part of the change feed only for callers with restricted access. */
  restrictedVisible = false;
  /** Return a code to reject an operation (`out_of_scope`, `check_violation`…). */
  rejectIf: ((op: PushOp) => string | null) | null = null;
  /** Row filter of the change feed (scope). */
  visible: (table: string, row: ServerRow) => boolean = () => true;
  /** Return an error to refuse a whole `sync_push` call (nothing is applied). */
  pushGuard: ((ops: PushOp[]) => unknown) | null = null;
  /** Runs while a push request is "on the wire" (before it is applied). */
  onPush: (() => Promise<void>) | null = null;
  /** Runs while a pull request is "on the wire". */
  onPull: (() => Promise<void>) | null = null;

  readonly conflicts: FakeConflict[] = [];
  readonly calls = {
    push: [] as Array<{ device: string; ops: PushOp[] }>,
    pull: [] as Array<{ cursor: unknown; limit: number }>,
    rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  };

  private xid = 1;
  private readonly rows = new Map<string, Map<string, ServerRow & Stamp>>();
  private readonly history = new Map<string, Change[]>();
  private readonly ledger = new Map<string, PushResult>();
  private readonly gone = new Map<string, string[]>();
  private readonly script = { push: [] as Step[], pull: [] as Step[], rpc: [] as Step[] };

  // -- scripting ----------------------------------------------------------------------------

  failNext(call: 'push' | 'pull' | 'rpc', error: unknown, times = 1): void {
    for (let i = 0; i < times; i++) this.script[call].push({ kind: 'fail', error });
  }

  /** The next push is applied but its response never arrives (network drop mid-request). */
  dropNextPushResponse(): void {
    this.script.push.push({ kind: 'drop' });
  }

  /** Rows of `table` left the caller's scope: announced as `gone` in the next round. */
  announceGone(table: string, ids: string[]): void {
    this.gone.set(table, [...(this.gone.get(table) ?? []), ...ids]);
  }

  // -- direct access for assertions and seeding ---------------------------------------------

  table(name: string): Map<string, ServerRow & Stamp> {
    let t = this.rows.get(name);
    if (!t) {
      t = new Map();
      this.rows.set(name, t);
    }
    return t;
  }

  row(table: string, id: string): ServerRow | undefined {
    return this.table(table).get(id);
  }

  liveRows(table: string): ServerRow[] {
    return [...this.table(table).values()].filter((r) => r.deleted_at === null);
  }

  /** Write as "another device": bumps the version and records the changed fields. */
  write(table: string, id: string, fields: Record<string, unknown>, device = 'server'): ServerRow {
    const t = this.table(table);
    const current = t.get(id);
    const version = (current?.version ?? 0) + 1;
    const next = { ...(current ?? { id, deleted_at: null }), ...fields, id, version, xid: this.xid++ } as ServerRow & Stamp;
    t.set(id, next);
    this.log(table, id, { version, fields: Object.keys(fields), device });
    return next;
  }

  remove(table: string, id: string, device = 'server'): void {
    this.write(table, id, { deleted_at: new Date(0).toISOString() }, device);
  }

  private log(table: string, id: string, change: Change): void {
    const key = `${table}:${id}`;
    this.history.set(key, [...(this.history.get(key) ?? []), change]);
  }

  // -- transport ----------------------------------------------------------------------------

  transportFor(device: string): Transport {
    return {
      push: (ops, _deviceId, options) => this.push(ops, device, options?.signal),
      pull: (cursor, limit, options) => this.pull(cursor, limit, options?.signal),
      rpc: <T>(fn: string, args: Record<string, unknown> = {}) => this.rpc(fn, args) as Promise<T>,
    };
  }

  /** A request cancelled while on the wire never reaches the handler. */
  private static cancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new SyncError('aborted', 'aborted');
  }

  private before(call: 'push' | 'pull' | 'rpc'): Step | undefined {
    if (this.offline) throw new SyncError('network', 'TypeError: fetch failed');
    const step = this.script[call].shift();
    if (step?.kind === 'fail') throw step.error;
    return step;
  }

  private async push(ops: PushOp[], device: string, signal?: AbortSignal): Promise<PushResult[]> {
    await Promise.resolve();
    const step = this.before('push');
    this.calls.push.push({ device, ops: structuredClone(ops) });
    if (this.onPush) await this.onPush();
    FakeServer.cancelled(signal);
    if (ops.length > 50) throw new SyncError('invalid', 'sync_push: too_many_ops', { status: 422, code: 'PT422' });
    const refused = this.pushGuard?.(ops);
    if (refused) throw refused;
    const results = ops.map((op) => this.apply(op, device));
    if (step?.kind === 'drop') throw new SyncError('network', 'TypeError: fetch failed');
    return structuredClone(results);
  }

  private apply(op: PushOp, device: string): PushResult {
    const known = this.ledger.get(op.op_id);
    if (known) {
      const { status, ...rest } = known;
      return { ...rest, status: 'duplicate', original_status: status as PushResult['original_status'] };
    }
    const result = this.applyNew(op, device);
    if (result.status !== 'rejected') this.ledger.set(op.op_id, result);
    return result;
  }

  private reject(op: PushOp, code: string): PushResult {
    return { op_id: op.op_id, status: 'rejected', error: { code, message: code } };
  }

  private applyNew(op: PushOp, device: string): PushResult {
    if (!rank.has(op.table)) return this.reject(op, 'unknown_table');
    const custom = this.rejectIf?.(op);
    if (custom) return this.reject(op, custom);
    const t = this.table(op.table);
    let id = op.id;
    let current = t.get(id);
    let base = op.base_version;
    let rowId: string | undefined;

    if (op.kind === 'delete') {
      if (!current || current.deleted_at !== null) return { op_id: op.op_id, status: 'applied', version: current?.version };
      const stale = base < current.version;
      const next = this.write(op.table, id, { deleted_at: new Date().toISOString() }, device);
      return { op_id: op.op_id, status: stale ? 'merged' : 'applied', version: next.version };
    }

    const fields = { ...(op.fields ?? {}) };
    if (!current) {
      const projectId = fields.project_id;
      if (PROJECT_CHILDREN.includes(op.table)) {
        if (typeof projectId !== 'string') return this.reject(op, 'parent_required');
        const parent = this.table('projects').get(projectId);
        if (!parent) return this.reject(op, 'parent_missing');
        if (parent.deleted_at !== null) return this.reject(op, 'parent_deleted');
        if (ONE_PER_PROJECT.includes(op.table)) {
          const existing = [...t.values()].find((r) => r.project_id === projectId && r.deleted_at === null);
          if (existing) {
            // Natural key: apply to the existing row as an update on base 0.
            id = existing.id;
            current = existing;
            base = 0;
            rowId = existing.id;
          }
        }
      }
      if (!current) {
        const next = this.write(op.table, id, fields, device);
        return { op_id: op.op_id, status: 'applied', version: next.version };
      }
    }
    if (current.deleted_at !== null) return this.reject(op, 'row_deleted');

    const differing = Object.keys(fields).filter((k) => JSON.stringify(fields[k]) !== JSON.stringify(current[k]));
    const extra = rowId ? { row_id: rowId } : {};
    if (differing.length === 0) return { op_id: op.op_id, status: 'applied', version: current.version, ...extra };

    let conflicting: string[] = [];
    let status: 'applied' | 'merged' | 'conflict' = 'applied';
    if (base < current.version) {
      const changedElsewhere = new Set(
        (this.history.get(`${op.table}:${id}`) ?? [])
          .filter((c) => c.version > base && c.device !== device)
          .flatMap((c) => c.fields),
      );
      conflicting = differing.filter((k) => changedElsewhere.has(k));
      status = conflicting.length > 0 ? 'conflict' : 'merged';
    }
    const toWrite = Object.fromEntries(differing.filter((k) => !conflicting.includes(k)).map((k) => [k, fields[k]]));
    const next = Object.keys(toWrite).length > 0 ? this.write(op.table, id, toWrite, device) : current;
    if (status !== 'conflict') return { op_id: op.op_id, status, version: next.version, ...extra };

    // lon/lat conflict as one field `geom`, like the real server.
    const reported = [...new Set(conflicting.map((k) => (k === 'lon' || k === 'lat' ? 'geom' : k)))];
    const conflictIds: string[] = [];
    const serverValues: Record<string, unknown> = {};
    for (const field of reported) {
      const serverValue = field === 'geom' ? { lon: current.lon ?? null, lat: current.lat ?? null } : current[field];
      const clientValue = field === 'geom' ? { lon: fields.lon ?? null, lat: fields.lat ?? null } : fields[field];
      const conflict: FakeConflict = {
        id: `conflict-${this.conflicts.length + 1}`,
        table_name: op.table,
        row_id: id,
        field,
        server_value: serverValue,
        client_value: clientValue,
        client_device_id: device,
        state: 'open',
      };
      this.conflicts.push(conflict);
      conflictIds.push(conflict.id);
      serverValues[field] = serverValue;
    }
    return {
      op_id: op.op_id,
      status: 'conflict',
      version: next.version,
      conflict_ids: conflictIds,
      conflict_fields: reported,
      ...(isRestricted(op.table) ? {} : { server_values: serverValues }),
      ...extra,
    };
  }

  private async pull(cursorIn: unknown, limit: number, signal?: AbortSignal): Promise<PullPage> {
    await Promise.resolve();
    this.before('pull');
    this.calls.pull.push({ cursor: structuredClone(cursorIn), limit });
    if (this.onPull) await this.onPull();
    FakeServer.cancelled(signal);
    let cursor = cursorIn as Cursor | null;
    let reset = false;
    if (cursor !== null && (typeof cursor !== 'object' || typeof cursor.e !== 'string')) {
      throw new SyncError('invalid', 'sync_pull: invalid_cursor', { status: 422, code: 'PT422' });
    }
    if (cursor && cursor.e !== this.epoch) {
      cursor = null;
      reset = true;
    }
    // Start of a round: fix the window [lo, hi).
    const round: Cursor =
      cursor && cursor.hi !== null
        ? cursor
        : { e: this.epoch, lo: cursor?.lo ?? 0, hi: this.xid, first: cursor === null, t: -1, id: '' };
    const startOfRound = !cursor || cursor.hi === null;
    const hi = round.hi as number;

    const candidates: Array<{ t: number; table: string; row: ServerRow & Stamp }> = [];
    REGISTRY.forEach((info, t) => {
      if (info.restricted && !this.restrictedVisible) return;
      for (const row of this.table(info.name).values()) {
        if (row.xid < round.lo || row.xid >= hi) continue;
        if (round.first && row.deleted_at !== null) continue; // a first round carries live rows only
        if (!this.visible(info.name, row)) continue;
        if (t < (round.t ?? -1) || (t === round.t && row.id <= (round.id ?? ''))) continue;
        candidates.push({ t, table: info.name, row });
      }
    });
    candidates.sort((a, b) => a.t - b.t || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));
    const page = candidates.slice(0, Math.max(1, Math.min(1000, limit)));
    const changes: PullChange[] = [];
    for (const item of page) {
      let change = changes.find((c) => c.table === item.table);
      if (!change) {
        change = { table: item.table, rows: [] };
        changes.push(change);
      }
      const { xid: _xid, ...wire } = item.row;
      (change.rows as Array<Record<string, unknown>>).push(structuredClone(wire));
    }
    if (startOfRound && !round.first) {
      for (const [table, ids] of this.gone) {
        const change = changes.find((c) => c.table === table);
        if (change) change.gone = ids;
        else changes.push({ table, rows: [], gone: ids });
      }
      this.gone.clear();
      changes.sort((a, b) => (rank.get(a.table) ?? 0) - (rank.get(b.table) ?? 0));
    }
    const done = candidates.length <= page.length;
    const last = page[page.length - 1];
    const next: Cursor = done
      ? { e: this.epoch, lo: hi, hi: null }
      : { e: this.epoch, lo: round.lo, hi, first: round.first, t: last?.t ?? round.t, id: last?.row.id ?? round.id };
    return { changes, cursor: next, done, reset, scope_epoch: this.epoch, server_time: new Date().toISOString() };
  }

  private async rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
    await Promise.resolve();
    this.before('rpc');
    this.calls.rpc.push({ fn, args: structuredClone(args) });
    if (fn === 'register_device') {
      return {
        device_id: String(args.p_device_id),
        revoked: this.deviceRevoked,
        revoked_at: null,
      } satisfies DeviceAnswer;
    }
    if (fn === 'report_device_status') {
      return {
        device_id: String(args.p_device_id),
        revoked: this.deviceRevoked,
        revoked_at: null,
        session_ok: this.sessionOk,
      } satisfies DeviceAnswer;
    }
    throw new SyncError('not_found', `${fn}: unknown function`, { status: 404 });
  }
}

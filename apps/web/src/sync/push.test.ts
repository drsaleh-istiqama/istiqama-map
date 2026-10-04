import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SyncError } from './errors';
import type { DbPort, OutboxOp } from './ports';
import { orderOps, pushOutbox } from './push';
import { FakeServer } from './testing/fakeServer';
import { LocalStore } from './testing/localStore';
import { REGISTRY } from './testing/registry';
import { TestClock } from './testing/testClock';

let n = 0;
const uid = (): string => {
  n++;
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
};

let store: LocalStore;
let server: FakeServer;
let clock: TestClock;
const DEVICE = 'device-a';

function deps(db: DbPort = store) {
  return { db, transport: server.transportFor(DEVICE), auth: { deviceId: () => DEVICE }, clock };
}

beforeEach(() => {
  store = new LocalStore(`push-${uid()}`);
  server = new FakeServer();
  clock = new TestClock();
});

afterEach(async () => {
  await store.destroy();
});

function op(seq: number, table: string, kind: 'upsert' | 'delete' = 'upsert'): OutboxOp {
  return {
    seq,
    op_id: `op-${seq}`,
    table,
    id: `row-${seq}`,
    kind,
    base_version: 0,
    fields: {},
    client_ts: '',
    attempts: 0,
  };
}

describe('orderOps', () => {
  it('puts parents before children and keeps creation order inside a table', () => {
    const ordered = orderOps(
      [
        op(1, 'project_photos'),
        op(2, 'project_staff'),
        op(3, 'projects'),
        op(4, 'persons'),
        op(5, 'staff_compensation'),
        op(6, 'projects'),
        op(7, 'donors'),
        op(8, 'project_donors'),
        op(9, 'localities'),
      ],
      REGISTRY,
    );
    expect(ordered.map((o) => o.seq)).toEqual([9, 7, 3, 6, 1, 8, 4, 2, 5]);
  });

  it('keeps delete-then-insert order inside a table (natural keys, photo limit)', () => {
    const ordered = orderOps([op(1, 'project_land', 'delete'), op(2, 'project_land'), op(3, 'project_photos', 'delete'), op(4, 'project_photos')], REGISTRY);
    expect(ordered.map((o) => o.seq)).toEqual([1, 2, 3, 4]);
  });

  it('sends the delete of a parent after the operations on its children', () => {
    const ordered = orderOps(
      [op(1, 'project_maintenance'), op(2, 'projects', 'delete'), op(3, 'community_sensitive'), op(4, 'persons', 'delete'), op(5, 'project_staff')],
      REGISTRY,
    );
    expect(ordered.map((o) => o.seq)).toEqual([1, 5, 3, 2, 4]);
  });

  it('sends operations on unknown tables last', () => {
    expect(orderOps([op(1, 'nonsense'), op(2, 'map_packs')], REGISTRY).map((o) => o.seq)).toEqual([2, 1]);
  });
});

describe('pushOutbox', () => {
  it('accumulates work offline and replays it once the network is back', async () => {
    const ids = [uid(), uid(), uid()];
    for (const id of ids) await store.mutate('projects', id, { name_ar: `مسجد ${id}`, type: 'mosque' });
    await store.mutate('projects', ids[0]!, { capacity: 120 }); // coalesced into the insert

    server.offline = true;
    await expect(pushOutbox(deps(), { maxAttempts: 2 })).rejects.toMatchObject({ kind: 'network' });
    expect((await store.counts()).pendingOps).toBe(3);
    expect((await store.pendingOps()).every((o) => o.attempts === 1)).toBe(true);
    expect(server.liveRows('projects')).toHaveLength(0);

    server.offline = false;
    const outcome = await pushOutbox(deps());
    expect(outcome).toMatchObject({ sent: 3, applied: 3, rejected: 0 });
    expect(server.liveRows('projects')).toHaveLength(3);
    expect(server.row('projects', ids[0]!)).toMatchObject({ capacity: 120, version: 1 });
    expect(await store.counts()).toEqual({ pendingOps: 0, failedOps: 0 });
    const local = await store.getRow('projects', ids[0]!);
    expect(local).toMatchObject({ version: 1, capacity: 120 });
    expect(local).not.toHaveProperty('_dirty');
  });

  it('sends a parent before its children even when the child was queued first', async () => {
    const project = uid();
    const photo = uid();
    const land = uid();
    await store.mutate('project_photos', photo, { project_id: project, upload_state: 'pending' });
    await store.mutate('project_land', land, { project_id: project, ownership: 'waqf' });
    await store.mutate('projects', project, { name_ar: 'مدرسة', type: 'school' });

    const outcome = await pushOutbox(deps());
    expect(server.calls.push[0]!.ops.map((o) => o.table)).toEqual(['projects', 'project_land', 'project_photos']);
    expect(outcome).toMatchObject({ applied: 3, rejected: 0 });
  });

  it('sends batches of at most 50, one after the other, paced', async () => {
    for (let i = 0; i < 120; i++) await store.mutate('donors', uid(), { name_ar: `متبرع ${i}` });
    const started = clock.now();
    const outcome = await pushOutbox(deps());
    expect(server.calls.push.map((c) => c.ops.length)).toEqual([50, 50, 20]);
    expect(outcome).toMatchObject({ sent: 120, applied: 120 });
    // 600 ms between consecutive calls (server limit: 120 calls per minute).
    expect(clock.now() - started).toBeGreaterThanOrEqual(1200);
    // creation order is preserved inside the table
    const sent = server.calls.push.flatMap((c) => c.ops.map((o) => o.fields?.name_ar));
    expect(sent).toEqual(Array.from({ length: 120 }, (_, i) => `متبرع ${i}`));
  });

  it('has an exactly-once effect when the response of a batch is lost', async () => {
    const ids = [uid(), uid()];
    for (const id of ids) await store.mutate('projects', id, { name_ar: 'x', type: 'mosque' });
    server.dropNextPushResponse();

    const outcome = await pushOutbox(deps());
    // The first call was applied by the server; the retry carries the same op ids.
    expect(server.calls.push).toHaveLength(2);
    expect(server.calls.push[1]!.ops.map((o) => o.op_id)).toEqual(server.calls.push[0]!.ops.map((o) => o.op_id));
    expect(outcome).toMatchObject({ duplicates: 2, applied: 0 });
    expect(server.liveRows('projects')).toHaveLength(2);
    expect(server.row('projects', ids[0]!)?.version).toBe(1);
    expect((await store.counts()).pendingOps).toBe(0);
    expect(await store.getRow('projects', ids[1]!)).toMatchObject({ version: 1 });
  });

  it('requeues the same op ids when the cycle gives up, and converges on the next run', async () => {
    const id = uid();
    await store.mutate('projects', id, { name_ar: 'x', type: 'mosque' });
    const [queued] = await store.pendingOps();
    server.dropNextPushResponse();

    await expect(pushOutbox(deps(), { maxAttempts: 1 })).rejects.toMatchObject({ kind: 'network' });
    const [requeued] = await store.pendingOps();
    expect(requeued).toMatchObject({ op_id: queued!.op_id, attempts: 1 });

    // An edit made now must not be merged into the op the server may already have applied.
    await store.mutate('projects', id, { capacity: 80 });
    expect(await store.pendingOps()).toHaveLength(2);

    const outcome = await pushOutbox(deps());
    // base_version 0 against server version 1: merged (own changes never conflict with themselves)
    expect(outcome).toMatchObject({ duplicates: 1, merged: 1 });
    expect(server.row('projects', id)).toMatchObject({ name_ar: 'x', capacity: 80, version: 2 });
    expect(await store.getRow('projects', id)).toMatchObject({ version: 2, capacity: 80 });
    expect((await store.counts()).pendingOps).toBe(0);
  });

  it('converges after a crash between "response received" and "ack applied"', async () => {
    const ids = [uid(), uid(), uid()];
    for (const id of ids) await store.mutate('projects', id, { name_ar: 'x', type: 'mosque' });

    // The process dies while acknowledging the second result.
    let acks = 0;
    const crashing: DbPort = Object.assign(Object.create(store) as DbPort, {
      ackOp: async (o: OutboxOp, r: Parameters<DbPort['ackOp']>[1]) => {
        if (++acks === 2) throw new Error('process killed');
        await store.ackOp(o, r);
      },
    });
    await expect(pushOutbox(deps(crashing))).rejects.toThrow();
    expect(server.liveRows('projects')).toHaveLength(3); // the server applied the whole batch
    const leftovers = await store.allOps();
    expect(leftovers.map((o) => o.state)).toEqual(['inflight', 'inflight']);

    // "Reload": a new connection to the same database, a new run.
    store.close();
    store = new LocalStore(store.name);
    const outcome = await pushOutbox(deps());
    expect(outcome).toMatchObject({ sent: 2, duplicates: 2 });
    expect(server.liveRows('projects')).toHaveLength(3);
    expect(server.liveRows('projects').every((r) => r.version === 1)).toBe(true);
    expect((await store.counts()).pendingOps).toBe(0);
    for (const id of ids) expect(await store.getRow('projects', id)).toMatchObject({ version: 1 });
  });

  it('merges edits of different fields and reports no conflict', async () => {
    const id = uid();
    server.write('projects', id, { name_ar: 'قديم', builder: 'a', capacity: 10 });
    await store.applyPage({ changes: [{ table: 'projects', rows: [{ ...server.row('projects', id) }] }], meta: [] });
    server.write('projects', id, { builder: 'b' }, 'other-device'); // v2 elsewhere

    await store.mutate('projects', id, { capacity: 99 });
    const outcome = await pushOutbox(deps());
    expect(outcome).toMatchObject({ merged: 1, conflicts: 0 });
    expect(server.row('projects', id)).toMatchObject({ builder: 'b', capacity: 99, version: 3 });
    expect(server.conflicts).toHaveLength(0);
    expect(await store.getRow('projects', id)).toMatchObject({ capacity: 99, version: 3 });
  });

  it('on a field conflict keeps the server value locally and still writes the other fields', async () => {
    const id = uid();
    server.write('projects', id, { name_ar: 'قديم', builder: 'a', lon: 39.1, lat: -5.1 });
    await store.applyPage({ changes: [{ table: 'projects', rows: [{ ...server.row('projects', id) }] }], meta: [] });
    server.write('projects', id, { builder: 'server-side', lon: 39.5, lat: -5.5 }, 'other-device');

    await store.mutate('projects', id, { builder: 'mine', name_ar: 'جديد', lon: 39.9, lat: -5.9 });
    const outcome = await pushOutbox(deps());
    expect(outcome).toMatchObject({ conflicts: 1 });
    expect(server.row('projects', id)).toMatchObject({ builder: 'server-side', name_ar: 'جديد', lon: 39.5 });
    expect(server.conflicts.map((c) => c.field).sort()).toEqual(['builder', 'geom']);
    const local = await store.getRow('projects', id);
    expect(local).toMatchObject({ builder: 'server-side', name_ar: 'جديد', lon: 39.5, lat: -5.5, version: 3 });
    expect(local).not.toHaveProperty('_dirty');
    expect(await store.counts()).toEqual({ pendingOps: 0, failedOps: 0 });
  });

  it('parks a rejected op in failed_ops and keeps going', async () => {
    const ok1 = uid();
    const bad = uid();
    const ok2 = uid();
    await store.mutate('projects', ok1, { name_ar: 'a', type: 'mosque' });
    await store.mutate('projects', bad, { name_ar: 'b', type: 'mosque' });
    await store.mutate('projects', ok2, { name_ar: 'c', type: 'mosque' });
    server.rejectIf = (o) => (o.id === bad ? 'out_of_scope' : null);

    const outcome = await pushOutbox(deps());
    expect(outcome).toMatchObject({ applied: 2, rejected: 1 });
    expect(await store.counts()).toEqual({ pendingOps: 0, failedOps: 1 });
    const [failed] = await store.failedOps();
    expect(failed).toMatchObject({ id: bad, error: { code: 'out_of_scope' } });
    expect(server.row('projects', bad)).toBeUndefined();
    // the local row keeps the user's data so that it can be fixed and retried
    expect(await store.getRow('projects', bad)).toMatchObject({ name_ar: 'b', _dirty: 1 });
  });

  it('waits as long as the rate limiter asks, then sends the same batch again', async () => {
    await store.mutate('donors', uid(), { name_ar: 'x' });
    server.failNext('push', new SyncError('rate_limited', 'slow down', { status: 429, retryAfterMs: 3000 }));
    const started = clock.now();
    const outcome = await pushOutbox(deps());
    expect(outcome.applied).toBe(1);
    expect(clock.now() - started).toBeGreaterThanOrEqual(3000);
    expect(clock.now() - started).toBeLessThan(4000);
    expect(server.calls.push).toHaveLength(1); // the refused call never reached the handler
  });

  it('leaves a long rate-limit wait to the engine and requeues the batch', async () => {
    await store.mutate('donors', uid(), { name_ar: 'x' });
    server.failNext('push', new SyncError('rate_limited', 'slow down', { status: 429, retryAfterMs: 45_000 }));
    await expect(pushOutbox(deps())).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 45_000 });
    expect(await store.pendingOps()).toHaveLength(1);
    expect((await store.allOps())[0]!.state).toBe('pending');
  });

  it('backs off exponentially with jitter on 5xx', async () => {
    await store.mutate('donors', uid(), { name_ar: 'x' });
    server.failNext('push', new SyncError('server', 'HTTP 503', { status: 503 }), 2);
    clock.randomValue = 0.5;
    const outcome = await pushOutbox(deps());
    expect(outcome.applied).toBe(1);
    // base 1 s, factor 2, equal jitter at 0.5 → 750 ms then 1500 ms
    expect(clock.delays.filter((d) => d >= 500)).toEqual([750, 1500]);

    await store.mutate('donors', uid(), { name_ar: 'y' });
    server.failNext('push', new SyncError('server', 'HTTP 503', { status: 503 }), 3);
    await expect(pushOutbox(deps())).rejects.toMatchObject({ kind: 'server' });
    expect((await store.counts()).pendingOps).toBe(1);
  });

  it.each([
    ['session_revoked', new SyncError('session_revoked', 'sync_push: session_revoked', { status: 403, code: 'PT403' })],
    ['unauthenticated', new SyncError('unauthenticated', 'sync_push: not_authenticated', { status: 401, code: 'PT401' })],
  ])('stops at once on %s without retrying or losing the batch', async (kind, error) => {
    await store.mutate('donors', uid(), { name_ar: 'x' });
    server.failNext('push', error, 5);
    await expect(pushOutbox(deps())).rejects.toMatchObject({ kind });
    expect(server.calls.push).toHaveLength(0);
    expect(clock.delays.filter((d) => d >= 500)).toEqual([]);
    expect(await store.pendingOps()).toHaveLength(1);
  });

  it('isolates an operation that makes the whole call fail and records it in failed_ops', async () => {
    const ids = [uid(), uid(), uid()];
    for (const id of ids) await store.mutate('donors', id, { name_ar: id });
    server.pushGuard = (ops) =>
      ops.some((o) => o.id === ids[1]) ? new SyncError('invalid', 'sync_push: boom', { status: 400, code: 'P0001' }) : null;

    const outcome = await pushOutbox(deps());
    expect(outcome).toMatchObject({ applied: 2, rejected: 1 });
    expect(server.liveRows('donors').map((r) => r.id).sort()).toEqual([ids[0], ids[2]].sort());
    const [failed] = await store.failedOps();
    expect(failed).toMatchObject({ id: ids[1], error: { code: 'call_failed', sqlstate: 'P0001' } });
    expect(await store.counts()).toEqual({ pendingOps: 0, failedOps: 1 });
  });

  it('does not park anything when the call is refused because of the device id', async () => {
    await store.mutate('donors', uid(), { name_ar: 'x' });
    await store.mutate('donors', uid(), { name_ar: 'y' });
    server.pushGuard = () => new SyncError('invalid', 'sync_push: device_mismatch', { status: 422, code: 'PT422' });
    await expect(pushOutbox(deps())).rejects.toMatchObject({ kind: 'invalid' });
    expect(await store.counts()).toEqual({ pendingOps: 2, failedOps: 0 });
    expect(server.calls.push).toHaveLength(1);
  });

  it('pushes an edit that was made while its row was on the wire', async () => {
    const id = uid();
    await store.mutate('projects', id, { name_ar: 'x', type: 'mosque' });
    let edited = false;
    server.onPush = async () => {
      if (edited) return;
      edited = true;
      await store.mutate('projects', id, { capacity: 40 });
    };
    const outcome = await pushOutbox(deps());
    expect(server.calls.push).toHaveLength(2);
    expect(outcome).toMatchObject({ applied: 1, merged: 1 });
    expect(server.row('projects', id)).toMatchObject({ capacity: 40, version: 2 });
    const local = await store.getRow('projects', id);
    expect(local).toMatchObject({ capacity: 40, version: 2 });
    expect(local).not.toHaveProperty('_dirty');
  });

  it('requeues the batch when the cycle is aborted during a backoff', async () => {
    await store.mutate('donors', uid(), { name_ar: 'x' });
    server.failNext('push', new SyncError('server', 'HTTP 502', { status: 502 }), 3);
    const controller = new AbortController();
    const manual = new TestClock(0); // nothing fires by itself
    const run = pushOutbox({ ...deps(), clock: manual }, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    await expect(run).rejects.toMatchObject({ kind: 'aborted' });
    expect((await store.allOps()).map((o) => o.state)).toEqual(['pending']);
  });

  it('purges restricted rows from the device once they are acknowledged', async () => {
    const project = uid();
    const sensitive = uid();
    await store.mutate('projects', project, { name_ar: 'x', type: 'mosque' });
    await store.mutate('community_sensitive', sensitive, { project_id: project, ibadi_families: 12 });
    expect(await store.restrictedLocal()).toHaveLength(1);
    expect(await store.allRows('community_sensitive')).toHaveLength(0);

    await pushOutbox(deps());
    expect(server.row('community_sensitive', sensitive)).toMatchObject({ ibadi_families: 12 });
    expect(await store.restrictedLocal()).toHaveLength(0);
    expect(await store.allRows('community_sensitive')).toHaveLength(0);
  });

  it('drops the local row when the server applied the op to an existing row (natural key)', async () => {
    const project = uid();
    const existing = uid();
    server.write('projects', project, { name_ar: 'x' });
    server.write('project_land', existing, { project_id: project, ownership: 'waqf' });
    await store.applyPage({ changes: [{ table: 'projects', rows: [{ ...server.row('projects', project) }] }], meta: [] });

    const mine = uid();
    await store.mutate('project_land', mine, { project_id: project, ownership: 'waqf', notes: 'قرب السوق' });
    const outcome = await pushOutbox(deps());
    expect(outcome).toMatchObject({ merged: 1, rejected: 0 });
    expect(server.row('project_land', mine)).toBeUndefined();
    expect(server.row('project_land', existing)).toMatchObject({ ownership: 'waqf', notes: 'قرب السوق', version: 2 });
    expect(await store.getRow('project_land', mine)).toBeUndefined();
    expect((await store.counts()).pendingOps).toBe(0);
  });

  it('soft-deletes on the server and cancels an insert+delete that was never sent', async () => {
    const kept = uid();
    server.write('projects', kept, { name_ar: 'x' });
    await store.applyPage({ changes: [{ table: 'projects', rows: [{ ...server.row('projects', kept) }] }], meta: [] });
    const temp = uid();
    await store.mutate('projects', temp, { name_ar: 'temp', type: 'mosque' });
    await store.softDelete('projects', temp);
    await store.softDelete('projects', kept);

    const outcome = await pushOutbox(deps());
    expect(outcome.sent).toBe(1);
    expect(server.row('projects', temp)).toBeUndefined();
    expect(server.row('projects', kept)?.deleted_at).not.toBeNull();
    expect(await store.getRow('projects', kept)).toBeUndefined();
  });
});

/**
 * Acknowledging an operation must cost the same whatever the length of the queue (a field
 * team may push a thousand operations after a week offline). A counting middleware below
 * Dexie (testing/readCounter.ts) records every object and index key read from IndexedDB; the
 * assertions are about these COUNTS, which are deterministic — never about time.
 *
 * What used to grow with the queue: the engine's queue watcher (`watchQueues`, subscribed
 * while syncing) was a `liveQuery` that re-read the whole outbox after every acknowledgement
 * (O(queue) per op, quadratic per push), and every acknowledged insert scanned all rejected
 * operations for orphans waiting for that parent.
 *
 * (Wall time per ack still grows a little in these tests: fake-indexeddb removes index
 * entries by scanning the whole index on every delete/rewrite — `RecordStore.deleteByValue` —
 * which real IndexedDB B-trees do not. That is the test double, not the code.)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ackOp, markInflight, pendingOps } from './ack';
import { db, type OutboxOp } from './dexie';
import { watchQueues } from './syncPort';
import { installReadCounter } from './testing/readCounter';
import { freshDb } from './testing/factory';
import { mutate, newRow } from './write';

// Installed before the database is opened (Dexie builds its middleware stack on open).
const counter = installReadCounter(db);

const SMALL = 40;
const LARGE = 400;
const SAMPLE = 10;
/** Objects + keys one acknowledgement may read (the op, the row, a few index probes). */
const PER_ACK_BUDGET = 8;

let stopWatching: () => void = () => undefined;
afterEach(() => stopWatching());

/** `n` new projects queued as inserts. */
async function seedQueue(n: number): Promise<string[]> {
  await freshDb();
  const ids: string[] = [];
  await db.transaction('rw', db.tables, async () => {
    for (let i = 0; i < n; i++) {
      const row = newRow('projects', { name_ar: 'مسجد', type: 'mosque', lon: 39.7, lat: -5 });
      await mutate('projects', row.id, row, { insert: true });
      ids.push(row.id);
    }
  });
  return ids;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * Average reads of one acknowledgement over `ops`, the queue watcher of the sync engine
 * included (it is subscribed during every push).
 */
async function readsPerAck(
  ops: readonly OutboxOp[],
  answer: (op: OutboxOp) => Parameters<typeof ackOp>[1],
): Promise<{ total: number; byTable: Record<string, { rows: number; keys: number }> }> {
  let notified = 0;
  stopWatching();
  stopWatching = watchQueues(() => {
    notified++;
  });
  await settle();
  counter.reset();
  for (const op of ops) await ackOp(op, answer(op));
  await settle();
  const total = (counter.rows + counter.keys) / ops.length;
  const byTable = { ...counter.byTable };
  stopWatching();
  // The watcher still reports every change (the engine refreshes its counters from it).
  expect(notified).toBeGreaterThan(0);
  return { total, byTable };
}

async function claimAll(): Promise<OutboxOp[]> {
  return markInflight(await pendingOps());
}

describe('ackOp reads stay bounded as the outbox grows', () => {
  it('applied inserts: the same handful of reads with 40 or 400 queued operations', async () => {
    const results: number[] = [];
    for (const n of [SMALL, LARGE]) {
      await seedQueue(n);
      const ops = (await claimAll()).slice(0, SAMPLE);
      const { total, byTable } = await readsPerAck(ops, (op) => ({
        op_id: op.op_id,
        status: 'applied',
        version: 1,
      }));
      expect(total, JSON.stringify(byTable)).toBeLessThanOrEqual(PER_ACK_BUDGET);
      // the outbox is touched by key only: the op itself, never the rest of the queue
      expect((byTable.outbox?.rows ?? 0) / SAMPLE).toBeLessThanOrEqual(1);
      results.push(total);
    }
    expect(results[1]).toBeLessThanOrEqual(results[0]! + 0.5);
    expect(await db.outbox.count()).toBe(LARGE - SAMPLE);
  }, 60_000);

  it('updates with later edits queued: rebasing reads that row only', async () => {
    const results: number[] = [];
    for (const n of [SMALL, LARGE]) {
      const ids = await seedQueue(n);
      // Acknowledge the inserts of the sample rows first, then queue two edits for each.
      const inserts = (await claimAll()).filter((op) => ids.slice(0, SAMPLE).includes(op.row_id));
      for (const op of inserts) await ackOp(op, { op_id: op.op_id, status: 'applied', version: 1 });
      for (const id of ids.slice(0, SAMPLE)) {
        await mutate('projects', id, { capacity: 10 });
        await markInflight((await pendingOps()).filter((o) => o.row_id === id));
        await mutate('projects', id, { capacity: 20 }); // queued behind the inflight edit
      }
      const edits = (await db.outbox.where('state').equals('inflight').toArray()).filter(
        (op) => op.base_version === 1,
      );
      expect(edits).toHaveLength(SAMPLE);
      const { total, byTable } = await readsPerAck(edits, (op) => ({
        op_id: op.op_id,
        status: 'applied',
        version: 2,
      }));
      expect(total, JSON.stringify(byTable)).toBeLessThanOrEqual(PER_ACK_BUDGET);
      results.push(total);
      // the later edit was rebased onto the acknowledged version
      const later = await db.outbox.where('[table+row_id]').equals(['projects', ids[0]!]).first();
      expect(later?.base_version).toBe(2);
    }
    expect(results[1]).toBeLessThanOrEqual(results[0]! + 0.5);
  }, 60_000);

  it('rejected operations parked on the device do not make every insert ack scan them', async () => {
    const results: number[] = [];
    for (const rejectedCount of [SMALL, LARGE]) {
      await seedQueue(rejectedCount + SAMPLE);
      const ops = await claimAll();
      // Park most of the queue as rejected (other projects).
      for (const op of ops.slice(SAMPLE)) {
        await ackOp(op, { op_id: op.op_id, status: 'rejected', error: { code: 'parent_missing' } });
      }
      expect(await db.failed_ops.count()).toBe(rejectedCount);
      const { total, byTable } = await readsPerAck(ops.slice(0, SAMPLE), (op) => ({
        op_id: op.op_id,
        status: 'applied',
        version: 1,
      }));
      expect(total, JSON.stringify(byTable)).toBeLessThanOrEqual(PER_ACK_BUDGET);
      expect(byTable.failed_ops?.rows ?? 0).toBe(0);
      results.push(total);
    }
    expect(results[1]).toBeLessThanOrEqual(results[0]! + 0.5);
  }, 60_000);

  it('a child rejected for a missing parent is still requeued when that parent is acknowledged', async () => {
    await freshDb();
    const project = newRow('projects', { name_ar: 'مسجد', type: 'mosque', lon: 39.7, lat: -5 });
    await mutate('projects', project.id, project, { insert: true });
    const land = newRow('project_land', { project_id: project.id });
    await mutate('project_land', land.id, land, { insert: true });
    const [projectOp, landOp] = await claimAll();
    await ackOp(landOp!, {
      op_id: landOp!.op_id,
      status: 'rejected',
      error: { code: 'parent_missing' },
    });
    expect(await db.failed_ops.count()).toBe(1);
    await ackOp(projectOp!, { op_id: projectOp!.op_id, status: 'applied', version: 1 });
    expect(await db.failed_ops.count()).toBe(0);
    const requeued = await db.outbox.toArray();
    expect(requeued.map((o) => [o.table, o.row_id, o.state])).toEqual([
      ['project_land', land.id, 'pending'],
    ]);
  });
});

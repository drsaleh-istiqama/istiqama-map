/**
 * What the server's answer to a pushed operation does to the device (docs/contracts/sync.md
 * §4.1, §4.4, §7.4): markInflight / ackOp / requeueInflight / rebase, rejected operations.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ackOp,
  clearConflictFlag,
  discardFailedOp,
  listFailedOps,
  markInflight,
  pendingOps,
  queueCounts,
  requeueInflight,
  retryFailedOps,
  toPushOp,
} from './ack';
import { applyServerRows } from './apply';
import { db, type OutboxOp } from './dexie';
import {
  USER_A,
  USER_B,
  freshDb,
  outbox,
  serverProject,
  serverRow,
  stored,
  tid,
} from './testing/factory';
import type { PushResult, Row } from './types';
import { mutate, newRow, softDelete } from './write';

async function newProject(values: Partial<Row<'projects'>> = {}): Promise<string> {
  const row = newRow('projects', {
    name_ar: 'مسجد',
    type: 'mosque',
    lon: 39.7,
    lat: -5.1,
    ...values,
  });
  await mutate('projects', row.id, row, { insert: true });
  return row.id;
}

async function synced(values: Partial<Row<'projects'>> = {}): Promise<Row<'projects'>> {
  const p = serverProject({
    version: 3,
    capacity: 50,
    builder: 'A',
    lon: 39.7,
    lat: -5.1,
    ...values,
  });
  await applyServerRows('projects', [p]);
  return p;
}

/** Claims every pending op (as the engine does before a push). */
async function claimAll(): Promise<OutboxOp[]> {
  return markInflight(await pendingOps());
}

const answer = (op: { op_id: string }, r: Omit<PushResult, 'op_id'>): Promise<unknown> =>
  ackOp({ op_id: op.op_id, ...r });

beforeEach(async () => {
  await freshDb();
});

describe('reading and claiming the queue', () => {
  it('toPushOp is the wire shape (id, client_ts; deletes carry only a blind row’s natural key)', async () => {
    const id = await newProject();
    const [op] = await outbox();
    expect(toPushOp(op!)).toEqual({
      op_id: op!.op_id,
      table: 'projects',
      id,
      kind: 'upsert',
      base_version: 0,
      fields: op!.fields,
      client_ts: op!.created_at,
    });
    // softDelete() queues `{}` for a delete, or the natural key of a blind restricted row
    // (sync.md §4.4); toPushOp sends what was queued (blindDelete.test.ts).
    expect(toPushOp({ ...op!, kind: 'delete', fields: {} }).fields).toEqual({});
    expect(
      toPushOp({ ...op!, table: 'community_sensitive', kind: 'delete', fields: { project_id: id } })
        .fields,
    ).toEqual({ project_id: id });
  });

  it('pendingOps keeps creation order and leaves out other users’ operations', async () => {
    await newProject();
    await db.outbox.add({ ...(await outbox())[0]!, seq: undefined, op_id: tid(), user_id: USER_B });
    await newProject();
    const seqs = (await pendingOps()).map((o) => o.seq!);
    expect(seqs).toHaveLength(3);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect((await pendingOps(undefined, USER_A)).map((o) => o.user_id)).toEqual([USER_A, USER_A]);
    expect(await pendingOps(1)).toHaveLength(1);
  });

  it('markInflight claims pending ops once, counts the attempt and skips vanished ones', async () => {
    await newProject();
    await newProject();
    const ops = await outbox();
    const claimed = await markInflight([ops[0]!, ops[1]!.seq!, 999]);
    expect(claimed.map((o) => [o.state, o.attempts])).toEqual([
      ['inflight', 1],
      ['inflight', 1],
    ]);
    expect(await markInflight(ops)).toEqual([]); // already inflight
    expect(await pendingOps()).toEqual([]);
  });

  it('requeueInflight after a crash: same op_id, attempts kept, frozen for coalescing', async () => {
    const p = await synced();
    await mutate('projects', p.id, { capacity: 1 });
    await newProject();
    const before = await outbox();
    await markInflight([before[0]!]);
    expect(await requeueInflight([before[1]!.seq!])).toBe(0); // not inflight
    expect(await requeueInflight()).toBe(1);
    const after = await outbox();
    expect(after[0]).toMatchObject({
      op_id: before[0]!.op_id,
      state: 'pending',
      attempts: 1,
      fields: { capacity: 1 },
    });
    await mutate('projects', p.id, { capacity: 2 });
    expect(await outbox()).toHaveLength(3);
  });

  it('queueCounts', async () => {
    await newProject();
    const [op] = await claimAll();
    expect(await queueCounts()).toEqual({ pendingOps: 1, failedOps: 0 });
    await answer(op!, { status: 'rejected', error: { code: 'out_of_scope' } });
    expect(await queueCounts()).toEqual({ pendingOps: 0, failedOps: 1 });
  });
});

describe('ackOp — applied / merged / duplicate', () => {
  it('applied insert: op dropped, version stored, row clean', async () => {
    const id = await newProject();
    const [op] = await claimAll();
    expect(await answer(op!, { status: 'applied', version: 1 })).toEqual({
      handled: true,
      status: 'applied',
    });
    expect(await outbox()).toHaveLength(0);
    const row = await stored('projects', id);
    expect(row).toMatchObject({ version: 1 });
    expect(row!._dirty).toBeUndefined();
  });

  it('applied while a newer local edit is pending: row stays dirty, queued op rebased to the new version', async () => {
    const p = await synced();
    await mutate('projects', p.id, { capacity: 60 });
    const [first] = await claimAll();
    await mutate('projects', p.id, { builder: 'B' }); // new op on base 3
    expect((await outbox())[1]!.base_version).toBe(3);
    await answer(first!, { status: 'applied', version: 4 });
    const left = await outbox();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ base_version: 4, fields: { builder: 'B' } });
    expect(await stored('projects', p.id)).toMatchObject({
      version: 4,
      _dirty: 1,
      capacity: 60,
      builder: 'B',
    });
  });

  it('applied insert followed by a frozen-out edit on base 0: the edit is rebased to version 1', async () => {
    const id = await newProject();
    const [insert] = await claimAll();
    await mutate('projects', id, { capacity: 7 });
    await answer(insert!, { status: 'applied', version: 1 });
    expect((await outbox())[0]).toMatchObject({ base_version: 1, fields: { capacity: 7 } });
  });

  it('merged: op dropped, the version waits for the pull (foreign changes are not ours)', async () => {
    const p = await synced();
    await mutate('projects', p.id, { capacity: 60 });
    const [op] = await claimAll();
    await mutate('projects', p.id, { builder: 'B' });
    await answer(op!, { status: 'merged', version: 6 });
    const row = await stored('projects', p.id);
    expect(row).toMatchObject({ version: 3, _dirty: 1 });
    // the queued edit keeps its base: the server still compares it with the foreign changes
    expect((await outbox())[0]!.base_version).toBe(3);
    await answer((await claimAll())[0]!, { status: 'merged', version: 7 });
    expect((await stored('projects', p.id))!._dirty).toBeUndefined();
  });

  it('duplicate is treated like its original status', async () => {
    const id = await newProject();
    const [op] = await claimAll();
    expect(
      await answer(op!, { status: 'duplicate', original_status: 'applied', version: 1 }),
    ).toEqual({
      handled: true,
      status: 'applied',
    });
    expect(await stored('projects', id)).toMatchObject({ version: 1 });
  });

  it('an answer for an op that is not queued any more is ignored', async () => {
    expect(await ackOp({ op_id: tid(), status: 'applied', version: 1 })).toEqual({
      handled: false,
    });
  });

  it('accepts (op, result) as well as (result)', async () => {
    await newProject();
    const [op] = await claimAll();
    expect(await ackOp(op, { op_id: op!.op_id, status: 'applied', version: 1 })).toMatchObject({
      handled: true,
    });
  });

  it('delete acknowledged: nothing to restore', async () => {
    const p = await synced();
    await softDelete('projects', p.id);
    const [op] = await claimAll();
    await answer(op!, { status: 'applied', version: 4 });
    expect(await outbox()).toHaveLength(0);
    expect(await stored('projects', p.id)).toBeUndefined();
  });
});

describe('ackOp — conflict', () => {
  it('conflicting fields take the server values, the row is flagged; other fields stay', async () => {
    const p = await synced();
    await mutate('projects', p.id, { builder: 'Mine', capacity: 70 });
    const [op] = await claimAll();
    await answer(op!, {
      status: 'conflict',
      version: 5,
      conflict_ids: [tid()],
      conflict_fields: ['builder'],
      server_values: { builder: 'Theirs' },
    });
    const row = await stored('projects', p.id);
    expect(row).toMatchObject({
      builder: 'Theirs',
      capacity: 70,
      _conflict: 1,
      _conflict_fields: ['builder'],
    });
    expect(row!._conflict_version).toBe(5);
    expect(row!._dirty).toBeUndefined();

    // the same version arriving through pull keeps the flag; a newer one drops it
    await applyServerRows('projects', [{ ...p, version: 5, builder: 'Theirs', capacity: 70 }]);
    expect((await stored('projects', p.id))!._conflict).toBe(1);
    await applyServerRows('projects', [{ ...p, version: 6, builder: 'Theirs', capacity: 70 }]);
    expect((await stored('projects', p.id))!._conflict).toBeUndefined();
  });

  it('a location conflict arrives as geom {lon, lat}', async () => {
    const p = await synced();
    await mutate('projects', p.id, { lon: 39.8, lat: -5.2 });
    const [op] = await claimAll();
    await answer(op!, {
      status: 'conflict',
      version: 4,
      conflict_fields: ['geom'],
      server_values: { geom: { lon: 39.75, lat: -5.05 } },
    });
    expect(await stored('projects', p.id)).toMatchObject({ lon: 39.75, lat: -5.05, _conflict: 1 });
  });

  it('a field still owned by a queued edit is not overwritten', async () => {
    const p = await synced();
    await mutate('projects', p.id, { builder: 'Mine' });
    const [op] = await claimAll();
    await mutate('projects', p.id, { builder: 'Mine again' });
    await answer(op!, {
      status: 'conflict',
      version: 4,
      conflict_fields: ['builder'],
      server_values: { builder: 'X' },
    });
    expect(await stored('projects', p.id)).toMatchObject({
      builder: 'Mine again',
      _conflict: 1,
      _dirty: 1,
    });
  });

  it('clearConflictFlag removes the flag', async () => {
    const p = await synced();
    await mutate('projects', p.id, { builder: 'Mine' });
    const [op] = await claimAll();
    await answer(op!, {
      status: 'conflict',
      version: 4,
      conflict_fields: ['builder'],
      server_values: { builder: 'X' },
    });
    await clearConflictFlag('projects', p.id);
    const row = await stored('projects', p.id);
    expect(row!._conflict).toBeUndefined();
    expect(row!._conflict_fields).toBeUndefined();
  });

  it('a resolved sync_conflicts row arriving through pull drops the flag', async () => {
    const p = await synced();
    await mutate('projects', p.id, { builder: 'Mine' });
    const [op] = await claimAll();
    await answer(op!, {
      status: 'conflict',
      version: 4,
      conflict_fields: ['builder'],
      server_values: { builder: 'X' },
    });
    const conflict = serverRow('sync_conflicts', {
      table_name: 'projects',
      row_id: p.id,
      project_id: p.id,
      field: 'builder',
      state: 'open',
    });
    await applyServerRows('sync_conflicts', [conflict]);
    expect((await stored('projects', p.id))!._conflict).toBe(1);
    await applyServerRows('sync_conflicts', [
      { ...conflict, state: 'resolved_server', version: 2 },
    ]);
    expect((await stored('projects', p.id))!._conflict).toBeUndefined();
  });
});

describe('ackOp — rejected', () => {
  it('moves the op to failed_ops with the error and keeps the user data (flagged)', async () => {
    const p = await synced();
    await mutate('projects', p.id, { capacity: 99 });
    const [op] = await claimAll();
    const error = { code: 'out_of_scope', message: 'nope', sqlstate: 'PT403' };
    expect(await answer(op!, { status: 'rejected', error })).toEqual({
      handled: true,
      status: 'rejected',
    });
    expect(await outbox()).toHaveLength(0);
    const failed = await listFailedOps();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      op_id: op!.op_id,
      error,
      fields: { capacity: 99 },
      seq: op!.seq,
    });
    expect(await stored('projects', p.id)).toMatchObject({ capacity: 99, _failed: 1, _dirty: 1 });
  });

  it('retryFailedOps queues the same op again, unchanged', async () => {
    const p = await synced();
    await mutate('projects', p.id, { capacity: 99 });
    const [op] = await claimAll();
    await answer(op!, { status: 'rejected', error: { code: 'internal_error' } });
    expect(await retryFailedOps()).toBe(1);
    const [again] = await outbox();
    expect(again).toMatchObject({ op_id: op!.op_id, fields: { capacity: 99 }, state: 'pending' });
    expect(await listFailedOps()).toHaveLength(0);
    expect((await stored('projects', p.id))!._failed).toBeUndefined();
  });

  it('editing a row that needs attention folds the rejected op into a new one', async () => {
    const p = await synced();
    await mutate('projects', p.id, { capacity: 99 });
    const [op] = await claimAll();
    await answer(op!, { status: 'rejected', error: { code: 'check_violation' } });
    await mutate('projects', p.id, { capacity: 98, builder: 'B' });
    expect(await listFailedOps()).toHaveLength(0);
    const ops = await outbox();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      base_version: 3,
      fields: { capacity: 98, builder: 'B' },
      before: { capacity: 50, builder: 'A' },
    });
    expect(ops[0]!.op_id).not.toBe(op!.op_id);
    expect((await stored('projects', p.id))!._failed).toBeUndefined();
  });

  it('discard: a rejected insert removes the row, nothing silently restored for others', async () => {
    const id = await newProject();
    const [op] = await claimAll();
    await answer(op!, { status: 'rejected', error: { code: 'out_of_scope' } });
    expect(await stored('projects', id)).toBeDefined();
    await discardFailedOp((await listFailedOps())[0]!.id!);
    expect(await stored('projects', id)).toBeUndefined();
  });

  it('discard: a rejected update returns the fields to their previous values', async () => {
    const p = await synced();
    await mutate('projects', p.id, { capacity: 99 });
    const [op] = await claimAll();
    await answer(op!, { status: 'rejected', error: { code: 'out_of_scope' } });
    await discardFailedOp((await listFailedOps())[0]!.id!);
    const row = await stored('projects', p.id);
    expect(row).toMatchObject({ capacity: 50 });
    expect(row!._dirty).toBeUndefined();
    expect(row!._failed).toBeUndefined();
  });

  it('discard: a rejected delete restores the row and its children', async () => {
    const p = await synced();
    const land = serverRow('project_land', { project_id: p.id, area_m2: 10 });
    await applyServerRows('project_land', [land]);
    await softDelete('projects', p.id);
    const [op] = await claimAll();
    await answer(op!, { status: 'rejected', error: { code: 'not_owner' } });
    expect(await stored('projects', p.id)).toBeUndefined();
    await discardFailedOp((await listFailedOps())[0]!.id!);
    expect(await stored('projects', p.id)).toMatchObject({ id: p.id, capacity: 50 });
    expect(await stored('project_land', land.id)).toMatchObject({ area_m2: 10 });
  });

  it('discard of an unknown id throws', async () => {
    await expect(discardFailedOp(12345)).rejects.toMatchObject({ code: 'op_not_found' });
  });

  it('children rejected with parent_missing are requeued once the parent insert is applied', async () => {
    const pid = await newProject();
    const land = newRow('project_land', { project_id: pid, area_m2: 5 });
    await mutate('project_land', land.id, land, { insert: true });
    const [projectOp, landOp] = await claimAll();
    await answer(landOp!, { status: 'rejected', error: { code: 'parent_missing' } });
    expect(await listFailedOps()).toHaveLength(1);
    await answer(projectOp!, { status: 'applied', version: 1 });
    expect(await listFailedOps()).toHaveLength(0);
    expect((await outbox()).map((o) => o.op_id)).toEqual([landOp!.op_id]);
  });
});

describe('ackOp — natural keys', () => {
  it('row_id redirect: the local row takes the canonical id, queued edits follow without created_at', async () => {
    const pid = await newProject();
    const land = newRow('project_land', { project_id: pid, area_m2: 5 });
    await mutate('project_land', land.id, land, { insert: true });
    const ops = await claimAll();
    await answer(ops[0]!, { status: 'applied', version: 1 });
    await mutate('project_land', land.id, { owner_name: 'Waqf' });
    const canonical = tid();
    await answer(ops[1]!, { status: 'applied', version: 4, row_id: canonical });

    expect(await stored('project_land', land.id)).toBeUndefined();
    expect(await stored('project_land', canonical)).toMatchObject({
      id: canonical,
      version: 4,
      area_m2: 5,
      _dirty: 1,
    });
    const left = await outbox();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({
      row_id: canonical,
      base_version: 4,
      fields: { owner_name: 'Waqf' },
    });
    expect(left[0]!.fields).not.toHaveProperty('created_at');
  });

  it('row_id redirect when the canonical row is already on the device: the local duplicate goes', async () => {
    const pid = await newProject();
    const canonical = serverRow('project_land', { project_id: pid, area_m2: 1 });
    const land = newRow('project_land', { project_id: pid, area_m2: 5 });
    await mutate('project_land', land.id, land, { insert: true });
    await applyServerRows('project_land', [canonical]);
    const ops = await claimAll();
    await answer(ops[0]!, { status: 'applied', version: 1 });
    await answer(ops[1]!, { status: 'applied', version: 2, row_id: canonical.id });
    expect(await stored('project_land', land.id)).toBeUndefined();
    expect(await db.project_land.count()).toBe(1);
  });
});

describe('ackOp — restricted rows on a collector device', () => {
  async function sensitive(): Promise<{ id: string; pid: string }> {
    const pid = await newProject();
    const row = newRow('community_sensitive', { project_id: pid, ibadi_families: 3 });
    await mutate('community_sensitive', row.id, row, { insert: true });
    return { id: row.id, pid };
  }

  for (const status of ['applied', 'merged', 'conflict', 'duplicate'] as const) {
    it(`${status} purges the row from restricted_local`, async () => {
      const { id } = await sensitive();
      const ops = await claimAll();
      await answer(ops[1]!, {
        status,
        version: 2,
        original_status: 'applied',
        conflict_fields: ['ibadi_families'],
      });
      expect(await db.restricted_local.get(id)).toBeUndefined();
      expect(await db.community_sensitive.count()).toBe(0);
    });
  }

  it('rejected keeps it (needs attention), a queued newer edit keeps it until acknowledged too', async () => {
    const { id } = await sensitive();
    let ops = await claimAll();
    await answer(ops[1]!, { status: 'rejected', error: { code: 'out_of_scope' } });
    expect(await db.restricted_local.get(id)).toMatchObject({ row: { _failed: 1 } });

    await mutate('community_sensitive', id, { ibadi_families: 4 }); // folds the rejected op
    ops = await claimAll();
    await mutate('community_sensitive', id, { ibadi_families: 5 }); // newer edit queued
    await answer(ops[0]!, { status: 'applied', version: 1 });
    expect(await db.restricted_local.get(id)).toBeDefined();
    await answer((await claimAll())[0]!, { status: 'applied', version: 2 });
    expect(await db.restricted_local.get(id)).toBeUndefined();
  });

  it('a natural-key redirect of a restricted row purges it as well', async () => {
    const { id } = await sensitive();
    const ops = await claimAll();
    await answer(ops[1]!, { status: 'applied', version: 7, row_id: tid() });
    expect(await db.restricted_local.count()).toBe(0);
    expect(await db.restricted_local.get(id)).toBeUndefined();
  });
});

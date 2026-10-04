/**
 * Deleting a restricted row on a device without restricted capability (blind write,
 * sync.md §4.4). The server answers a blind write without `row_id`, so the device never learns
 * whether its insert created a row with its id or was applied to an existing row of the same
 * natural key: a delete sent after the insert names the row id (what the delete branch of
 * `sync_push` looks up) AND the natural key with the parent (how blind writes are addressed).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { markInflight, pendingOps, toPushOp } from './ack';
import { applyServerRows } from './apply';
import { db } from './dexie';
import { freshDb, outbox, serverProject, serverRow, tid } from './testing/factory';
import { mutate, newRow, softDelete } from './write';

let projectId: string;

beforeEach(async () => {
  await freshDb(); // a collector: no restricted capability
  const p = serverProject({ version: 2 });
  projectId = p.id;
  await applyServerRows('projects', [p]);
});

async function sendQueued(): Promise<void> {
  await markInflight(await pendingOps());
}

describe('blind delete of a restricted row', () => {
  it('community_sensitive: a delete after the insert was sent names the row id and the parent', async () => {
    const row = newRow('community_sensitive', { project_id: projectId, ibadi_families: 4 });
    await mutate('community_sensitive', row.id, row, { insert: true });
    expect(await db.restricted_local.count()).toBe(1);
    await sendQueued(); // the insert is on the wire: the server may have applied it

    await softDelete('community_sensitive', row.id);
    expect(await db.restricted_local.count()).toBe(0);
    const del = (await outbox()).find((o) => o.kind === 'delete');
    expect(del).toMatchObject({
      table: 'community_sensitive',
      row_id: row.id,
      base_version: 0,
      fields: { project_id: projectId },
    });
    expect(Object.keys(del!.fields)).toEqual(['project_id']); // no restricted values
    expect(toPushOp(del!)).toMatchObject({
      kind: 'delete',
      id: row.id,
      fields: { project_id: projectId },
    });
  });

  it('staff_compensation: the key is the assignment and the effective date', async () => {
    const staff = serverRow('project_staff', {
      id: tid(0x150),
      project_id: projectId,
      person_id: tid(0x140),
      role: 'imam',
    });
    await applyServerRows('project_staff', [staff]);
    const row = newRow('staff_compensation', {
      project_staff_id: staff.id,
      monthly_amount: 300000,
      currency: 'TZS',
      effective_from: '2026-01-01',
    });
    await mutate('staff_compensation', row.id, row, { insert: true });
    await sendQueued();

    await softDelete('staff_compensation', row.id);
    const del = (await outbox()).find((o) => o.kind === 'delete');
    expect(del?.row_id).toBe(row.id);
    expect(del?.fields).toEqual({ project_staff_id: staff.id, effective_from: '2026-01-01' });
  });

  it('an insert that never left the device and its delete cancel out', async () => {
    const row = newRow('community_sensitive', { project_id: projectId, ibadi_families: 4 });
    await mutate('community_sensitive', row.id, row, { insert: true });
    await softDelete('community_sensitive', row.id);
    expect(await outbox()).toEqual([]);
    expect(await db.restricted_local.count()).toBe(0);
  });

  it('deletes of other rows carry no fields', async () => {
    await softDelete('projects', projectId);
    const [del] = await outbox();
    expect(del).toMatchObject({ kind: 'delete', row_id: projectId, base_version: 2, fields: {} });
    expect(toPushOp(del!).fields).toEqual({});
  });

  it('a restricted reader deletes a pulled restricted row by id only (not blind)', async () => {
    await freshDb({ canSeeRestricted: true });
    const p = serverProject({ version: 1 });
    await applyServerRows('projects', [p]);
    const sensitive = serverRow('community_sensitive', { project_id: p.id, ibadi_families: 7 });
    await applyServerRows('community_sensitive', [sensitive]);
    await softDelete('community_sensitive', sensitive.id);
    const [del] = await outbox();
    expect(del).toMatchObject({ kind: 'delete', row_id: sensitive.id, fields: {} });
  });
});

/**
 * The write path (`mutate`, `softDelete`): optimistic local row + outbox coalescing exactly as
 * the "client obligations" of docs/contracts/sync.md §7 require.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ackOp, markInflight, requeueInflight } from './ack';
import { applyServerRows } from './apply';
import { putPhotoBlob } from './blobs';
import { db } from './dexie';
import { searchLocal } from './search';
import { STD_SERVER_COLUMNS, tableDef } from './tables';
import { USER_A, freshDb, outbox, serverProject, serverRow, stored, tid } from './testing/factory';
import type { Row } from './types';
import { DbError, mutate, newRow, softDelete } from './write';

const COUNTRY = '22222222-2222-4222-8222-222222222222';
const BRANCH = '33333333-3333-4333-8333-333333333333';

async function insertProject(values: Partial<Row<'projects'>> = {}): Promise<string> {
  const row = newRow('projects', {
    name_ar: 'مسجد النور',
    name_latin: 'Masjid An-Nur',
    type: 'mosque',
    country_id: COUNTRY,
    branch_id: BRANCH,
    lon: 39.75,
    lat: -5.05,
    ...values,
  });
  await mutate('projects', row.id, row, { insert: true });
  return row.id;
}

/** A project as the server has it (version 3), already on the device. */
async function syncedProject(values: Partial<Row<'projects'>> = {}): Promise<Row<'projects'>> {
  const p = serverProject({
    version: 3,
    country_id: COUNTRY,
    branch_id: BRANCH,
    lon: 39.7,
    lat: -5.1,
    ...values,
  });
  await applyServerRows('projects', [p]);
  return p;
}

beforeEach(async () => {
  await freshDb();
});

describe('mutate — insert', () => {
  it('writes the optimistic row (_dirty, version 0, creator) and one insert op with created_at', async () => {
    const id = await insertProject({ capacity: 120 });
    const row = await stored('projects', id);
    expect(row).toMatchObject({
      id,
      version: 0,
      _dirty: 1,
      created_by: USER_A,
      record_state: 'draft',
      capacity: 120,
    });

    const ops = await outbox();
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op).toMatchObject({
      table: 'projects',
      row_id: id,
      kind: 'upsert',
      base_version: 0,
      state: 'pending',
      attempts: 0,
    });
    expect(op.user_id).toBe(USER_A);
    expect(op.project_id).toBe(id);
    expect(op.fields).toMatchObject({
      name_ar: 'مسجد النور',
      type: 'mosque',
      lon: 39.75,
      lat: -5.05,
      capacity: 120,
    });
    // the offline entry time travels on insert only, as UTC with Z (sync.md §4.2 rule 4, §7.5)
    expect(op.fields.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(op.fields.created_at).toBe(row!.created_at);
  });

  it('never puts server-managed columns into the op or the local row', async () => {
    const row = newRow('projects', { name_ar: 'مدرسة', type: 'school' });
    await mutate(
      'projects',
      row.id,
      {
        ...row,
        code: 'TZ-XX-000001',
        completeness: 99,
        search_norm: 'x',
        reviewed_by: USER_A,
        reviewed_at: '2026-01-01T00:00:00Z',
        import_batch_id: tid(),
        version: 7,
        created_by: 'someone',
        updated_at: '2020-01-01T00:00:00Z',
        deleted_at: '2020-01-01T00:00:00Z',
      },
      { insert: true },
    );
    const op = (await outbox())[0]!;
    const managed = [...STD_SERVER_COLUMNS, ...tableDef('projects').protectedCols].filter(
      (c) => c !== 'created_at',
    );
    for (const c of managed) expect(op.fields).not.toHaveProperty(c);
    const local = await stored('projects', row.id);
    expect(local).toMatchObject({
      code: null,
      completeness: 0,
      search_norm: '',
      version: 0,
      deleted_at: null,
    });
    expect(local!.created_by).toBe(USER_A);
  });

  it('insert + later updates collapse into ONE insert carrying the final values', async () => {
    const id = await insertProject({ builder: 'Al Khair' });
    await mutate('projects', id, { name_ar: 'مسجد الهدى', capacity: 200 });
    await mutate('projects', id, { capacity: 250, builder: null });
    const ops = await outbox();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.base_version).toBe(0);
    expect(ops[0]!.fields).toMatchObject({ name_ar: 'مسجد الهدى', capacity: 250 });
    expect(ops[0]!.fields).toHaveProperty('created_at');
    // a cleared field is simply not sent on insert
    expect(ops[0]!.fields).not.toHaveProperty('builder');
    expect(await stored('projects', id)).toMatchObject({
      name_ar: 'مسجد الهدى',
      capacity: 250,
      builder: null,
    });
  });

  it('an insert of an id that exists is an update', async () => {
    const id = await insertProject();
    await mutate('projects', id, { capacity: 10 }, { insert: true });
    expect(await outbox()).toHaveLength(1);
  });

  it('fills the database defaults of NOT NULL columns before the first sync', async () => {
    const pid = await insertProject();
    const m = newRow('project_maintenance', { project_id: pid, description: 'سقف' });
    await mutate('project_maintenance', m.id, m, { insert: true });
    expect(await stored('project_maintenance', m.id)).toMatchObject({
      priority: 'medium',
      state: 'open',
    });
    expect((await stored('project_maintenance', m.id))!.reported_on).toMatch(/^\d{4}-\d\d-\d\d$/);
  });
});

describe('mutate — updates of synced rows', () => {
  it('sends only the changed fields against the version the edit was made on', async () => {
    const p = await syncedProject({ name_ar: 'مسجد', capacity: 50, builder: 'A' });
    await mutate('projects', p.id, { name_ar: 'مسجد', capacity: 60, builder: 'A' });
    const ops = await outbox();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'upsert', base_version: 3, fields: { capacity: 60 } });
    expect(ops[0]!.fields).not.toHaveProperty('created_at');
    expect(ops[0]!.before).toEqual({ capacity: 50 });
    expect(await stored('projects', p.id)).toMatchObject({ capacity: 60, version: 3, _dirty: 1 });
  });

  it('a patch that changes nothing queues nothing and leaves the row clean', async () => {
    const p = await syncedProject({ capacity: 50 });
    await mutate('projects', p.id, { capacity: 50, name_ar: p.name_ar });
    expect(await outbox()).toHaveLength(0);
    expect((await stored('projects', p.id))!._dirty).toBeUndefined();
  });

  it('consecutive pending updates union their fields and keep the EARLIEST base_version', async () => {
    const p = await syncedProject({ capacity: 50, builder: 'A' });
    await mutate('projects', p.id, { capacity: 60 });
    // a pull delivers a newer server version meanwhile (another device changed the row)
    await applyServerRows('projects', [{ ...p, version: 5, builder: 'B' }]);
    expect(await stored('projects', p.id)).toMatchObject({
      version: 5,
      builder: 'B',
      capacity: 60,
      _dirty: 1,
    });
    await mutate('projects', p.id, { builder: 'C' });
    const ops = await outbox();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.base_version).toBe(3);
    expect(ops[0]!.fields).toEqual({ capacity: 60, builder: 'C' });
    expect(ops[0]!.before).toEqual({ capacity: 50, builder: 'B' });
  });

  it('never changes an op that was handed to the transport: later edits get a new op', async () => {
    const p = await syncedProject({ capacity: 50 });
    await mutate('projects', p.id, { capacity: 60 });
    const [first] = await outbox();
    await markInflight([first!]);
    await mutate('projects', p.id, { capacity: 70 });
    const ops = await outbox();
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({
      op_id: first!.op_id,
      state: 'inflight',
      fields: { capacity: 60 },
    });
    expect(ops[1]).toMatchObject({ state: 'pending', base_version: 3, fields: { capacity: 70 } });
    expect(ops[1]!.op_id).not.toBe(first!.op_id);

    // after a failed request the first op is pending again, but it was sent once: still frozen
    await requeueInflight();
    await mutate('projects', p.id, { builder: 'X' });
    const after = await outbox();
    expect(after[0]).toMatchObject({ state: 'pending', attempts: 1, fields: { capacity: 60 } });
    expect(after[1]!.fields).toEqual({ capacity: 70, builder: 'X' });
  });

  it('an insert that was sent is frozen too: the next edit is an update on base 0', async () => {
    const id = await insertProject();
    await markInflight(await outbox());
    await mutate('projects', id, { capacity: 9 });
    const ops = await outbox();
    expect(ops).toHaveLength(2);
    expect(ops[1]).toMatchObject({ base_version: 0, fields: { capacity: 9 } });
    expect(ops[1]!.fields).not.toHaveProperty('created_at');
  });

  it('never folds two record_state transitions of a synced project into one op', async () => {
    const p = await syncedProject({ record_state: 'returned' });
    await mutate('projects', p.id, { name_ar: 'مسجد جديد' });
    await mutate('projects', p.id, { record_state: 'submitted' }); // folds into the edit
    await mutate('projects', p.id, { record_state: 'approved' }); // second transition: own op
    const ops = await outbox();
    expect(ops.map((o) => o.fields)).toEqual([
      { name_ar: 'مسجد جديد', record_state: 'submitted' },
      { record_state: 'approved' },
    ]);
    expect(ops[1]!.base_version).toBe(3);
  });

  it('lon and lat always travel together', async () => {
    const p = await syncedProject({ lon: 39.7, lat: -5.1 });
    await mutate('projects', p.id, { lon: 39.71 });
    expect((await outbox())[0]!.fields).toEqual({ lon: 39.71, lat: -5.1 });
  });

  it('rejects invalid coordinates and leaves nothing behind', async () => {
    const p = await syncedProject();
    await expect(mutate('projects', p.id, { lon: 200, lat: 0 })).rejects.toMatchObject({
      code: 'invalid_coordinates',
    });
    await expect(mutate('projects', p.id, { lat: 95 })).rejects.toBeInstanceOf(DbError);
    const row = newRow('projects', { name_ar: 'x', type: 'mosque', lon: 39 });
    await expect(mutate('projects', row.id, row, { insert: true })).rejects.toMatchObject({
      code: 'invalid_coordinates',
    });
    expect(await outbox()).toHaveLength(0);
    expect(await stored('projects', row.id)).toBeUndefined();
    expect(await stored('projects', p.id)).toMatchObject({ lon: 39.7, lat: -5.1 });
  });

  it('refuses parent-link changes, unknown rows and tables that cannot be written', async () => {
    const pid = await insertProject();
    const land = newRow('project_land', { project_id: pid, area_m2: 100 });
    await mutate('project_land', land.id, land, { insert: true });
    await expect(mutate('project_land', land.id, { project_id: tid() })).rejects.toMatchObject({
      code: 'immutable_field',
    });
    await expect(mutate('projects', tid(), { capacity: 1 })).rejects.toMatchObject({
      code: 'row_not_found',
    });
    await expect(
      mutate('countries', tid(), { name_ar: 'x' }, { insert: true }),
    ).rejects.toMatchObject({
      code: 'table_not_writable',
    });
    await expect(softDelete('countries', tid())).rejects.toMatchObject({
      code: 'table_not_writable',
    });
  });

  it('notifications: only read_at is writable, and only as an update', async () => {
    const n = serverRow('notifications', {
      user_id: USER_A,
      kind: 'export.ready',
      payload: { a: 1 },
    });
    await applyServerRows('notifications', [n]);
    await mutate('notifications', n.id, {
      read_at: '2026-10-04T08:00:00.000Z',
      kind: 'hacked',
    } as Partial<Row<'notifications'>>);
    const ops = await outbox();
    expect(ops[0]!.fields).toEqual({ read_at: '2026-10-04T08:00:00.000Z' });
    expect(await stored('notifications', n.id)).toMatchObject({ kind: 'export.ready' });
    await expect(
      mutate('notifications', tid(), { read_at: null }, { insert: true }),
    ).rejects.toMatchObject({
      code: 'table_not_writable',
    });
  });

  it('an edit that points to a row created later in the queue gets its own op behind it', async () => {
    const p = await syncedProject();
    await mutate('projects', p.id, { capacity: 5 });
    const loc = newRow('localities', { country_id: COUNTRY, name_ar: 'ويتي' });
    await mutate('localities', loc.id, loc, { insert: true });
    await mutate('projects', p.id, { locality_id: loc.id });
    const ops = await outbox();
    expect(ops.map((o) => [o.table, Object.keys(o.fields).sort().join(',')])).toEqual([
      ['projects', 'capacity'],
      ['localities', 'country_id,created_at,name_ar,status'],
      ['projects', 'locality_id'],
    ]);
  });

  it('keeps the search tokens current', async () => {
    const id = await insertProject({ name_ar: 'مسجد الفلاح', name_latin: null });
    expect((await stored('projects', id))!._tokens).toEqual(
      expect.arrayContaining(['مسجد', 'الفلاح', 'فلاح']),
    );
    await mutate('projects', id, { name_ar: 'مدرسة الرحمة', name_latin: 'Shule ya Rehema' });
    const tokens = (await stored('projects', id))!._tokens as string[];
    expect(tokens).toEqual(expect.arrayContaining(['مدرسه', 'الرحمه', 'رحمه', 'shule', 'rehema']));
    expect(tokens).not.toContain('الفلاح');
    expect((await searchLocal('رحمة')).map((h) => h.id)).toEqual([id]);
    expect(await searchLocal('فلاح')).toEqual([]);
  });
});

describe('softDelete', () => {
  it('a row that never left the device disappears together with its queued ops', async () => {
    const id = await insertProject();
    await mutate('projects', id, { capacity: 3 });
    const land = newRow('project_land', { project_id: id, area_m2: 10 });
    await mutate('project_land', land.id, land, { insert: true });
    await softDelete('projects', id);
    expect(await outbox()).toHaveLength(0);
    expect(await stored('projects', id)).toBeUndefined();
    expect(await stored('project_land', land.id)).toBeUndefined();
  });

  it('an insert that was already sent is followed by a delete op', async () => {
    const id = await insertProject();
    await markInflight(await outbox());
    await softDelete('projects', id);
    const ops = await outbox();
    expect(ops.map((o) => [o.kind, o.base_version])).toEqual([
      ['upsert', 0],
      ['delete', 0],
    ]);
    expect(await stored('projects', id)).toBeUndefined();
  });

  it('a synced project: delete op on its version, children dropped locally and kept in the snapshot', async () => {
    const p = await syncedProject();
    const land = serverRow('project_land', { project_id: p.id });
    const photo = serverRow('project_photos', {
      project_id: p.id,
      storage_path_full: 'f',
      storage_path_thumb: 't',
    });
    await applyServerRows('project_land', [land]);
    await applyServerRows('project_photos', [photo]);
    await putPhotoBlob(photo.id, 'thumb', new Blob(['x']), { projectId: p.id });
    await softDelete('projects', p.id);
    const ops = await outbox();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'delete', base_version: 3, fields: {} });
    expect(ops[0]!.snapshot!.row.id).toBe(p.id);
    expect(ops[0]!.snapshot!.children!.project_land!.map((r) => r.id)).toEqual([land.id]);
    expect(await stored('project_land', land.id)).toBeUndefined();
    expect(await db.photo_blobs.count()).toBe(0);
    expect(await stored('projects', p.id)).toBeUndefined();
  });

  it('unknown ids are ignored', async () => {
    await softDelete('projects', tid());
    expect(await outbox()).toHaveLength(0);
  });
});

describe('restricted tables', () => {
  async function staffOf(projectId: string): Promise<string> {
    const person = newRow('persons', { name_ar: 'سالم' });
    await mutate('persons', person.id, person, { insert: true });
    const staff = newRow('project_staff', {
      project_id: projectId,
      person_id: person.id,
      role: 'imam',
    });
    await mutate('project_staff', staff.id, staff, { insert: true });
    return staff.id;
  }

  it('without restricted capability rows live only in restricted_local and are queued the same way', async () => {
    const pid = await insertProject();
    const staffId = await staffOf(pid);
    const comp = newRow('staff_compensation', {
      project_staff_id: staffId,
      monthly_amount: 150000,
      currency: 'TZS',
    });
    await mutate('staff_compensation', comp.id, comp, { insert: true });
    const sens = newRow('community_sensitive', { project_id: pid, ibadi_families: 4 });
    await mutate('community_sensitive', sens.id, sens, { insert: true });

    expect(await db.staff_compensation.count()).toBe(0);
    expect(await db.community_sensitive.count()).toBe(0);
    const local = await db.restricted_local.orderBy('id').toArray();
    expect(local.map((r) => r.table).sort()).toEqual(['community_sensitive', 'staff_compensation']);
    expect(local.find((r) => r.table === 'staff_compensation')).toMatchObject({
      parent_id: staffId,
      project_id: pid,
    });

    // edits stay there too
    await mutate('staff_compensation', comp.id, { monthly_amount: 160000 });
    expect((await db.restricted_local.get(comp.id))!.row).toMatchObject({ monthly_amount: 160000 });
    const ops = await outbox();
    const compOps = ops.filter((o) => o.table === 'staff_compensation');
    expect(compOps).toHaveLength(1);
    expect(compOps[0]!.fields).toMatchObject({
      monthly_amount: 160000,
      currency: 'TZS',
      project_staff_id: staffId,
    });
    expect(compOps[0]!.project_id).toBe(pid);
  });

  it('with restricted capability (manager at aal2) rows go to the normal store', async () => {
    await freshDb({ canSeeRestricted: true });
    const pid = await insertProject();
    const sens = newRow('community_sensitive', { project_id: pid, omani_families: 2 });
    await mutate('community_sensitive', sens.id, sens, { insert: true });
    expect(await db.community_sensitive.count()).toBe(1);
    expect(await db.restricted_local.count()).toBe(0);
  });

  it('blind write: an edit made while the insert is in flight queues the COMPLETE row, insert-shaped (sync.md §4.4)', async () => {
    const pid = await insertProject();
    const sens = newRow('community_sensitive', {
      project_id: pid,
      ibadi_families: 4,
      omani_families: 2,
    });
    await mutate('community_sensitive', sens.id, sens, { insert: true });
    const insertOp = (await outbox()).find((o) => o.table === 'community_sensitive')!;
    await markInflight([insertOp]);

    await mutate('community_sensitive', sens.id, { ibadi_families: 5, omani_families: null });
    const ops = (await outbox()).filter((o) => o.table === 'community_sensitive');
    expect(ops).toHaveLength(2);
    const followUp = ops[1]!;
    expect(followUp.base_version).toBe(0);
    expect(followUp.before).toBeUndefined();
    expect(followUp.fields).toMatchObject({
      project_id: pid, // the parent: blind upserts are addressed by natural key
      ibadi_families: 5,
      omani_families: null, // cleared explicitly: the op may land on the row the first op made
      created_at: insertOp.fields.created_at,
    });

    // A further edit before the follow-up is sent folds into it, still complete.
    await mutate('community_sensitive', sens.id, { omani_teacher_pct: 10 });
    const again = (await outbox()).filter((o) => o.table === 'community_sensitive');
    expect(again).toHaveLength(2);
    expect(again[1]!.fields).toMatchObject({
      project_id: pid,
      ibadi_families: 5,
      omani_teacher_pct: 10,
    });

    // Constant answers (applied, version null): the row leaves the device after the last one.
    await ackOp({ op_id: insertOp.op_id, status: 'applied', version: null });
    expect(await db.restricted_local.get(sens.id)).toBeDefined();
    await markInflight([again[1]!]);
    await ackOp({ op_id: again[1]!.op_id, status: 'applied', version: null });
    expect(await db.restricted_local.count()).toBe(0);
  });

  it('is purged once acknowledged', async () => {
    const pid = await insertProject();
    const sens = newRow('community_sensitive', { project_id: pid, ibadi_families: 4 });
    await mutate('community_sensitive', sens.id, sens, { insert: true });
    const op = (await outbox()).find((o) => o.table === 'community_sensitive')!;
    await ackOp({ op_id: op.op_id, status: 'applied', version: 1 });
    expect(await db.restricted_local.count()).toBe(0);
  });
});

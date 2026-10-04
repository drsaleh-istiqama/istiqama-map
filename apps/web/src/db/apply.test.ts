/**
 * The read path used by pull (docs/contracts/sync.md §5, §7.8–7.11): applyServerRows /
 * applyPage, tombstones, `gone`, merge with pending local work, scope reset, wipe.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ackOp, listFailedOps, markInflight, pendingOps } from './ack';
import { applyPage, applyServerRows, resetScopedData, wipeAllLocalData } from './apply';
import { photoBlob, putPhotoBlob } from './blobs';
import { db } from './dexie';
import { drafts, getMeta, setMeta } from './meta';
import { freshDb, outbox, serverProject, serverRow, stored, tid } from './testing/factory';
import type { Row } from './types';
import { mutate, newRow, softDelete } from './write';

beforeEach(async () => {
  await freshDb();
});

describe('applyServerRows', () => {
  it('stores rows with their derived index fields; applying twice is harmless', async () => {
    const p = serverProject({
      name_ar: 'مسجد التقوى',
      name_latin: 'Masjid Taqwa',
      code: 'TZ-PN-000123',
      lon: 39.7,
      lat: -5,
    });
    expect(await applyServerRows('projects', [p])).toEqual({ upserted: 1, removed: 0, skipped: 0 });
    await applyServerRows('projects', [p]);
    expect(await db.projects.count()).toBe(1);
    const row = await stored('projects', p.id);
    // normalised like private.norm(): alef maksura folds to yeh
    expect(row!._tokens).toEqual(
      expect.arrayContaining([
        'مسجد',
        'التقوي',
        'تقوي',
        'masjid',
        'taqwa',
        'tz',
        'pn',
        '000123',
        '123',
      ]),
    );
    expect(typeof row!._cell).toBe('number');
    expect(row!._dirty).toBeUndefined();
  });

  it('a tombstone removes the row; a project tombstone removes its children', async () => {
    const p = serverProject();
    const land = serverRow('project_land', { project_id: p.id });
    const staff = serverRow('project_staff', { project_id: p.id, person_id: tid(), role: 'imam' });
    const comp = serverRow('staff_compensation', {
      project_staff_id: staff.id,
      monthly_amount: 1,
      currency: 'TZS',
      effective_from: '2026-01-01',
    });
    await applyServerRows('projects', [p]);
    await applyServerRows('project_land', [land]);
    await applyServerRows('project_staff', [staff]);
    await applyServerRows('staff_compensation', [comp]);
    const stats = await applyServerRows('projects', [
      { ...p, version: 2, deleted_at: '2026-10-01T00:00:00Z' },
    ]);
    expect(stats.removed).toBe(1);
    expect(await db.projects.count()).toBe(0);
    expect(await db.project_land.count()).toBe(0);
    expect(await db.project_staff.count()).toBe(0);
    expect(await db.staff_compensation.count()).toBe(0);
  });

  it('`gone` ids are removed with their children (project left the scope)', async () => {
    const p = serverProject();
    const keep = serverProject();
    const photo = serverRow('project_photos', {
      project_id: p.id,
      storage_path_full: 'f',
      storage_path_thumb: 't',
    });
    await applyServerRows('projects', [p, keep]);
    await applyServerRows('project_photos', [photo]);
    await applyServerRows('projects', [], [p.id, tid()]);
    expect((await db.projects.toArray()).map((r) => r.id)).toEqual([keep.id]);
    expect(await db.project_photos.count()).toBe(0);
  });

  it('a server row for a row with pending ops = server row + pending fields on top, still dirty', async () => {
    const p = serverProject({ version: 3, capacity: 50, builder: 'A', status: 'active' });
    await applyServerRows('projects', [p]);
    await mutate('projects', p.id, { capacity: 60 });
    await applyServerRows('projects', [
      { ...p, version: 4, builder: 'B', status: 'maintenance', capacity: 55 },
    ]);
    const row = await stored('projects', p.id);
    expect(row).toMatchObject({
      version: 4,
      builder: 'B',
      status: 'maintenance',
      capacity: 60,
      _dirty: 1,
    });
    // the queued op is not rebased by a pull (the edit was made on version 3)
    expect((await outbox())[0]!.base_version).toBe(3);
  });

  it('the pending fields of an inflight op and of a rejected op are kept on top as well', async () => {
    const p = serverProject({ version: 3, capacity: 50, builder: 'A' });
    await applyServerRows('projects', [p]);
    await mutate('projects', p.id, { capacity: 60 });
    const [op] = await markInflight(await pendingOps());
    await ackOp({ op_id: op!.op_id, status: 'rejected', error: { code: 'check_violation' } });
    await applyServerRows('projects', [{ ...p, version: 4, capacity: 1 }]);
    expect(await stored('projects', p.id)).toMatchObject({
      capacity: 60,
      version: 4,
      _dirty: 1,
      _failed: 1,
    });
    expect(await listFailedOps()).toHaveLength(1);
  });

  it('never resurrects a row the user deleted and has not pushed yet', async () => {
    const p = serverProject({ version: 3 });
    await applyServerRows('projects', [p]);
    await softDelete('projects', p.id);
    const stats = await applyServerRows('projects', [{ ...p, version: 4, name_ar: 'جديد' }]);
    expect(stats).toEqual({ upserted: 0, removed: 0, skipped: 1 });
    expect(await stored('projects', p.id)).toBeUndefined();
    // the newest server copy replaces the one kept for a possible undo
    expect((await outbox())[0]!.snapshot!.row).toMatchObject({ version: 4, name_ar: 'جديد' });
  });

  it('writes large inputs in chunks (more than one transaction) without losing rows', async () => {
    const rows = Array.from({ length: 1234 }, (_, i) =>
      serverRow('donors', { name_ar: `متبرع ${i}` }),
    );
    expect((await applyServerRows('donors', rows)).upserted).toBe(1234);
    expect(await db.donors.count()).toBe(1234);
  });

  it('children arriving before or after their project keep the project state current', async () => {
    const p = serverProject({ completeness: 0 });
    const m = serverRow('project_maintenance', {
      project_id: p.id,
      description: 'x',
      state: 'open',
      priority: 'high',
    });
    const photo = serverRow('project_photos', {
      project_id: p.id,
      storage_path_full: 'f',
      storage_path_thumb: `projects/TZ/${p.id}/a_thumb.webp`,
      is_cover: true,
    });
    await applyServerRows('project_maintenance', [m]); // child first (other round)
    await applyServerRows('projects', [p]);
    await applyServerRows('project_photos', [photo]);
    const row = await stored('projects', p.id);
    expect(row).toMatchObject({ _om: 1, _cover: photo.id, _cover_thumb: photo.storage_path_thumb });
    await applyServerRows('project_maintenance', [{ ...m, version: 2, state: 'done' }]);
    expect((await stored('projects', p.id))!._om).toBeUndefined();
  });

  it('notifications get the unread flag', async () => {
    const n = serverRow('notifications', { user_id: tid(), kind: 'export.ready', payload: {} });
    await applyServerRows('notifications', [n]);
    expect((await stored('notifications', n.id))!._unread).toBe(1);
    await applyServerRows('notifications', [{ ...n, version: 2, read_at: '2026-10-04T00:00:00Z' }]);
    expect((await stored('notifications', n.id))!._unread).toBeUndefined();
  });
});

describe('applyPage', () => {
  it('writes every table of a page and its meta entries in one transaction; unknown tables are ignored', async () => {
    const donor = serverRow('donors', { name_ar: 'متبرع' });
    const p = serverProject();
    const link = serverRow('project_donors', { project_id: p.id, donor_id: donor.id });
    await applyPage({
      changes: [
        { table: 'donors', rows: [donor] },
        { table: 'projects', rows: [p] },
        { table: 'project_donors', rows: [link] },
        { table: 'table_of_the_future', rows: [{ id: 'x' }] },
      ],
      meta: [{ key: 'pull_cursor', value: { lo: 1 } }],
    });
    expect(await db.donors.count()).toBe(1);
    expect(await db.project_donors.count()).toBe(1);
    expect(await getMeta('pull_cursor')).toEqual({ lo: 1 });
  });

  it('a failing page stores neither its rows nor its cursor', async () => {
    const p = serverProject();
    await expect(
      applyPage({
        changes: [
          { table: 'projects', rows: [p, { id: undefined } as unknown as Row<'projects'>] },
        ],
        meta: [{ key: 'pull_cursor', value: { lo: 2 } }],
      }),
    ).rejects.toThrow();
    expect(await db.projects.count()).toBe(0);
    expect(await getMeta('pull_cursor')).toBeUndefined();
  });

  it('a donor row may arrive again without a version change (sync.md 5.5): idempotent upsert', async () => {
    const donor = serverRow('donors', { name_ar: 'متبرع', version: 2 });
    await applyPage({ changes: [{ table: 'donors', rows: [donor] }] });
    await applyPage({ changes: [{ table: 'donors', rows: [donor] }] });
    expect(await db.donors.count()).toBe(1);
  });
});

describe('resetScopedData — scope change never loses unsent work', () => {
  it('wipes clean synced rows, keeps dirty rows, queues, drafts, blobs and restricted_local', async () => {
    const clean = serverProject();
    const edited = serverProject({ version: 2, capacity: 1 });
    await applyServerRows('projects', [clean, edited]);
    await applyServerRows('countries', [
      serverRow('countries', { iso2: 'TZ', name_ar: 'تنزانيا', name_en: 'Tanzania' }),
    ]);
    await mutate('projects', edited.id, { capacity: 2 });
    const created = newRow('projects', { name_ar: 'جديد', type: 'school' });
    await mutate('projects', created.id, created, { insert: true });
    const sens = newRow('community_sensitive', { project_id: created.id, ibadi_families: 1 });
    await mutate('community_sensitive', sens.id, sens, { insert: true });
    await softDelete('projects', clean.id); // a pending delete
    await drafts.put('project-form:new', { name: 'draft' });
    await putPhotoBlob(tid(), 'full', new Blob(['jpeg']), { projectId: created.id });
    await setMeta('x', 1);
    const opsBefore = await outbox();

    const summary = await resetScopedData();
    expect(summary).toEqual({
      keptDirtyRows: 2,
      movedRestricted: 0,
      keptOps: opsBefore.length,
      keptFailedOps: 0,
    });
    expect(await db.countries.count()).toBe(0);
    expect((await db.projects.toArray()).map((r) => r.id).sort()).toEqual(
      [edited.id, created.id].sort(),
    );
    expect(await stored('projects', edited.id)).toMatchObject({ capacity: 2, _dirty: 1 });
    expect(await outbox()).toEqual(opsBefore);
    expect(await drafts.get('project-form:new')).toEqual({ name: 'draft' });
    expect(await db.photo_blobs.count()).toBe(1);
    expect(await db.restricted_local.get(sens.id)).toBeDefined();
    expect(await getMeta('x')).toBe(1);

    // the fresh pull merges under the pending fields as usual
    await applyServerRows('projects', [{ ...edited, version: 3, capacity: 9, builder: 'B' }]);
    expect(await stored('projects', edited.id)).toMatchObject({
      version: 3,
      capacity: 2,
      builder: 'B',
      _dirty: 1,
    });
    // the locally deleted project stays deleted
    await applyServerRows('projects', [clean]);
    expect(await stored('projects', clean.id)).toBeUndefined();
  });

  it('dirty rows of restricted tables (manager device) move to restricted_local', async () => {
    await freshDb({ canSeeRestricted: true });
    const p = serverProject();
    await applyServerRows('projects', [p]);
    const sens = serverRow('community_sensitive', { project_id: p.id, ibadi_families: 1 });
    await applyServerRows('community_sensitive', [sens]);
    await mutate('community_sensitive', sens.id, { ibadi_families: 2 });
    const summary = await resetScopedData();
    expect(summary.movedRestricted).toBe(1);
    expect(await db.community_sensitive.count()).toBe(0);
    expect(await db.restricted_local.get(sens.id)).toMatchObject({
      table: 'community_sensitive',
      project_id: p.id,
    });
  });
});

describe('wipeAllLocalData', () => {
  it('removes everything (revoked session / device)', async () => {
    await applyServerRows('projects', [serverProject()]);
    await drafts.put('k', 1);
    await putPhotoBlob(tid(), 'thumb', new Blob(['x']));
    await wipeAllLocalData();
    for (const t of db.tables) expect(await t.count()).toBe(0);
    expect(await photoBlob('nope', 'thumb')).toBeUndefined();
  });
});

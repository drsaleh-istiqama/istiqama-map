/**
 * Key/value stores: meta, drafts, local session, cached app settings; photo blobs; the
 * engine-facing `syncPort`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyServerRows } from './apply';
import {
  dropPhotoBlob,
  dropPhotoBlobs,
  photoBlob,
  photoBlobBytes,
  pruneOrphanPhotoBlobs,
  putPhotoBlob,
} from './blobs';
import { db } from './dexie';
import {
  DEFAULT_SETTINGS,
  deleteMeta,
  drafts,
  getAppSetting,
  getLocalSession,
  getMeta,
  getNumberSetting,
  listMeta,
  resetMetaCaches,
  saveAppSettings,
  setLocalSession,
  setMeta,
  updateMeta,
} from './meta';
import { syncPort } from './syncPort';
import { TABLE_NAMES } from './tables';
import { USER_A, freshDb, outbox, serverProject, serverRow, tid } from './testing/factory';
import { mutate, newRow } from './write';

beforeEach(async () => {
  await freshDb();
});

describe('meta', () => {
  it('get / set / delete / list by prefix / atomic update', async () => {
    expect(await getMeta('pull:cursor')).toBeUndefined();
    await setMeta('pull:cursor', { lo: 1 });
    await setMeta('pull:epoch', 'abc');
    await setMeta('other', 1);
    expect(await getMeta('pull:cursor')).toEqual({ lo: 1 });
    expect(await listMeta('pull:')).toEqual([
      { key: 'pull:cursor', value: { lo: 1 } },
      { key: 'pull:epoch', value: 'abc' },
    ]);
    expect(await updateMeta<number>('n', (v) => (v ?? 0) + 1)).toBe(1);
    expect(await updateMeta<number>('n', (v) => (v ?? 0) + 1)).toBe(2);
    await updateMeta('n', () => undefined);
    expect(await getMeta('n')).toBeUndefined();
    await deleteMeta('other');
    expect(await getMeta('other')).toBeUndefined();
  });
});

describe('drafts', () => {
  it('put / get / list (newest first) / remove', async () => {
    await drafts.put('project-form:new', { name_ar: 'مسودة' });
    await new Promise((r) => setTimeout(r, 2));
    await drafts.put('project-form:abc', { name_ar: 'ثانية' });
    expect(await drafts.get('project-form:new')).toEqual({ name_ar: 'مسودة' });
    const list = await drafts.list();
    expect(list.map((d) => d.key)).toEqual(['project-form:abc', 'project-form:new']);
    expect(list[0]!.updatedAt).toBeGreaterThanOrEqual(list[1]!.updatedAt);
    await drafts.remove('project-form:new');
    expect(await drafts.get('project-form:new')).toBeUndefined();
  });
});

describe('local session', () => {
  it('survives the in-memory cache and defaults to the safe values', async () => {
    expect(await getLocalSession()).toEqual({ userId: USER_A, canSeeRestricted: false });
    await setLocalSession({ canSeeRestricted: true });
    resetMetaCaches();
    expect(await getLocalSession()).toEqual({ userId: USER_A, canSeeRestricted: true });
    await db.meta.clear();
    resetMetaCaches();
    expect(await getLocalSession()).toEqual({ userId: null, canSeeRestricted: false });
  });
});

describe('app settings', () => {
  it('cached server values first, then the defaults of migration 0063, then the fallback', async () => {
    expect(await getAppSetting('duplicates.radius_m', 1)).toBe(150);
    expect(await getAppSetting('unknown.key', 'x')).toBe('x');
    await saveAppSettings([
      { key: 'duplicates.radius_m', value: 200 },
      { key: 'list.page_size', value: null },
    ]);
    resetMetaCaches();
    expect(await getAppSetting('duplicates.radius_m', 1)).toBe(200);
    expect(await getAppSetting('list.page_size', 1)).toBe(DEFAULT_SETTINGS['list.page_size']);
  });

  it('numeric settings are clamped; non-numbers give the default', async () => {
    await saveAppSettings([
      { key: 'persons.name_similarity', value: 0.1 },
      { key: 'duplicates.radius_m', value: 'far' },
    ]);
    expect(await getNumberSetting('persons.name_similarity', 0.6, 0.4, 1)).toBe(0.4);
    expect(await getNumberSetting('duplicates.radius_m', 150, 1, 5000)).toBe(150);
  });
});

describe('photo blobs', () => {
  it('put / get / bytes / drop', async () => {
    await putPhotoBlob('p1', 'full', new Blob(['12345'], { type: 'image/webp' }), {
      projectId: 'x',
    });
    await putPhotoBlob('p1', 'thumb', new Blob(['12'], { type: 'image/webp' }));
    const full = await photoBlob('p1', 'full');
    expect(full?.size).toBe(5);
    expect(await photoBlobBytes()).toBe(7);
    await dropPhotoBlob('p1', 'full');
    expect(await photoBlob('p1', 'full')).toBeUndefined();
    await dropPhotoBlobs('p1');
    expect(await db.photo_blobs.count()).toBe(0);
  });

  it('pruneOrphanPhotoBlobs keeps blobs of photos on the device, queued or awaiting upload', async () => {
    const p = serverProject();
    const kept = serverRow('project_photos', {
      project_id: p.id,
      storage_path_full: 'f',
      storage_path_thumb: 't',
    });
    await applyServerRows('projects', [p]);
    await applyServerRows('project_photos', [kept]);
    await putPhotoBlob(kept.id, 'thumb', new Blob(['a']));
    await putPhotoBlob('orphan', 'thumb', new Blob(['b']));
    await putPhotoBlob('uploading', 'full', new Blob(['c']));
    await setMeta('photo_upload:uploading', { attempts: 1 });
    expect(await pruneOrphanPhotoBlobs()).toBe(1);
    expect(await photoBlob('orphan', 'thumb')).toBeUndefined();
    expect(await photoBlob(kept.id, 'thumb')).toBeDefined();
    expect(await photoBlob('uploading', 'full')).toBeDefined();
  });

  it('pruneOrphanPhotoBlobs keeps the photos of unsaved form drafts (regression)', async () => {
    // A photo taken in a form that was never saved: blobs on the device, no row, no queued
    // operation — only the autosaved draft knows it. Pruning it would lose the picture.
    const projectId = tid(0x80);
    const inForm = tid(0x90);
    const detached = tid(0x90);
    const nested = tid(0x90);
    const orphan = tid(0x90);
    for (const id of [inForm, detached, nested, orphan]) {
      await putPhotoBlob(id, 'full', new Blob(['f']), { projectId });
      await putPhotoBlob(id, 'thumb', new Blob(['t']), { projectId });
    }
    // the project form's draft (src/projects/form/model.ts)
    await drafts.put(`project-form:new:${projectId}`, {
      v: 1,
      mode: 'new',
      projectId,
      working: { project: { id: projectId }, photos: [{ id: inForm, project_id: projectId }] },
      extras: { seenPhotoIds: [inForm] },
    });
    // the photo module's record of photos that finished after their editor was gone
    await drafts.put(`photos:detached:${projectId}`, {
      v: 1,
      projectId,
      entries: [{ userId: USER_A, row: { id: detached, project_id: projectId } }],
    });
    // any other draft shape: an id as a map key, deep inside
    await drafts.put('some-feature:draft', { a: { b: [{ c: { [nested]: { caption: 'x' } } }] } });

    expect(await pruneOrphanPhotoBlobs()).toBe(2); // full + thumb of the orphan only
    for (const id of [inForm, detached, nested]) {
      expect(await photoBlob(id, 'full')).toBeDefined();
      expect(await photoBlob(id, 'thumb')).toBeDefined();
    }
    expect(await photoBlob(orphan, 'full')).toBeUndefined();

    // Draft discarded / saved elsewhere: the photo is an orphan now.
    await drafts.remove(`project-form:new:${projectId}`);
    expect(await pruneOrphanPhotoBlobs()).toBe(2);
    expect(await photoBlob(inForm, 'full')).toBeUndefined();
    expect(await photoBlob(detached, 'full')).toBeDefined();
  });
});

describe('syncPort (the engine-facing facade)', () => {
  it('exposes the queue in wire shape, claims and acknowledges operations', async () => {
    const p = serverProject({ version: 2, capacity: 1 });
    await applyServerRows('projects', [p]);
    await syncPort.mutate('projects', p.id, { capacity: 2 });
    await expect(syncPort.mutate('profiles', tid(), {})).rejects.toMatchObject({
      code: 'table_not_writable',
    });
    const [op] = await syncPort.pendingOps();
    expect(op).toMatchObject({
      table: 'projects',
      id: p.id,
      kind: 'upsert',
      base_version: 2,
      fields: { capacity: 2 },
      attempts: 0,
    });
    expect(op!.client_ts).toBe((await outbox())[0]!.created_at);
    const [claimed] = await syncPort.markInflight([op!.seq]);
    expect(claimed!.attempts).toBe(1);
    expect(await syncPort.counts()).toEqual({ pendingOps: 1, failedOps: 0 });
    await syncPort.ackOp(claimed!, { op_id: claimed!.op_id, status: 'applied', version: 3 });
    expect(await syncPort.counts()).toEqual({ pendingOps: 0, failedOps: 0 });
    expect(await syncPort.getRow('projects', p.id)).toMatchObject({ version: 3, capacity: 2 });
    expect(await syncPort.getRow('projects', p.id)).not.toHaveProperty('_tokens');
    expect(await syncPort.getRow('nope', p.id)).toBeUndefined();
    // registry order = parents before children
    expect(syncPort.tables.map((t) => t.name)).toEqual([...TABLE_NAMES]);
    expect(syncPort.tables.filter((t) => t.restricted).map((t) => t.name)).toEqual([
      'staff_compensation',
      'community_sensitive',
    ]);
  });

  it('getRow also finds restricted rows held in restricted_local', async () => {
    const sens = newRow('community_sensitive', { project_id: tid(), ibadi_families: 1 });
    // syncPort.mutate only changes rows that exist
    await expect(
      syncPort.mutate('community_sensitive', sens.id, { ibadi_families: 1 }),
    ).rejects.toMatchObject({
      code: 'row_not_found',
    });
    await mutate('community_sensitive', sens.id, sens, { insert: true });
    expect(await syncPort.getRow('community_sensitive', sens.id)).toMatchObject({
      ibadi_families: 1,
    });
    await syncPort.mutate('community_sensitive', sens.id, { ibadi_families: 2 });
    expect((await db.restricted_local.get(sens.id))!.row).toMatchObject({ ibadi_families: 2 });
  });

  it('watch() reports queue changes', async () => {
    let calls = 0;
    const stop = syncPort.watch(() => {
      calls++;
    });
    await new Promise((r) => setTimeout(r, 30));
    await setMeta('x', 1);
    for (let i = 0; i < 50 && calls === 0; i++) await new Promise((r) => setTimeout(r, 10));
    stop();
    expect(calls).toBeGreaterThan(0);
  });
});

/**
 * The engine on top of the REAL local database (`src/db`, fake-indexeddb) through
 * `createDbAdapter`, against the scripted fake server. Proves that the production wiring —
 * `mutate()` → outbox → push → `ackOp` → pull → `applyPage` → photo queue — holds together.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  db,
  listFailedOps,
  mutate,
  newRow,
  putPhotoBlob,
  setLocalSession,
  softDelete,
  wipeAllLocalData,
} from '../db';
import { createDbAdapter } from './dbAdapter';
import { type SyncEngine, createSyncEngine } from './engine';
import { SyncError } from './errors';
import type { DbPort } from './ports';
import { META_PULL_STATE, type PullState } from './pull';
import { FakeAuth, FakeLock, FakeNetwork, FakePrefs, FakeUploader, fakeApp } from './testing/fakes';
import { FakeServer } from './testing/fakeServer';
import { TestClock } from './testing/testClock';

const USER = '11111111-1111-4111-8111-111111111111';
const COUNTRY = '22222222-2222-4222-8222-222222222222';
const BRANCH = '33333333-3333-4333-8333-333333333333';

let server: FakeServer;
let auth: FakeAuth;
let net: FakeNetwork;
let uploader: FakeUploader;
let port: DbPort;
let engine: SyncEngine;

function build(): SyncEngine {
  port = createDbAdapter({ userId: () => auth.user });
  engine = createSyncEngine(
    {
      db: port,
      transport: server.transportFor(auth.device),
      auth,
      net,
      prefs: new FakePrefs(),
      app: fakeApp,
      lock: new FakeLock(),
      uploader,
      clock: new TestClock(1000),
    },
    { push: { maxAttempts: 1 }, pull: { maxAttempts: 1 } },
  );
  return engine;
}

async function createProject(values: Record<string, unknown> = {}): Promise<string> {
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

async function addPhoto(projectId: string): Promise<string> {
  const row = newRow('project_photos', {
    project_id: projectId,
    width: 1600,
    height: 1200,
    bytes: 2048,
  });
  const paths = {
    storage_path_full: `projects/TZ/${projectId}/${row.id}_full.webp`,
    storage_path_thumb: `projects/TZ/${projectId}/${row.id}_thumb.webp`,
  };
  await mutate('project_photos', row.id, { ...row, ...paths }, { insert: true });
  await putPhotoBlob(row.id, 'full', new Blob([new Uint8Array(2048)], { type: 'image/webp' }), {
    projectId,
  });
  await putPhotoBlob(row.id, 'thumb', new Blob([new Uint8Array(256)], { type: 'image/webp' }), {
    projectId,
  });
  await engine.enqueuePhotoUpload(row.id);
  return row.id;
}

beforeEach(async () => {
  await wipeAllLocalData();
  await setLocalSession({ userId: USER, canSeeRestricted: false });
  server = new FakeServer();
  server.write('countries', COUNTRY, {
    iso2: 'TZ',
    name_ar: 'تنزانيا',
    name_en: 'Tanzania',
    active: true,
  });
  auth = new FakeAuth();
  auth.user = USER;
  net = new FakeNetwork();
  uploader = new FakeUploader();
  build();
});

afterEach(async () => {
  engine.stop();
  await engine.whenIdle();
  await wipeAllLocalData();
});

describe('engine + real local database', () => {
  it('pushes records created offline, pulls the server rows and uploads the photos', async () => {
    net.online = false;
    const ids: string[] = [];
    const photos: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = await createProject({ name_latin: `offline ${i}` });
      ids.push(id);
      photos.push(await addPhoto(id));
    }
    await engine.syncNow();
    expect(server.liveRows('projects')).toHaveLength(0);
    expect(engine.status.value).toMatchObject({ pendingOps: 40, pendingPhotos: 20 });

    net.online = true;
    await engine.syncNow();
    expect(engine.status.value).toMatchObject({
      state: 'idle',
      lastError: null,
      pendingOps: 0,
      pendingPhotos: 0,
      failedOps: 0,
    });
    expect(server.liveRows('projects')).toHaveLength(20);
    expect(server.liveRows('project_photos').every((p) => p.upload_state === 'uploaded')).toBe(
      true,
    );
    expect(uploader.stored.size).toBe(40);
    // parents went first, and inserts carried the device's creation time
    const firstBatch = server.calls.push[0]!.ops;
    expect(firstBatch.findIndex((o) => o.table === 'project_photos')).toBeGreaterThan(
      firstBatch.findLastIndex((o) => o.table === 'projects'),
    );
    expect(typeof firstBatch[0]!.fields?.created_at).toBe('string');
    // the device: acknowledged versions, nothing dirty, full-size blobs freed, thumbnails kept
    const local = await db.projects.get(ids[0]!);
    expect(local).toMatchObject({ version: 1 });
    expect(local?._dirty).toBeUndefined();
    expect(await db.photo_blobs.count()).toBe(20);
    expect((await db.photo_blobs.toArray()).every((b) => b.kind === 'thumb')).toBe(true);
    expect((await db.project_photos.get(photos[0]!))?.upload_state).toBe('uploaded');
    expect(await db.countries.count()).toBe(1);
  });

  it('converges after a lost response and a restart: duplicates are acknowledged, nothing is doubled', async () => {
    const ids = [await createProject(), await createProject(), await createProject()];
    server.dropNextPushResponse();
    await engine.syncNow();
    expect(engine.status.value).toMatchObject({
      state: 'error',
      lastError: 'sync.error_network',
      pendingOps: 3,
    });
    expect(server.liveRows('projects')).toHaveLength(3);

    engine.stop();
    build(); // "reload"
    await engine.syncNow();
    expect(engine.status.value).toMatchObject({ state: 'idle', pendingOps: 0, failedOps: 0 });
    expect(server.liveRows('projects')).toHaveLength(3);
    expect(server.liveRows('projects').every((r) => r.version === 1)).toBe(true);
    for (const id of ids) {
      const row = await db.projects.get(id);
      expect(row?.version).toBe(1);
      expect(row?._dirty).toBeUndefined();
    }
  });

  it('sends the offline entry time (created_at) with an insert only, never with an update', async () => {
    net.online = false;
    const id = await createProject();
    const createdAt = (await db.projects.get(id))?.created_at;
    expect(typeof createdAt).toBe('string');
    net.online = true;
    await engine.syncNow();
    await mutate('projects', id, { builder: 'later edit' });
    await engine.syncNow();

    const sent = server.calls.push.flatMap((c) => c.ops).filter((o) => o.id === id);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ kind: 'upsert', base_version: 0 });
    expect(sent[0]!.fields?.created_at).toBe(createdAt);
    expect(String(createdAt)).toMatch(/Z$/); // UTC, ISO 8601 (sync.md §7.5)
    expect(sent[1]).toMatchObject({
      kind: 'upsert',
      base_version: 1,
      fields: { builder: 'later edit' },
    });
    expect(sent[1]!.fields).not.toHaveProperty('created_at');
  });

  it('recovers operations left inflight by a crash', async () => {
    await createProject();
    const [op] = await port.pendingOps();
    await port.markInflight([op!.seq]); // the app died right after sending
    expect(await port.pendingOps()).toHaveLength(0);
    await engine.syncNow();
    expect(server.liveRows('projects')).toHaveLength(1);
    expect(await db.outbox.count()).toBe(0);
  });

  it('keeps local edits on top of pulled rows and reports a conflict on the row', async () => {
    const id = await createProject({ builder: 'first' });
    await engine.syncNow();
    server.write('projects', id, { builder: 'changed elsewhere', capacity: 90 }, 'other-device');

    await mutate('projects', id, { builder: 'changed here', name_latin: 'renamed here' });
    await engine.syncNow();
    expect(server.row('projects', id)).toMatchObject({
      builder: 'changed elsewhere',
      name_latin: 'renamed here',
    });
    expect(server.conflicts.map((c) => c.field)).toEqual(['builder']);
    const local = await db.projects.get(id);
    expect(local).toMatchObject({
      builder: 'changed elsewhere',
      name_latin: 'renamed here',
      capacity: 90,
    });
    expect(engine.status.value).toMatchObject({ pendingOps: 0, failedOps: 0, state: 'idle' });
  });

  it('parks rejected operations, keeps going, and shows them as failedOps', async () => {
    const bad = await createProject({ name_latin: 'bad' });
    const good = await createProject({ name_latin: 'good' });
    server.rejectIf = (op) => (op.id === bad ? 'out_of_scope' : null);
    await engine.syncNow();
    expect(server.row('projects', good)).toBeDefined();
    expect(server.row('projects', bad)).toBeUndefined();
    expect(engine.status.value).toMatchObject({ pendingOps: 0, failedOps: 1, state: 'idle' });
    const failed = await listFailedOps();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ row_id: bad, error: { code: 'out_of_scope' } });
    expect((await db.projects.get(bad))?.name_latin).toBe('bad'); // the user's data is still there
  });

  it('keeps restricted entries of a collector only until they are acknowledged', async () => {
    const project = await createProject();
    const sensitive = newRow('community_sensitive', { project_id: project, ibadi_families: 4 });
    await mutate('community_sensitive', sensitive.id, sensitive, { insert: true });
    expect(await db.restricted_local.count()).toBe(1);
    expect(await db.community_sensitive.count()).toBe(0);

    await engine.syncNow();
    expect(server.row('community_sensitive', sensitive.id)).toMatchObject({ ibadi_families: 4 });
    expect(await db.restricted_local.count()).toBe(0);
    expect(await db.community_sensitive.count()).toBe(0);
  });

  it('deletes through the outbox and removes tombstones and their children on pull', async () => {
    const mine = await createProject();
    await engine.syncNow();
    const theirs = '44444444-4444-4444-8444-444444444444';
    server.write('projects', theirs, {
      name_ar: 'آخر',
      type: 'school',
      country_id: COUNTRY,
      branch_id: BRANCH,
    });
    server.write('project_land', '55555555-5555-4555-8555-555555555555', {
      project_id: theirs,
      ownership: 'waqf',
    });
    await engine.syncNow();
    expect(await db.project_land.count()).toBe(1);

    await softDelete('projects', mine);
    server.remove('projects', theirs);
    await engine.syncNow();
    expect(server.row('projects', mine)?.deleted_at).not.toBeNull();
    expect(await db.projects.count()).toBe(0);
    expect(await db.project_land.count()).toBe(0);
    expect(engine.status.value.pendingOps).toBe(0);
  });

  it('on a scope_epoch change discards the synced copy but keeps unsent work', async () => {
    const stale = '66666666-6666-4666-8666-666666666666';
    server.write('projects', stale, {
      name_ar: 'خارج النطاق',
      type: 'mosque',
      country_id: COUNTRY,
    });
    await engine.syncNow();
    expect(await db.projects.get(stale)).toBeDefined();

    net.online = false;
    const unsent = await createProject({ name_latin: 'unsent' });
    net.online = true;
    server.epoch = 'epoch-2';
    server.visible = (_t, row) => row.id !== stale;
    server.failNext('push', new SyncError('server', 'HTTP 503', { status: 503 }));
    await engine.syncNow(); // the push fails: the unsent project is still only on the device
    await port.setMeta('probe', 1);

    // The next cycle pushes it, then the pull notices the new epoch.
    await engine.syncNow();
    expect(await db.projects.get(stale)).toBeUndefined();
    expect((await db.projects.get(unsent))?.name_latin).toBe('unsent');
    expect(server.row('projects', unsent)).toBeDefined();
    expect(await port.getMeta<PullState>(META_PULL_STATE)).toMatchObject({
      epoch: 'epoch-2',
      complete: true,
    });
    expect(engine.status.value).toMatchObject({ state: 'idle', pendingOps: 0 });
  });

  it('never pushes operations queued by another user of the device', async () => {
    await setLocalSession({ userId: 'somebody-else' });
    await createProject({ name_latin: 'not mine' });
    await setLocalSession({ userId: USER });
    const mine = await createProject({ name_latin: 'mine' });
    await engine.syncNow();
    expect(server.liveRows('projects').map((r) => r.id)).toEqual([mine]);
    expect(await db.outbox.count()).toBe(1);
  });

  it('updates the status counters when the application writes (live counts)', async () => {
    engine.start();
    await engine.whenIdle();
    expect(engine.status.value.pendingOps).toBe(0);
    net.online = false;
    await createProject();
    for (let i = 0; i < 40 && engine.status.value.pendingOps !== 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(engine.status.value.pendingOps).toBe(1);
  });

  it("resetLocalData('revoked') leaves nothing on the device", async () => {
    const project = await createProject();
    await addPhoto(project);
    await engine.resetLocalData('revoked');
    for (const table of db.tables) expect(await table.count(), table.name).toBe(0);
    expect(engine.status.value).toMatchObject({
      pendingOps: 0,
      pendingPhotos: 0,
      failedOps: 0,
      lastSyncAt: null,
    });
  });
});

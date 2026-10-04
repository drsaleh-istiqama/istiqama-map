/**
 * Regression: a photo that is not uploaded yet is never lost (brief §4.4, sync.md §5.2).
 *  - blobs waiting for Wi-Fi survive a sign-out + sign-in of the same user and a
 *    `scope_epoch` change, also while the fresh pull needs several cycles, and are uploaded
 *    in the end;
 *  - a retry deadline written under a wrong (future) device clock does not block the photo
 *    once the clock is corrected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, mutate, newRow, putPhotoBlob, setLocalSession, wipeAllLocalData } from '../db';
import { createDbAdapter } from './dbAdapter';
import { type SyncEngine, createSyncEngine } from './engine';
import { SyncError } from './errors';
import { FakeAuth, FakeLock, FakeNetwork, FakePrefs, FakeUploader, fakeApp } from './testing/fakes';
import { FakeServer } from './testing/fakeServer';
import { TestClock } from './testing/testClock';

const USER = '11111111-1111-4111-8111-111111111111';
const COUNTRY = '22222222-2222-4222-8222-222222222222';
const BRANCH = '33333333-3333-4333-8333-333333333333';

let server: FakeServer;
let auth: FakeAuth;
let net: FakeNetwork;
let prefs: FakePrefs;
let uploader: FakeUploader;
let engine: SyncEngine;
let clock: TestClock;

function build(pull: Record<string, unknown> = {}): SyncEngine {
  engine = createSyncEngine(
    {
      db: createDbAdapter({ userId: () => auth.user }),
      transport: server.transportFor(auth.device),
      auth,
      net,
      prefs,
      app: fakeApp,
      lock: new FakeLock(),
      uploader,
      clock,
    },
    { push: { maxAttempts: 1 }, pull: { maxAttempts: 1, ...pull } },
  );
  return engine;
}

async function createProject(): Promise<string> {
  const row = newRow('projects', {
    name_ar: 'مسجد',
    type: 'mosque',
    country_id: COUNTRY,
    branch_id: BRANCH,
    lon: 39.75,
    lat: -5.05,
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

const blobCount = (photo: string): Promise<number> =>
  db.photo_blobs.where('photo_id').equals(photo).count();

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
  // enough reference rows that a first round needs more than one cycle (pageSize 3 × 2 pages)
  for (let i = 0; i < 6; i++) {
    server.write('branches', `44444444-4444-4444-8444-00000000000${i}`, {
      country_id: COUNTRY,
      name_ar: 'فرع',
    });
  }
  auth = new FakeAuth();
  auth.user = USER;
  net = new FakeNetwork();
  prefs = new FakePrefs();
  uploader = new FakeUploader();
  clock = new TestClock(1000);
});

afterEach(async () => {
  engine.stop();
  await engine.whenIdle();
  await wipeAllLocalData();
});

describe('photos waiting for upload', () => {
  it('a photo waiting for Wi-Fi survives sign-out + sign-in (scope reset) of the same user', async () => {
    build({ pageSize: 3, maxPages: 2 });
    const project = await createProject();
    const photo = await addPhoto(project);
    // Wi-Fi only, phone on 3G: rows go out, photos wait.
    prefs.wifi = true;
    net.type = 'cellular';
    for (let i = 0; i < 5; i++) await engine.syncNow();
    expect(server.row('project_photos', photo)).toMatchObject({ upload_state: 'pending' });
    expect((await db.project_photos.get(photo))?.version).toBe(1);
    expect((await db.project_photos.get(photo))?._dirty).toBeUndefined();
    expect(await blobCount(photo)).toBe(2);

    // sign-out keeps "unsent work"
    await engine.resetLocalData('sign_out');
    expect(await blobCount(photo)).toBe(2);
    expect(engine.status.value.pendingPhotos).toBe(1);

    // back on Wi-Fi, signed in again: the first-round pull needs a few cycles
    net.type = 'wifi';
    await engine.syncNow();
    expect(await blobCount(photo)).toBe(2);
    for (let i = 0; i < 6; i++) await engine.syncNow();
    expect(server.row('project_photos', photo)).toMatchObject({ upload_state: 'uploaded' });
    expect(engine.status.value.pendingPhotos).toBe(0);
  });

  it('a photo waiting for Wi-Fi survives a scope_epoch change (role granted / MFA / epoch rotation)', async () => {
    build({ pageSize: 3, maxPages: 2 });
    const project = await createProject();
    const photo = await addPhoto(project);
    prefs.wifi = true;
    net.type = 'cellular';
    for (let i = 0; i < 5; i++) await engine.syncNow();
    expect((await db.project_photos.get(photo))?._dirty).toBeUndefined();
    // an administrator grants a role: the server's scope_epoch changes, no user action at all
    server.epoch = 'epoch-2';
    net.type = 'wifi';
    await engine.syncNow();
    expect(await blobCount(photo)).toBe(2);
    for (let i = 0; i < 8; i++) await engine.syncNow();
    expect(server.row('project_photos', photo)).toMatchObject({ upload_state: 'uploaded' });
  });

  it('a photo deleted on the server while the device was reset is dropped once the pull is complete', async () => {
    build({ pageSize: 3, maxPages: 2 });
    const project = await createProject();
    const photo = await addPhoto(project);
    prefs.wifi = true;
    net.type = 'cellular';
    for (let i = 0; i < 5; i++) await engine.syncNow();
    await engine.resetLocalData('sign_out');
    // a first round carries live rows only: the deleted photo simply never comes back
    server.remove('project_photos', photo);
    net.type = 'wifi';
    for (let i = 0; i < 6; i++) await engine.syncNow();
    expect(await blobCount(photo)).toBe(0);
    expect(engine.status.value.pendingPhotos).toBe(0);
    expect(uploader.calls).toHaveLength(0);
  });

  it('a photo whose retry was scheduled under a wrong (future) clock is retried after the clock is corrected', async () => {
    build();
    const project = await createProject();
    const photo = await addPhoto(project);
    // phone clock is a year ahead; the first upload attempt fails on the server
    const realNow = clock.time;
    clock.time = realNow + 365 * 24 * 3600_000;
    uploader.plan({ kind: 'fail', error: new SyncError('server', 'HTTP 503', { status: 503 }) });
    await engine.syncNow();
    expect(server.row('project_photos', photo)).toMatchObject({ upload_state: 'pending' });
    // the user (or NTP) corrects the clock; hours of retries follow
    clock.time = realNow + 60_000;
    for (let i = 0; i < 5; i++) {
      clock.time += 3600_000;
      await engine.syncNow();
    }
    expect(server.row('project_photos', photo)).toMatchObject({ upload_state: 'uploaded' });
  });
});

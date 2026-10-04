/**
 * SCRATCH (u2rev_data_loss) — adversarial tests; delete after the review.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, mutate, newRow, putPhotoBlob, setLocalSession, wipeAllLocalData } from '../../src/db';
import { createDbAdapter } from '../../src/sync/dbAdapter';
import { type SyncEngine, createSyncEngine } from '../../src/sync/engine';
import { SyncError } from '../../src/sync/errors';
import type { DbPort } from '../../src/sync/ports';
import { FakeAuth, FakeLock, FakeNetwork, FakePrefs, FakeUploader, fakeApp } from '../../src/sync/testing/fakes';
import { FakeServer } from '../../src/sync/testing/fakeServer';
import { TestClock } from '../../src/sync/testing/testClock';

const USER = '11111111-1111-4111-8111-111111111111';
const COUNTRY = '22222222-2222-4222-8222-222222222222';
const BRANCH = '33333333-3333-4333-8333-333333333333';

let server: FakeServer;
let auth: FakeAuth;
let net: FakeNetwork;
let prefs: FakePrefs;
let uploader: FakeUploader;
let port: DbPort;
let engine: SyncEngine;
let clock: TestClock;

function build(pull: Record<string, unknown> = {}): SyncEngine {
  port = createDbAdapter({ userId: () => auth.user });
  engine = createSyncEngine(
    {
      db: port,
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
    name_ar: 'مسجد', type: 'mosque', country_id: COUNTRY, branch_id: BRANCH, lon: 39.75, lat: -5.05,
  });
  await mutate('projects', row.id, row, { insert: true });
  return row.id;
}

async function addPhoto(projectId: string): Promise<string> {
  const row = newRow('project_photos', { project_id: projectId, width: 1600, height: 1200, bytes: 2048 });
  const paths = {
    storage_path_full: `projects/TZ/${projectId}/${row.id}_full.webp`,
    storage_path_thumb: `projects/TZ/${projectId}/${row.id}_thumb.webp`,
  };
  await mutate('project_photos', row.id, { ...row, ...paths }, { insert: true });
  await putPhotoBlob(row.id, 'full', new Blob([new Uint8Array(2048)], { type: 'image/webp' }), { projectId });
  await putPhotoBlob(row.id, 'thumb', new Blob([new Uint8Array(256)], { type: 'image/webp' }), { projectId });
  await engine.enqueuePhotoUpload(row.id);
  return row.id;
}

beforeEach(async () => {
  await wipeAllLocalData();
  await setLocalSession({ userId: USER, canSeeRestricted: false });
  server = new FakeServer();
  server.write('countries', COUNTRY, { iso2: 'TZ', name_ar: 'تنزانيا', name_en: 'Tanzania', active: true });
  // some reference rows so that a first round needs more than one page
  for (let i = 0; i < 6; i++) {
    server.write('branches', `44444444-4444-4444-8444-00000000000${i}`, { country_id: COUNTRY, name_ar: 'فرع' });
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

describe('u2rev photos', () => {
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
    expect(await db.photo_blobs.where('photo_id').equals(photo).count()).toBe(2);

    // sign-out keeps "unsent work"
    await engine.resetLocalData('sign_out');
    expect(await db.photo_blobs.where('photo_id').equals(photo).count()).toBe(2);
    expect(engine.status.value.pendingPhotos).toBe(1);

    // back on Wi-Fi, signed in again: the first-round pull needs a few cycles
    net.type = 'wifi';
    await engine.syncNow();
    const blobsAfterFirstCycle = await db.photo_blobs.where('photo_id').equals(photo).count();
    for (let i = 0; i < 6; i++) await engine.syncNow();
    const serverRow = server.row('project_photos', photo);
    // eslint-disable-next-line no-console
    console.info('blobs after first cycle', blobsAfterFirstCycle, 'uploads', uploader.calls.length,
      'server upload_state', serverRow?.upload_state, 'pendingPhotos', engine.status.value.pendingPhotos);
    expect(blobsAfterFirstCycle).toBe(2);
    expect(serverRow).toMatchObject({ upload_state: 'uploaded' });
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
    for (let i = 0; i < 8; i++) await engine.syncNow();
    const blobs = await db.photo_blobs.where('photo_id').equals(photo).count();
    // eslint-disable-next-line no-console
    console.info('epoch path: blobs', blobs, 'uploads', uploader.calls.length,
      'server upload_state', server.row('project_photos', photo)?.upload_state,
      'pendingPhotos', engine.status.value.pendingPhotos);
    expect(server.row('project_photos', photo)).toMatchObject({ upload_state: 'uploaded' });
  });

  it('end to end: a rejected older edit overrides the newer value of the same field', async () => {
    build();
    const id = await createProject();
    await engine.syncNow();
    const BAD = '99999999-9999-4999-8999-999999999999';
    server.rejectIf = (op) => (op.fields?.locality_id === BAD ? 'locality_country_mismatch' : null);
    await mutate('projects', id, { builder: 'A', locality_id: BAD });
    let typed = false;
    server.onPush = async () => {
      if (typed) return;
      typed = true;
      await mutate('projects', id, { builder: 'B' }); // typed while edit 1 is on the wire
    };
    await engine.syncNow();
    const afterCycle = (await db.projects.get(id))?.builder;
    const serverAfterCycle = server.row('projects', id)?.builder;
    // the user fixes the locality from the needs-attention list
    await mutate('projects', id, { locality_id: null });
    await engine.syncNow();
    // eslint-disable-next-line no-console
    console.info('e2e: server after cycle', serverAfterCycle, '| device after cycle', afterCycle,
      '| server final', server.row('projects', id)?.builder, '| device final', (await db.projects.get(id))?.builder);
    expect(server.row('projects', id)?.builder).toBe('B');
  });

  it('a photo whose retry was scheduled under a wrong (future) clock is retried after the clock is corrected', async () => {
    build();
    const project = await createProject();
    const photo = await addPhoto(project);
    // phone clock is a year ahead; the first upload attempt fails on the network
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
    // eslint-disable-next-line no-console
    console.info('upload attempts', uploader.calls.length, 'entries', JSON.stringify(await engine.photos.list()));
    expect(server.row('project_photos', photo)).toMatchObject({ upload_state: 'uploaded' });
  });
});

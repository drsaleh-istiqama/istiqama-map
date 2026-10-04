import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SyncError } from './errors';
import {
  PHOTO_META_PREFIX,
  type PhotoQueue,
  type PhotoUploadEntry,
  createPhotoQueue,
} from './photoQueue';
import { FakeNetwork, FakePrefs, FakeUploader } from './testing/fakes';
import { LocalStore } from './testing/localStore';
import { TestClock } from './testing/testClock';

let n = 0;
const uid = (): string => {
  n++;
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
};

const COUNTRY = uid();
let store: LocalStore;
let uploader: FakeUploader;
let net: FakeNetwork;
let prefs: FakePrefs;
let clock: TestClock;
let queue: PhotoQueue;

function newQueue(): PhotoQueue {
  return createPhotoQueue({ db: store, uploader, net, prefs, clock });
}

/** A project the server knows (version ≥ 1) in country TZ. */
async function ackedProject(): Promise<string> {
  const id = uid();
  await store.applyPage({
    changes: [
      { table: 'countries', rows: [{ id: COUNTRY, iso2: 'TZ', version: 1, deleted_at: null }] },
      {
        table: 'projects',
        rows: [{ id, name_ar: 'x', country_id: COUNTRY, version: 1, deleted_at: null }],
      },
    ],
    meta: [],
  });
  return id;
}

interface PhotoOptions {
  acked?: boolean;
  mime?: string;
  paths?: boolean;
  fullBytes?: number;
}

async function addPhoto(projectId: string, options: PhotoOptions = {}): Promise<string> {
  const { acked = true, mime = 'image/webp', paths = true, fullBytes = 2000 } = options;
  const id = uid();
  const row: Record<string, unknown> = {
    id,
    project_id: projectId,
    upload_state: 'pending',
    storage_path_full: paths ? `projects/TZ/${projectId}/${id}_full.webp` : null,
    storage_path_thumb: paths ? `projects/TZ/${projectId}/${id}_thumb.webp` : null,
    deleted_at: null,
  };
  if (acked)
    await store.applyPage({
      changes: [{ table: 'project_photos', rows: [{ ...row, version: 1 }] }],
      meta: [],
    });
  else await store.mutate('project_photos', id, row);
  await store.putPhotoBlob(id, 'full', new Blob([new Uint8Array(fullBytes)], { type: mime }));
  await store.putPhotoBlob(id, 'thumb', new Blob([new Uint8Array(300)], { type: mime }));
  await queue.enqueue(id);
  return id;
}

async function entry(photoId: string): Promise<PhotoUploadEntry | undefined> {
  return store.getMeta<PhotoUploadEntry>(`${PHOTO_META_PREFIX}${photoId}`);
}

beforeEach(() => {
  store = new LocalStore(`photos-${uid()}`);
  uploader = new FakeUploader();
  net = new FakeNetwork();
  prefs = new FakePrefs();
  clock = new TestClock();
  queue = newQueue();
});

afterEach(async () => {
  await store.destroy();
});

describe('photo queue', () => {
  it('uploads first in, first out — thumbnail before full size', async () => {
    const project = await ackedProject();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await addPhoto(project));
      clock.time += 5;
    }
    expect(await queue.pendingCount()).toBe(3);

    const outcome = await queue.run();
    expect(outcome).toMatchObject({
      uploaded: 3,
      waiting: 0,
      failed: 0,
      blocked: null,
      more: false,
    });
    expect(uploader.calls.map((c) => c.objectName)).toEqual(
      ids.flatMap((id) => [
        `projects/TZ/${project}/${id}_thumb.webp`,
        `projects/TZ/${project}/${id}_full.webp`,
      ]),
    );
    expect(
      uploader.calls.every((c) => c.bucket === 'photos' && c.contentType === 'image/webp'),
    ).toBe(true);
    expect(await queue.pendingCount()).toBe(0);
  });

  it('flips upload_state through the outbox, frees the full blob and keeps the thumbnail', async () => {
    const project = await ackedProject();
    const photo = await addPhoto(project);
    await queue.run();

    expect(await store.getRow('project_photos', photo)).toMatchObject({
      upload_state: 'uploaded',
      _dirty: 1,
    });
    const ops = await store.pendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      table: 'project_photos',
      id: photo,
      kind: 'upsert',
      base_version: 1,
      fields: { upload_state: 'uploaded' },
    });
    expect(await store.photoBlob(photo, 'full')).toBeUndefined();
    expect(await store.photoBlob(photo, 'thumb')).toBeDefined();
    expect(await entry(photo)).toBeUndefined();
  });

  it('waits until the photo row and its project were acknowledged by the server', async () => {
    const project = await ackedProject();
    const unsent = await addPhoto(project, { acked: false });
    const newProject = uid();
    await store.mutate('projects', newProject, { name_ar: 'new', country_id: COUNTRY });
    const orphan = await addPhoto(newProject); // row known, project not yet

    const first = await queue.run();
    expect(first).toMatchObject({ uploaded: 0, waiting: 2 });
    expect(uploader.calls).toHaveLength(0);
    expect(await queue.pendingCount()).toBe(2);

    // The push acknowledges both: now they go out.
    const [photoOp] = (await store.pendingOps()).filter((o) => o.id === unsent);
    const [projectOp] = (await store.pendingOps()).filter((o) => o.id === newProject);
    await store.ackOp(photoOp!, { op_id: photoOp!.op_id, status: 'applied', version: 1 });
    await store.ackOp(projectOp!, { op_id: projectOp!.op_id, status: 'applied', version: 1 });
    const second = await queue.run();
    expect(second).toMatchObject({ uploaded: 2, waiting: 0 });
    expect(uploader.stored.has(`projects/TZ/${newProject}/${orphan}_full.webp`)).toBe(true);
  });

  it('resumes an interrupted upload from its stored URL after a reload', async () => {
    const project = await ackedProject();
    const photo = await addPhoto(project, { fullBytes: 9_000_000 });
    uploader.plan(
      { kind: 'ok' }, // thumbnail
      { kind: 'partial', offset: 6_291_456, error: new SyncError('network', 'connection lost') },
    );
    const first = await queue.run();
    expect(first).toMatchObject({ uploaded: 0, failed: 1 });
    const saved = (await entry(photo)) as PhotoUploadEntry;
    expect(saved.parts.thumb).toMatchObject({ done: true });
    expect(saved.parts.full).toMatchObject({
      done: false,
      uploadUrl: 'http://tus.test/upload/2',
      offset: 6_291_456,
    });
    expect(saved).toMatchObject({ attempts: 1, lastError: 'network' });
    expect(await store.photoBlob(photo, 'full')).toBeDefined();

    // Reload: new connection, new queue object, later in time.
    store.close();
    store = new LocalStore(store.name);
    queue = newQueue();
    clock.time += 60_000;
    const second = await queue.run();
    expect(second).toMatchObject({ uploaded: 1, failed: 0 });
    const resumed = uploader.calls.at(-1)!;
    expect(resumed).toMatchObject({
      objectName: `projects/TZ/${project}/${photo}_full.webp`,
      resumedFrom: 'http://tus.test/upload/2',
    });
    // the thumbnail was not sent a second time
    expect(uploader.calls.filter((c) => c.objectName.endsWith('_thumb.webp'))).toHaveLength(1);
    expect(await store.getRow('project_photos', photo)).toMatchObject({ upload_state: 'uploaded' });
  });

  it('does not retry a failing photo before its backoff expired', async () => {
    const project = await ackedProject();
    await addPhoto(project);
    uploader.plan({ kind: 'fail', error: new SyncError('server', 'HTTP 503', { status: 503 }) });
    expect(await queue.run()).toMatchObject({ failed: 1, uploaded: 0 });
    expect(await queue.run()).toMatchObject({ failed: 1, uploaded: 0 });
    expect(uploader.calls).toHaveLength(1);
    clock.time += 15_000;
    expect(await queue.run()).toMatchObject({ uploaded: 1 });
  });

  describe('Wi-Fi only', () => {
    const cases: Array<
      [boolean, 'wifi' | 'ethernet' | 'cellular' | 'unknown' | 'bluetooth', boolean, boolean]
    > = [
      // wifiOnly, connection, saveData, expected to upload
      [true, 'wifi', false, true],
      [true, 'ethernet', false, true],
      [true, 'cellular', false, false],
      [true, 'bluetooth', false, false],
      [true, 'unknown', false, true],
      [true, 'unknown', true, false],
      [false, 'cellular', false, true],
      [false, 'cellular', true, true],
    ];
    it.each(cases)(
      'wifiOnly=%s on %s (saveData=%s) → uploads: %s',
      async (wifiOnly, type, saveData, expected) => {
        prefs.wifi = wifiOnly;
        net.type = type;
        net.dataSaver = saveData;
        const project = await ackedProject();
        await addPhoto(project);
        const outcome = await queue.run();
        expect(outcome.uploaded).toBe(expected ? 1 : 0);
        expect(outcome.blocked).toBe(expected ? null : 'wifi_only');
        expect(await queue.pendingCount()).toBe(expected ? 0 : 1);
      },
    );

    it('starts uploading once the phone is on Wi-Fi', async () => {
      prefs.wifi = true;
      net.type = 'cellular';
      const project = await ackedProject();
      await addPhoto(project);
      expect((await queue.run()).blocked).toBe('wifi_only');
      net.type = 'wifi';
      expect(await queue.run()).toMatchObject({ uploaded: 1, blocked: null });
    });
  });

  it('pauses while offline', async () => {
    const project = await ackedProject();
    await addPhoto(project);
    net.online = false;
    expect(await queue.run()).toMatchObject({ uploaded: 0, blocked: 'offline' });
    expect(uploader.calls).toHaveLength(0);
  });

  it('stops quietly when the connection drops in the middle of an upload', async () => {
    const project = await ackedProject();
    const photo = await addPhoto(project);
    await addPhoto(project);
    const controller = new AbortController();
    uploader.plan({ kind: 'ok' }, { kind: 'hang' });
    uploader.onUpload = (call) => {
      if (call.objectName.endsWith('_full.webp')) {
        setTimeout(() => {
          net.online = false;
          controller.abort();
        }, 5);
      }
    };
    const outcome = await queue.run({ signal: controller.signal });
    expect(outcome).toMatchObject({ uploaded: 0, blocked: 'offline' });
    const saved = (await entry(photo)) as PhotoUploadEntry;
    expect(saved.parts.full.uploadUrl).toBe('http://tus.test/upload/2');
    expect(saved.attempts).toBe(0); // not counted as a failure
    expect(await queue.pendingCount()).toBe(2);
  });

  it('uses a .jpg object name for JPEG fallbacks and corrects the paths on the row', async () => {
    const project = await ackedProject();
    const photo = await addPhoto(project, { mime: 'image/jpeg' });
    await queue.run();
    expect(uploader.calls.map((c) => [c.objectName, c.contentType])).toEqual([
      [`projects/TZ/${project}/${photo}_thumb.jpg`, 'image/jpeg'],
      [`projects/TZ/${project}/${photo}_full.jpg`, 'image/jpeg'],
    ]);
    expect((await store.pendingOps())[0]!.fields).toEqual({
      upload_state: 'uploaded',
      storage_path_full: `projects/TZ/${project}/${photo}_full.jpg`,
      storage_path_thumb: `projects/TZ/${project}/${photo}_thumb.jpg`,
    });
  });

  it('derives the object names from the project country when the row has no paths yet', async () => {
    const project = await ackedProject();
    const photo = await addPhoto(project, { paths: false });
    await queue.run();
    expect(uploader.calls[0]!.objectName).toBe(`projects/TZ/${project}/${photo}_thumb.webp`);
    expect((await store.pendingOps())[0]!.fields).toMatchObject({
      storage_path_full: `projects/TZ/${project}/${photo}_full.webp`,
    });
  });

  it('drops the entry and the blobs of a photo that was deleted', async () => {
    const project = await ackedProject();
    const photo = await addPhoto(project);
    await store.applyPage({
      changes: [
        {
          table: 'project_photos',
          rows: [{ id: photo, version: 2, deleted_at: '2026-10-03T00:00:00Z' }],
        },
      ],
      meta: [],
    });
    expect(await queue.run()).toMatchObject({ dropped: 1, uploaded: 0 });
    expect(await queue.pendingCount()).toBe(0);
    expect(await store.photoBlob(photo, 'thumb')).toBeUndefined();
    expect(uploader.calls).toHaveLength(0);
  });

  it('keeps a refused photo in the queue with a long backoff and continues with the next one', async () => {
    const project = await ackedProject();
    const refused = await addPhoto(project);
    clock.time += 1;
    const fine = await addPhoto(project);
    uploader.plan({
      kind: 'fail',
      error: new SyncError('forbidden', 'upload: HTTP 403', { status: 403 }),
    });
    const outcome = await queue.run();
    expect(outcome).toMatchObject({ uploaded: 1, failed: 1 });
    expect(await entry(refused)).toMatchObject({ lastError: 'forbidden', attempts: 1 });
    expect(
      ((await entry(refused)) as PhotoUploadEntry).nextAttemptAt - clock.now(),
    ).toBeGreaterThanOrEqual(9 * 60_000);
    expect(await entry(fine)).toBeUndefined();
    expect(await queue.pendingCount()).toBe(1);
  });

  it('hands session problems to the engine', async () => {
    const project = await ackedProject();
    await addPhoto(project);
    uploader.plan({ kind: 'fail', error: new SyncError('unauthenticated', 'upload: no session') });
    await expect(queue.run()).rejects.toMatchObject({ kind: 'unauthenticated' });
    expect(await queue.pendingCount()).toBe(1);
  });

  it('respects the time budget and reports that more is waiting', async () => {
    const project = await ackedProject();
    for (let i = 0; i < 4; i++) {
      await addPhoto(project);
      clock.time += 1;
    }
    uploader.onUpload = () => {
      clock.time += 20_000; // every object takes 20 s on this network
    };
    const outcome = await queue.run({ budgetMs: 60_000 });
    expect(outcome).toMatchObject({ uploaded: 2, more: true });
    expect(await queue.pendingCount()).toBe(2);
  });

  it('enqueue is idempotent and never resets the progress of an entry', async () => {
    const project = await ackedProject();
    const photo = await addPhoto(project, { fullBytes: 9_000_000 });
    uploader.plan(
      { kind: 'ok' },
      { kind: 'partial', offset: 100, error: new SyncError('network', 'lost') },
    );
    await queue.run();
    await queue.enqueue(photo);
    expect((await entry(photo))!.parts.thumb.done).toBe(true);
    expect(await queue.pendingCount()).toBe(1);
  });

  it('finishes an entry whose objects are stored but whose row was not flipped (crash in between)', async () => {
    const project = await ackedProject();
    const photo = await addPhoto(project);
    const key = `${PHOTO_META_PREFIX}${photo}`;
    await store.updateMeta<PhotoUploadEntry>(key, (cur) => ({
      ...(cur as PhotoUploadEntry),
      parts: {
        thumb: {
          done: true,
          uploadUrl: null,
          offset: 300,
          objectName: `projects/TZ/${project}/${photo}_thumb.webp`,
        },
        full: {
          done: true,
          uploadUrl: null,
          offset: 2000,
          objectName: `projects/TZ/${project}/${photo}_full.webp`,
        },
      },
    }));
    expect(await queue.run()).toMatchObject({ uploaded: 1 });
    expect(uploader.calls).toHaveLength(0);
    expect(await store.getRow('project_photos', photo)).toMatchObject({ upload_state: 'uploaded' });
    expect(await store.photoBlob(photo, 'full')).toBeUndefined();
  });
});

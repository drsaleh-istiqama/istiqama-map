import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyServerRows,
  db,
  photoBlob,
  saveProjectBundle,
  loadProjectBundle,
  mutate,
  type Row,
} from '../db';
import type * as DbModule from '../db';
import { freshDb, outbox, serverProject, serverRow, tid } from '../db/testing/factory';
import type { CompressedPhoto } from './compress';
import { PhotoError } from './errors';
import { MAX_PHOTOS } from './model';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(async (_id: string) => undefined),
  ensureSpace: vi.fn(async (_bytes: number) => undefined),
  compress: vi.fn(),
  failMutate: null as Error | null,
}));

vi.mock('../db', async (original) => {
  const real = await original<typeof DbModule>();
  return {
    ...real,
    mutate: (async (...args: Parameters<typeof real.mutate>) => {
      if (mocks.failMutate) throw mocks.failMutate;
      return real.mutate(...args);
    }) as typeof real.mutate,
  };
});

vi.mock('../sync', async () => {
  class SyncError extends Error {
    constructor(
      readonly kind: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    SyncError,
    enqueuePhotoUpload: mocks.enqueue,
    ensureStorageSpace: mocks.ensureSpace,
    withQuotaGuard: async <T>(fn: () => Promise<T>) => fn(),
    isSyncError: (e: unknown) => e instanceof SyncError,
  };
});

vi.mock('./compress', () => ({
  compressPhoto: mocks.compress,
}));

const {
  addPhoto,
  discardStagedPhotos,
  queuePhotoUploads,
  reconcilePhotoUploads,
  stagePhoto,
  stopWatchingStagedPhotos,
  watchedStagedPhotos,
} = await import('./persist');

function compressed(mime: 'image/webp' | 'image/jpeg' = 'image/webp'): CompressedPhoto {
  return {
    full: new Blob([new Uint8Array(3000).fill(1)], { type: mime }),
    thumb: new Blob([new Uint8Array(300).fill(2)], { type: mime }),
    width: 1600,
    height: 1200,
    takenAt: '2026-09-30T14:05:09+03:00',
    mime,
  };
}

let countryId: string;
let project: Row<'projects'>;

async function seedProject(values: Partial<Row<'projects'>> = {}): Promise<Row<'projects'>> {
  const p = serverProject({ country_id: countryId, ...values });
  await applyServerRows('projects', [p]);
  return p;
}

beforeEach(async () => {
  await freshDb();
  mocks.enqueue.mockClear();
  mocks.ensureSpace.mockReset();
  mocks.ensureSpace.mockResolvedValue(undefined);
  mocks.compress.mockReset();
  mocks.compress.mockImplementation(async () => compressed());
  countryId = tid(0x10);
  await applyServerRows('countries', [
    serverRow('countries', {
      id: countryId,
      iso2: 'TZ',
      iso3: 'TZA',
      name_ar: 'تنزانيا',
      name_en: 'Tanzania',
      name_sw: 'Tanzania',
      active: true,
    }),
  ]);
  project = await seedProject();
});

afterEach(() => {
  stopWatchingStagedPhotos();
});

describe('addPhoto (immediate commit)', () => {
  it('compress → photo_blobs → mutate() → enqueuePhotoUpload(), in that order', async () => {
    let rowAtEnqueue: unknown = null;
    mocks.enqueue.mockImplementationOnce(async (id: string) => {
      rowAtEnqueue = await db.project_photos.get(id);
    });
    const file = new Blob(['x'], { type: 'image/jpeg' });
    const row = await addPhoto(project.id, file, { category: 'mosque_front' });

    expect(mocks.compress).toHaveBeenCalledWith(file);
    expect(row).toMatchObject({
      project_id: project.id,
      storage_path_full: `projects/TZ/${project.id}/${row.id}_full.webp`,
      storage_path_thumb: `projects/TZ/${project.id}/${row.id}_thumb.webp`,
      width: 1600,
      height: 1200,
      bytes: 3000,
      taken_at: '2026-09-30T14:05:09+03:00',
      category: 'mosque_front',
      is_cover: true,
      upload_state: 'pending',
    });
    // the same public row the project bundle shows (no derived index fields)
    expect((await loadProjectBundle(project.id))?.photos).toEqual([row]);
    expect((await photoBlob(row.id, 'full'))?.size).toBe(3000);
    expect((await photoBlob(row.id, 'thumb'))?.size).toBe(300);
    expect(mocks.enqueue).toHaveBeenCalledWith(row.id);
    expect(rowAtEnqueue).toBeTruthy(); // the row existed when the upload was queued
    const ops = await outbox();
    expect(ops.find((o) => o.table === 'project_photos' && o.row_id === row.id)).toMatchObject({
      kind: 'upsert',
      base_version: 0,
    });
  });

  it('only the first photo of a project becomes the cover', async () => {
    const a = await addPhoto(project.id, new Blob(['a'], { type: 'image/jpeg' }));
    const b = await addPhoto(project.id, new Blob(['b'], { type: 'image/jpeg' }));
    expect(a.is_cover).toBe(true);
    expect(b.is_cover).toBe(false);
  });

  it('JPEG output gets .jpg object names', async () => {
    mocks.compress.mockImplementation(async () => compressed('image/jpeg'));
    const row = await addPhoto(project.id, new Blob(['x'], { type: 'image/jpeg' }));
    expect(row.storage_path_full).toBe(`projects/TZ/${project.id}/${row.id}_full.jpg`);
    expect(row.storage_path_thumb).toBe(`projects/TZ/${project.id}/${row.id}_thumb.jpg`);
  });

  it('refuses the 11th photo and writes nothing', async () => {
    for (let i = 0; i < MAX_PHOTOS; i++)
      await addPhoto(project.id, new Blob([String(i)], { type: 'image/jpeg' }));
    mocks.compress.mockClear();
    const before = await db.photo_blobs.count();
    await expect(
      addPhoto(project.id, new Blob(['11'], { type: 'image/jpeg' })),
    ).rejects.toMatchObject({
      code: 'limit_reached',
    });
    expect(mocks.compress).not.toHaveBeenCalled();
    expect(await db.photo_blobs.count()).toBe(before);
    expect(await db.project_photos.where('project_id').equals(project.id).count()).toBe(MAX_PHOTOS);
  });

  it('refuses a project that is not on the device', async () => {
    await expect(addPhoto(tid(0x80), new Blob(['x']))).rejects.toBeInstanceOf(PhotoError);
    await expect(addPhoto(tid(0x80), new Blob(['x']))).rejects.toMatchObject({
      code: 'project_missing',
    });
  });

  it('storage full → PhotoError(storage_full), no blob left behind', async () => {
    const { SyncError } = (await import('../sync')) as unknown as {
      SyncError: new (kind: string, m: string) => Error;
    };
    mocks.ensureSpace.mockRejectedValue(new SyncError('storage_full', 'full'));
    await expect(
      addPhoto(project.id, new Blob(['x'], { type: 'image/jpeg' })),
    ).rejects.toMatchObject({
      code: 'storage_full',
    });
    expect(await db.photo_blobs.count()).toBe(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('a failing mutate() drops the blobs again', async () => {
    mocks.failMutate = new Error('disk error');
    try {
      await expect(addPhoto(project.id, new Blob(['x'], { type: 'image/jpeg' }))).rejects.toThrow(
        'disk error',
      );
    } finally {
      mocks.failMutate = null;
    }
    expect(await db.photo_blobs.count()).toBe(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

describe('staging (photo editor) and upload queueing', () => {
  it('stagePhoto stores the blobs but not the row, and decides no storage path yet', async () => {
    const row = await stagePhoto(project.id, compressed(), { category: 'land' });
    // The form's country may still change: the project's FINAL country decides the paths
    // (server trigger on insert, upload queue afterwards) — brief §6.
    expect(row.storage_path_full).toBeNull();
    expect(row.storage_path_thumb).toBeNull();
    expect(row.category).toBe('land');
    expect(await db.project_photos.get(row.id)).toBeUndefined();
    expect(await photoBlob(row.id, 'full')).toBeDefined();
    expect(watchedStagedPhotos()).toContain(row.id);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('a photo staged under one country and saved with another: no stale ISO2 is pushed', async () => {
    // Review finding: TZ when the photo was added, KE when the project was saved.
    const keCountry = tid(0x10);
    await applyServerRows('countries', [
      serverRow('countries', {
        id: keCountry,
        iso2: 'KE',
        iso3: 'KEN',
        name_ar: 'كينيا',
        name_en: 'Kenya',
        name_sw: 'Kenya',
        active: true,
      }),
    ]);
    const newId = tid(0x80);
    const staged = await stagePhoto(newId, compressed());
    const fresh = serverProject({ id: newId, country_id: keCountry, version: 0 } as Partial<
      Row<'projects'>
    >);
    await saveProjectBundle({
      project: { ...fresh, version: 0 },
      maintenance: [],
      photos: [{ ...staged, is_cover: true }],
      donors: [],
      staff: [],
    });
    const op = (await outbox()).find((o) => o.table === 'project_photos' && o.row_id === staged.id);
    expect(op).toBeDefined();
    const payload = JSON.stringify(op);
    expect(payload).not.toContain('projects/TZ/');
    // Paths are absent or null in the insert: the server fills them from KE (schema.md §4.4).
    expect(op!.fields.storage_path_full ?? null).toBeNull();
    expect(op!.fields.storage_path_thumb ?? null).toBeNull();
    expect(op!.fields.project_id).toBe(newId);
  });

  it('queuePhotoUploads queues only stored, pending photos that have their blob here', async () => {
    const staged = await stagePhoto(project.id, compressed());
    expect(await queuePhotoUploads([staged])).toBe(0); // not saved yet
    expect(mocks.enqueue).not.toHaveBeenCalled();

    const bundle = (await loadProjectBundle(project.id))!;
    await saveProjectBundle({ ...bundle, photos: [{ ...staged, is_cover: true }] });
    mocks.enqueue.mockClear();
    expect(await queuePhotoUploads([staged])).toBe(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(staged.id);

    // uploaded → skipped
    await mutate('project_photos', staged.id, { upload_state: 'uploaded' });
    mocks.enqueue.mockClear();
    expect(await queuePhotoUploads([staged])).toBe(0);

    // a photo taken on another device (no blob here) → skipped
    const remote = serverRow('project_photos', {
      project_id: project.id,
      storage_path_full: `projects/TZ/${project.id}/x_full.webp`,
      storage_path_thumb: `projects/TZ/${project.id}/x_thumb.webp`,
      upload_state: 'pending',
    });
    await applyServerRows('project_photos', [remote]);
    expect(await queuePhotoUploads([remote])).toBe(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('staged photos are queued automatically once the form saves their rows', async () => {
    const staged = await stagePhoto(project.id, compressed());
    const bundle = (await loadProjectBundle(project.id))!;
    await saveProjectBundle({ ...bundle, photos: [{ ...staged, is_cover: true }] });
    await vi.waitFor(() => expect(mocks.enqueue).toHaveBeenCalledWith(staged.id));
    await vi.waitFor(() => expect(watchedStagedPhotos()).not.toContain(staged.id));
  });

  it('a new project saved together with its photos: the project row goes first in the outbox', async () => {
    const newId = tid(0x80);
    const staged = await stagePhoto(newId, compressed());
    const fresh = serverProject({ id: newId, country_id: countryId, version: 0 } as Partial<
      Row<'projects'>
    >);
    await saveProjectBundle({
      project: { ...fresh, version: 0 },
      maintenance: [],
      photos: [{ ...staged, is_cover: true }],
      donors: [],
      staff: [],
    });
    const ops = await outbox();
    const projectOp = ops.findIndex((o) => o.table === 'projects' && o.row_id === newId);
    const photoOp = ops.findIndex((o) => o.table === 'project_photos' && o.row_id === staged.id);
    expect(projectOp).toBeGreaterThanOrEqual(0);
    expect(photoOp).toBeGreaterThan(projectOp);
    await vi.waitFor(() => expect(mocks.enqueue).toHaveBeenCalledWith(staged.id));
  });

  it('discardStagedPhotos frees unsaved blobs and leaves saved photos alone', async () => {
    const kept = await stagePhoto(project.id, compressed());
    const dropped = await stagePhoto(project.id, compressed());
    const bundle = (await loadProjectBundle(project.id))!;
    await saveProjectBundle({ ...bundle, photos: [{ ...kept, is_cover: true }] });
    await discardStagedPhotos([kept, dropped]);
    expect(await photoBlob(kept.id, 'full')).toBeDefined();
    expect(await photoBlob(dropped.id, 'full')).toBeUndefined();
    expect(await photoBlob(dropped.id, 'thumb')).toBeUndefined();
    expect(watchedStagedPhotos()).not.toContain(dropped.id);
  });

  it('reconcilePhotoUploads re-queues stored pending photos after an interrupted session', async () => {
    const a = await addPhoto(project.id, new Blob(['a'], { type: 'image/jpeg' }));
    const staged = await stagePhoto(project.id, compressed());
    stopWatchingStagedPhotos();
    mocks.enqueue.mockClear();
    expect(await reconcilePhotoUploads()).toBe(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(a.id);
    expect(mocks.enqueue).not.toHaveBeenCalledWith(staged.id);
    mocks.enqueue.mockClear();
    expect(await reconcilePhotoUploads(project.id)).toBe(1);
    expect(await reconcilePhotoUploads(tid(0x80))).toBe(0);
  });
});

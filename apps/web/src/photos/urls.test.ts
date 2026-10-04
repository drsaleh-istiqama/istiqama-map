import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newRow, putPhotoBlob, type Row } from '../db';
import { freshDb } from '../db/testing/factory';
import {
  setPhotoStorage,
  SIGNED_URL_TTL_SECONDS,
  thumbnailCacheUrl,
  type PhotoStorage,
} from './storage';
import {
  acquirePhotoUrl,
  clearPhotoUrls,
  FULL_URL_CACHE,
  liveObjectUrlCount,
  photoUrl,
  releasePhotoUrl,
  revokePhotoUrls,
  THUMB_URL_CACHE,
} from './urls';

const PROJECT = '01900000-0000-7000-8000-000000000001';

function photo(values: Partial<Row<'project_photos'>> = {}): Row<'project_photos'> {
  const row = newRow('project_photos', {
    project_id: PROJECT,
    upload_state: 'uploaded',
    ...values,
  });
  return {
    ...row,
    storage_path_full: values.storage_path_full ?? `projects/TZ/${PROJECT}/${row.id}_full.webp`,
    storage_path_thumb: values.storage_path_thumb ?? `projects/TZ/${PROJECT}/${row.id}_thumb.webp`,
  };
}

const image = (n: number, type = 'image/webp'): Blob => new Blob([new Uint8Array(n)], { type });

let created: string[];
let revoked: string[];
let storage: { [K in keyof PhotoStorage]: ReturnType<typeof vi.fn> };
let online: boolean;

beforeEach(async () => {
  await freshDb();
  clearPhotoUrls();
  created = [];
  revoked = [];
  let n = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:test/${++n}`;
    created.push(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    revoked.push(url);
  });
  online = true;
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
  storage = {
    downloadThumb: vi.fn(async () => image(40)),
    signFull: vi.fn(
      async (path: string) =>
        `http://127.0.0.1:54321/storage/v1/object/sign/photos/${path}?token=t${Math.random()}`,
    ),
    cachedThumb: vi.fn(async () => null),
  };
  setPhotoStorage(storage as unknown as PhotoStorage);
});

afterEach(() => {
  clearPhotoUrls();
  setPhotoStorage(null);
});

describe('photoUrl — preference order', () => {
  it('1. the local blob wins, for both kinds, without any network', async () => {
    const p = photo({ upload_state: 'pending' });
    await putPhotoBlob(p.id, 'thumb', image(10));
    await putPhotoBlob(p.id, 'full', image(100));
    const thumb = await photoUrl(p, 'thumb');
    const full = await photoUrl(p, 'full');
    expect(thumb).toMatch(/^blob:/);
    expect(full).toMatch(/^blob:/);
    expect(thumb).not.toBe(full);
    expect(storage.downloadThumb).not.toHaveBeenCalled();
    expect(storage.signFull).not.toHaveBeenCalled();
  });

  it('2. thumbnail of an uploaded photo: authenticated download, then served from memory', async () => {
    const p = photo();
    const a = await photoUrl(p, 'thumb');
    const b = await photoUrl(p, 'thumb');
    expect(a).toMatch(/^blob:/);
    expect(b).toBe(a);
    expect(storage.downloadThumb).toHaveBeenCalledTimes(1);
    expect(storage.downloadThumb).toHaveBeenCalledWith(p.storage_path_thumb);
    expect(created).toHaveLength(1);
  });

  it('concurrent requests for the same thumbnail share one download', async () => {
    const p = photo();
    const [a, b] = await Promise.all([photoUrl(p, 'thumb'), photoUrl(p, 'thumb')]);
    expect(a).toBe(b);
    expect(storage.downloadThumb).toHaveBeenCalledTimes(1);
  });

  it('offline: no request at all — only the service worker cache is read', async () => {
    online = false;
    const p = photo();
    expect(await photoUrl(p, 'thumb')).toBeNull();
    expect(storage.downloadThumb).not.toHaveBeenCalled();
    expect(storage.cachedThumb).toHaveBeenCalledWith(p.storage_path_thumb);

    storage.cachedThumb.mockResolvedValueOnce(image(30));
    expect(await photoUrl(photo(), 'thumb')).toMatch(/^blob:/);
    expect(await photoUrl(p, 'full')).toBeNull();
    expect(storage.signFull).not.toHaveBeenCalled();
  });

  it('a failed download falls back to the cached copy', async () => {
    storage.downloadThumb.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    storage.cachedThumb.mockResolvedValueOnce(image(30));
    expect(await photoUrl(photo(), 'thumb')).toMatch(/^blob:/);
  });

  it('3. full size: a fresh short-lived signed URL on every request, never cached', async () => {
    const p = photo();
    const a = await photoUrl(p, 'full');
    const b = await photoUrl(p, 'full');
    expect(a).toContain('/object/sign/photos/');
    expect(b).not.toBe(a);
    expect(storage.signFull).toHaveBeenCalledTimes(2);
    expect(storage.signFull).toHaveBeenCalledWith(p.storage_path_full, SIGNED_URL_TTL_SECONDS);
    expect(SIGNED_URL_TTL_SECONDS).toBeLessThanOrEqual(600);
    expect(created).toHaveLength(0);
  });

  it('nothing is requested for objects that do not exist (pending elsewhere, purged)', async () => {
    expect(await photoUrl(photo({ upload_state: 'pending' }), 'thumb')).toBeNull();
    expect(await photoUrl(photo({ upload_state: 'pending' }), 'full')).toBeNull();
    expect(await photoUrl(photo({ purged_at: '2026-10-01T00:00:00Z' }), 'thumb')).toBeNull();
    expect(storage.downloadThumb).not.toHaveBeenCalled();
    expect(storage.signFull).not.toHaveBeenCalled();
    expect(storage.cachedThumb).not.toHaveBeenCalled();
  });

  it('errors become null (the UI shows a placeholder)', async () => {
    storage.signFull.mockRejectedValueOnce(new Error('403'));
    expect(await photoUrl(photo(), 'full')).toBeNull();
  });
});

describe('object URL revocation', () => {
  it('a held full-size object URL is revoked when its last holder releases it', async () => {
    const p = photo({ upload_state: 'pending' });
    await putPhotoBlob(p.id, 'full', image(500));
    const a = await acquirePhotoUrl(p, 'full');
    const b = await acquirePhotoUrl(p, 'full');
    expect(b).toBe(a);
    releasePhotoUrl(a);
    expect(revoked).toEqual([]);
    releasePhotoUrl(b);
    expect(revoked).toEqual([a]);
    expect(liveObjectUrlCount()).toBe(0);
  });

  it('unheld full-size object URLs are capped', async () => {
    const rows = Array.from({ length: FULL_URL_CACHE + 2 }, () =>
      photo({ upload_state: 'pending' }),
    );
    for (const r of rows) await putPhotoBlob(r.id, 'full', image(50));
    const urls: string[] = [];
    for (const r of rows) urls.push((await photoUrl(r, 'full')) as string);
    expect(revoked).toEqual(urls.slice(0, 2));
    expect(liveObjectUrlCount()).toBe(FULL_URL_CACHE);
  });

  it('thumbnails live in an LRU cache; held ones are never evicted', async () => {
    const held = photo();
    const heldUrl = await acquirePhotoUrl(held, 'thumb');
    const first = photo();
    const firstUrl = await photoUrl(first, 'thumb');
    for (let i = 0; i < THUMB_URL_CACHE; i++) await photoUrl(photo(), 'thumb');
    expect(revoked).toContain(firstUrl);
    expect(revoked).not.toContain(heldUrl);
    expect(liveObjectUrlCount()).toBe(THUMB_URL_CACHE + 1);
    releasePhotoUrl(heldUrl);
    expect(revoked).toContain(heldUrl);
    expect(liveObjectUrlCount()).toBe(THUMB_URL_CACHE);
  });

  it('revokePhotoUrls frees both kinds of one photo; clearPhotoUrls frees everything', async () => {
    const p = photo({ upload_state: 'pending' });
    await putPhotoBlob(p.id, 'thumb', image(10));
    await putPhotoBlob(p.id, 'full', image(100));
    const thumb = await photoUrl(p, 'thumb');
    const full = await photoUrl(p, 'full');
    const other = await photoUrl(photo(), 'thumb');
    revokePhotoUrls(p.id);
    expect(revoked.sort()).toEqual([thumb, full].sort());
    clearPhotoUrls();
    expect(revoked).toContain(other);
    expect(liveObjectUrlCount()).toBe(0);
  });

  it('releasing a signed URL or nothing is harmless', async () => {
    const signed = await acquirePhotoUrl(photo(), 'full');
    expect(signed).toContain('token=');
    releasePhotoUrl(signed);
    releasePhotoUrl(null);
    expect(revoked).toEqual([]);
  });
});

describe('thumbnail cache key', () => {
  it('matches the service worker key: origin + /storage/v1/object/photos/<path>, no query', () => {
    expect(thumbnailCacheUrl('http://127.0.0.1:54321', 'projects/TZ/p/x_thumb.webp')).toBe(
      'http://127.0.0.1:54321/storage/v1/object/photos/projects/TZ/p/x_thumb.webp',
    );
    expect(thumbnailCacheUrl('not a url', 'x')).toBeNull();
  });
});

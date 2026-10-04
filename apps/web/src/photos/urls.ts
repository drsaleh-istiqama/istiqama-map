/**
 * Image URLs of photos (docs/contracts/web.md §3.7 `photoUrl`).
 *
 * Preference order
 *   1. the blob on this device (`photo_blobs`: photos taken here and not uploaded yet, and the
 *      thumbnails the upload queue keeps for offline display) → `blob:` object URL;
 *   2. thumbnail: authenticated download through storage (the service worker keeps it), or,
 *      offline, straight from the service worker's cache without any request;
 *   3. full size: a short-lived signed URL created on demand — online only, never cached.
 * Nothing is requested for a photo whose objects do not exist yet (`upload_state` pending on
 * another device) or were purged.
 *
 * Object URLs hold memory until revoked:
 *   - thumbnails are kept in a small LRU cache (lists re-render often) and revoked when they
 *     fall out of it, unless a component still holds them (`acquirePhotoUrl`/`usePhotoUrl`);
 *   - a full-size object URL is revoked as soon as its last holder releases it, and at most
 *     a few unheld ones are kept;
 *   - `revokePhotoUrls(photoId)` / `clearPhotoUrls()` free everything of a photo / of the app.
 */
import { photoBlob, type Row } from '../db';
import { photoStorage, SIGNED_URL_TTL_SECONDS } from './storage';

export type PhotoKind = 'thumb' | 'full';
type PhotoRef = Pick<
  Row<'project_photos'>,
  'id' | 'storage_path_full' | 'storage_path_thumb' | 'upload_state' | 'purged_at'
>;

/** Unheld thumbnails kept as object URLs (≈ 20–40 kB each). */
export const THUMB_URL_CACHE = 150;
/** Unheld full-size object URLs kept (≈ 0.2–0.6 MB each). */
export const FULL_URL_CACHE = 3;

interface Entry {
  key: string;
  photoId: string;
  kind: PhotoKind;
  url: string;
  refs: number;
  used: number;
}

const entries = new Map<string, Entry>();
const byUrl = new Map<string, Entry>();
const inflight = new Map<string, Promise<string | null>>();
let clock = 0;

const keyOf = (photoId: string, kind: PhotoKind): string => `${photoId}:${kind}`;
const isOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

function revoke(entry: Entry): void {
  entries.delete(entry.key);
  byUrl.delete(entry.url);
  try {
    URL.revokeObjectURL(entry.url);
  } catch {
    /* not an object URL any more */
  }
}

/** Revokes unheld object URLs beyond the cache sizes, least recently used first. */
function trim(): void {
  for (const kind of ['thumb', 'full'] as const) {
    const limit = kind === 'thumb' ? THUMB_URL_CACHE : FULL_URL_CACHE;
    const idle = [...entries.values()]
      .filter((e) => e.kind === kind && e.refs === 0)
      .sort((a, b) => a.used - b.used);
    for (let i = 0; i < idle.length - limit; i++) revoke(idle[i] as Entry);
  }
}

function remember(photoId: string, kind: PhotoKind, blob: Blob): string {
  const key = keyOf(photoId, kind);
  const existing = entries.get(key);
  if (existing) {
    existing.used = ++clock;
    return existing.url;
  }
  const entry: Entry = {
    key,
    photoId,
    kind,
    url: URL.createObjectURL(blob),
    refs: 0,
    used: ++clock,
  };
  entries.set(key, entry);
  byUrl.set(entry.url, entry);
  trim();
  return entry.url;
}

async function resolveUrl(photo: PhotoRef, kind: PhotoKind): Promise<string | null> {
  const local = await photoBlob(photo.id, kind);
  if (local) return remember(photo.id, kind, local);

  if (photo.purged_at) return null;
  const path = kind === 'full' ? photo.storage_path_full : photo.storage_path_thumb;
  if (!path || photo.upload_state !== 'uploaded') return null; // no object to fetch (yet)
  const storage = photoStorage();

  if (kind === 'thumb') {
    let blob: Blob | null = null;
    if (!isOffline()) {
      try {
        blob = await storage.downloadThumb(path);
      } catch {
        blob = null; // flaky link: the cached copy may still be there
      }
    }
    blob ??= await storage.cachedThumb(path);
    return blob ? remember(photo.id, kind, blob) : null;
  }

  if (isOffline()) return null;
  try {
    return await storage.signFull(path, SIGNED_URL_TTL_SECONDS);
  } catch {
    return null;
  }
}

/**
 * URL to display a photo: local blob first, else the thumbnail through storage / a signed
 * full-size URL. Null when the image is not available (offline, not uploaded yet, purged).
 * Callers that keep the URL for a while should prefer `acquirePhotoUrl` + `releasePhotoUrl`
 * (or the `usePhotoUrl` hook) so the object URL is freed when they are done.
 */
export function photoUrl(photo: PhotoRef, kind: PhotoKind): Promise<string | null> {
  const key = keyOf(photo.id, kind);
  const hit = entries.get(key);
  if (hit) {
    hit.used = ++clock;
    return Promise.resolve(hit.url);
  }
  const running = inflight.get(key);
  if (running) return running;
  const promise = resolveUrl(photo, kind).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/** `photoUrl` + hold: the object URL stays valid until `releasePhotoUrl(url)`. */
export async function acquirePhotoUrl(photo: PhotoRef, kind: PhotoKind): Promise<string | null> {
  const url = await photoUrl(photo, kind);
  if (!url) return null;
  const entry = byUrl.get(url);
  if (entry) {
    entry.refs++;
    entry.used = ++clock;
    return url;
  }
  if (!url.startsWith('blob:')) return url; // signed URL: nothing to hold
  // Evicted between resolution and hold (very large lists): resolve again.
  return acquirePhotoUrl(photo, kind);
}

/** Gives back a URL obtained from `acquirePhotoUrl`. Signed URLs are ignored. */
export function releasePhotoUrl(url: string | null | undefined): void {
  if (!url) return;
  const entry = byUrl.get(url);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs === 0 && entry.kind === 'full') revoke(entry);
  else trim();
}

/** Revokes the object URLs of a photo (its blob was dropped, or it was replaced). */
export function revokePhotoUrls(photoId: string): void {
  for (const kind of ['thumb', 'full'] as const) {
    const entry = entries.get(keyOf(photoId, kind));
    if (entry) revoke(entry);
  }
}

/** Revokes every object URL of the module (sign-out, tests). */
export function clearPhotoUrls(): void {
  for (const entry of [...entries.values()]) revoke(entry);
  inflight.clear();
}

/** Diagnostics for tests: object URLs currently alive. */
export function liveObjectUrlCount(): number {
  return entries.size;
}

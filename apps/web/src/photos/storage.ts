/**
 * Remote photo objects (bucket `photos`, private). The only file of this module that talks to
 * Supabase Storage; replaceable in tests with `setPhotoStorage()`.
 *
 *   thumbnail → authenticated download (`GET /storage/v1/object/photos/<path>`), which the
 *               service worker answers cache-first (`…_thumb.*`, ui/pwa/swRoutes.ts), so a
 *               thumbnail seen once stays available offline;
 *   full size → short-lived signed URL created on demand; the service worker never stores it
 *               (network only) and this module never keeps it.
 *
 * Uploads are not here: they belong to the sync engine's resumable photo queue.
 */
import { env } from '../env';

export const PHOTO_BUCKET = 'photos';
/** Lifetime of a signed full-size URL: long enough to load the image, short enough to leak little. */
export const SIGNED_URL_TTL_SECONDS = 300;

export interface PhotoStorage {
  /** Downloads a thumbnail with the user's session (cached by the service worker). */
  downloadThumb(path: string, signal?: AbortSignal): Promise<Blob>;
  /** A signed URL of a full-size image, valid for `expiresIn` seconds. */
  signFull(path: string, expiresIn: number): Promise<string>;
  /** The thumbnail from the service worker's cache, without any network request. */
  cachedThumb(path: string): Promise<Blob | null>;
}

class StorageRequestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageRequestError';
  }
}

/**
 * URL under which the service worker stores a thumbnail: origin + `/storage/v1/object/` +
 * bucket + path, without query string — the same key `thumbnailCacheKey()` computes for the
 * authenticated, public and signed forms of the URL.
 */
export function thumbnailCacheUrl(supabaseUrl: string, path: string): string | null {
  try {
    const origin = new URL(supabaseUrl).origin;
    return `${origin}/storage/v1/object/${PHOTO_BUCKET}/${path
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')}`;
  } catch {
    return null;
  }
}

async function bucket() {
  // Lazy: the auth module (and supabase-js) is already in the shell; importing it on demand
  // keeps this module light in unit tests that never touch the network.
  const { supabase } = await import('../auth');
  return supabase.storage.from(PHOTO_BUCKET);
}

export const supabasePhotoStorage: PhotoStorage = {
  async downloadThumb(path, signal) {
    const api = await bucket();
    const { data, error } = await api.download(path, {}, signal ? { signal } : undefined);
    if (error || !data)
      throw new StorageRequestError(error?.message ?? 'download failed', { cause: error });
    return data;
  },
  async signFull(path, expiresIn) {
    const api = await bucket();
    const { data, error } = await api.createSignedUrl(path, expiresIn);
    if (error || !data?.signedUrl)
      throw new StorageRequestError(error?.message ?? 'sign failed', { cause: error });
    return data.signedUrl;
  },
  async cachedThumb(path) {
    if (typeof caches === 'undefined') return null;
    const url = thumbnailCacheUrl(env.supabaseUrl, path);
    if (!url) return null;
    try {
      const response = await caches.match(url, { ignoreSearch: true, ignoreVary: true });
      return response && response.ok ? await response.blob() : null;
    } catch {
      return null;
    }
  },
};

let current: PhotoStorage = supabasePhotoStorage;

export function photoStorage(): PhotoStorage {
  return current;
}

/** Replace the storage adapter (tests); `null` restores the Supabase implementation. */
export function setPhotoStorage(replacement: PhotoStorage | null): void {
  current = replacement ?? supabasePhotoStorage;
}

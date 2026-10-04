/**
 * `photo_blobs`: compressed photos waiting for upload, and thumbnails kept for offline
 * display. One record per photo and kind (`full` | `thumb`). The upload queue's own state
 * (resume URLs, attempts) lives in `meta`, owned by `src/sync`.
 */
import { db, type PhotoBlobKind, type PhotoBlobRecord } from './dexie';

const blobKey = (photoId: string, kind: PhotoBlobKind): string => `${photoId}:${kind}`;

export interface PhotoBlobInfo {
  projectId?: string | null;
  mime?: string;
}

/** Stores (or replaces) the blob of a photo. */
export async function putPhotoBlob(
  photoId: string,
  kind: PhotoBlobKind,
  blob: Blob,
  info: PhotoBlobInfo = {},
): Promise<void> {
  const base: Omit<PhotoBlobRecord, 'data'> = {
    id: blobKey(photoId, kind),
    photo_id: photoId,
    kind,
    mime: info.mime ?? blob.type ?? 'application/octet-stream',
    bytes: blob.size,
    project_id: info.projectId ?? null,
    created_at: Date.now(),
  };
  try {
    await db.photo_blobs.put({ ...base, data: blob });
  } catch (err) {
    // Engines that cannot clone a Blob into IndexedDB (old WebKit, test environments):
    // store the bytes instead.
    if (!(err instanceof Error) || !/DataClone|clone/i.test(`${err.name} ${err.message}`)) throw err;
    await db.photo_blobs.put({ ...base, data: await blob.arrayBuffer() });
  }
}

/** The stored blob of a photo, or `undefined`. */
export async function photoBlob(photoId: string, kind: PhotoBlobKind): Promise<Blob | undefined> {
  const rec = await db.photo_blobs.get(blobKey(photoId, kind));
  if (!rec) return undefined;
  if (typeof Blob !== 'undefined' && rec.data instanceof Blob) return rec.data;
  return new Blob([rec.data as ArrayBuffer], { type: rec.mime });
}

/** Frees one blob (the full-size image after its upload). */
export async function dropPhotoBlob(photoId: string, kind: PhotoBlobKind): Promise<void> {
  await db.photo_blobs.delete(blobKey(photoId, kind));
}

/** Frees both blobs of a photo. */
export async function dropPhotoBlobs(photoId: string): Promise<void> {
  await db.photo_blobs.where('photo_id').equals(photoId).delete();
}

/** Bytes held in `photo_blobs` (settings: storage usage). */
export async function photoBlobBytes(): Promise<number> {
  let total = 0;
  await db.photo_blobs.each((rec) => {
    total += rec.bytes;
  });
  return total;
}

/**
 * Frees blobs that nothing on the device refers to any more: no `project_photos` row, no
 * queued or rejected operation for the photo and no upload-queue entry in `meta`
 * (`<uploadMetaPrefix><photo id>`). Run it after a completed pull that followed a scope
 * reset. Returns the number of blobs removed.
 */
export async function pruneOrphanPhotoBlobs(uploadMetaPrefix = 'photo_upload:'): Promise<number> {
  return db.transaction('rw', [db.photo_blobs, db.project_photos, db.outbox, db.failed_ops, db.meta], async () => {
    const photoIds = (await db.photo_blobs.orderBy('photo_id').uniqueKeys()) as string[];
    let removed = 0;
    for (const photoId of photoIds) {
      if (await db.project_photos.get(photoId)) continue;
      if ((await db.outbox.where('[table+row_id]').equals(['project_photos', photoId]).count()) > 0) continue;
      if ((await db.failed_ops.where('[table+row_id]').equals(['project_photos', photoId]).count()) > 0) continue;
      if (await db.meta.get(uploadMetaPrefix + photoId)) continue;
      removed += await db.photo_blobs.where('photo_id').equals(photoId).delete();
    }
    return removed;
  });
}

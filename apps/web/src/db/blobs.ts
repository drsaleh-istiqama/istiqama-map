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

let blobsSurviveClone: boolean | null = null;

/**
 * Whether this engine's structured clone keeps a Blob a Blob (every current browser does, and
 * stores it efficiently). Where it does not — some old WebViews, DOM emulations in tests — the
 * clone silently turns into an empty object, so the bytes are stored instead.
 */
function canStoreBlobs(sample: Blob): boolean {
  if (blobsSurviveClone !== null) return blobsSurviveClone;
  const clone = (globalThis as { structuredClone?: (value: unknown) => unknown }).structuredClone;
  if (typeof clone !== 'function') return (blobsSurviveClone = true);
  try {
    blobsSurviveClone = clone(sample) instanceof Blob;
  } catch {
    blobsSurviveClone = false;
  }
  return blobsSurviveClone;
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
    mime: info.mime || blob.type || 'application/octet-stream',
    bytes: blob.size,
    project_id: info.projectId ?? null,
    created_at: Date.now(),
  };
  // Read the bytes BEFORE opening the write (an await inside the put would end the transaction).
  if (!canStoreBlobs(blob)) {
    const bytes = await blob.arrayBuffer();
    await db.photo_blobs.put({ ...base, data: bytes });
    return;
  }
  try {
    await db.photo_blobs.put({ ...base, data: blob });
  } catch (err) {
    // Engines that refuse to clone a Blob into IndexedDB (old WebKit): store the bytes instead.
    if (!(err instanceof Error) || !/DataClone|clone/i.test(`${err.name} ${err.message}`))
      throw err;
    await db.photo_blobs.put({ ...base, data: await blob.arrayBuffer() });
  }
}

/** The stored blob of a photo, or `undefined` (also when the stored value is unreadable). */
export async function photoBlob(photoId: string, kind: PhotoBlobKind): Promise<Blob | undefined> {
  const rec = await db.photo_blobs.get(blobKey(photoId, kind));
  if (!rec) return undefined;
  const data: unknown = rec.data;
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return new Blob([data as ArrayBuffer], { type: rec.mime });
  }
  return undefined;
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

/** Upper bound of nested levels walked inside one draft (drafts are small, plain data). */
const DRAFT_WALK_DEPTH = 12;

/**
 * Adds to `found` every id of `candidates` that a stored draft mentions — as a string value or
 * as an object key, at any depth. Deliberately ignorant of the drafts' shapes (they belong to
 * the feature modules): the project form keeps the photos it staged in
 * `working.photos[].id`, the photo module keeps photos that finished after their editor was
 * gone under `photos:detached:<project id>` (`entries[].row.id`), and a future form may keep
 * them elsewhere. A photo of an unsaved form has no row and no queued operation yet: its
 * blobs are the only copy of the picture.
 */
function collectDraftReferences(value: unknown, candidates: Set<string>, found: Set<string>): void {
  const seen = new Set<object>();
  const walk = (v: unknown, depth: number): void => {
    if (typeof v === 'string') {
      if (candidates.has(v)) found.add(v);
      return;
    }
    if (!v || typeof v !== 'object' || depth > DRAFT_WALK_DEPTH || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return;
    if (typeof Blob !== 'undefined' && v instanceof Blob) return;
    for (const [key, item] of Object.entries(v as Record<string, unknown>)) {
      if (candidates.has(key)) found.add(key);
      walk(item, depth + 1);
    }
  };
  walk(value, 0);
}

/**
 * Frees blobs that nothing on the device refers to any more: no `project_photos` row, no
 * queued or rejected operation for the photo, no upload-queue entry in `meta`
 * (`<uploadMetaPrefix><photo id>`) and no stored draft that mentions the photo (a photo taken
 * in a form that was not saved yet — see `collectDraftReferences`). Run it after a completed
 * pull that followed a scope reset. Returns the number of blobs removed.
 */
export async function pruneOrphanPhotoBlobs(uploadMetaPrefix = 'photo_upload:'): Promise<number> {
  return db.transaction(
    'rw',
    [db.photo_blobs, db.project_photos, db.outbox, db.failed_ops, db.meta, db.drafts],
    async () => {
      const photoIds = (await db.photo_blobs.orderBy('photo_id').uniqueKeys()) as string[];
      const orphans = new Set<string>();
      for (const photoId of photoIds) {
        if (await db.project_photos.get(photoId)) continue;
        if (
          (await db.outbox.where('[table+row_id]').equals(['project_photos', photoId]).count()) > 0
        )
          continue;
        if (
          (await db.failed_ops
            .where('[table+row_id]')
            .equals(['project_photos', photoId])
            .count()) > 0
        )
          continue;
        if (await db.meta.get(uploadMetaPrefix + photoId)) continue;
        orphans.add(photoId);
      }
      if (orphans.size === 0) return 0;
      // Photos of unsaved forms: their only reference is the autosaved draft.
      const inDrafts = new Set<string>();
      await db.drafts.each((rec) => collectDraftReferences(rec.value, orphans, inDrafts));
      let removed = 0;
      for (const photoId of orphans) {
        if (inDrafts.has(photoId)) continue;
        removed += await db.photo_blobs.where('photo_id').equals(photoId).delete();
      }
      return removed;
    },
  );
}

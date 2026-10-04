/**
 * Writing photos to the device and handing them to the upload queue.
 *
 * Two ways in:
 *   - `addPhoto()` (contract §3.7) commits at once: compress → `photo_blobs` → `mutate()`
 *     → `enqueuePhotoUpload()`. For a project that is already stored on the device (details
 *     page, v2 migration, import).
 *   - the photo editor STAGES photos: blobs are stored at once (nothing is lost on a reload,
 *     the form's draft keeps the rows) but the row is written by the form's
 *     `saveProjectBundle()` — a new project does not exist before that, and "cancel" must be
 *     able to drop the photos with the rest of the form. Staged photos are watched: as soon
 *     as their row is stored they are queued for upload (`queuePhotoUploads` does the same
 *     explicitly and is what the form should call right after saving).
 *
 * A photo is queued only once its row exists: the queue drops entries (and blobs) of photos
 * without a row.
 *
 * Storage paths (brief §6: `projects/{country_iso2}/…`): a staged photo gets NO paths. The
 * country can still change in the form after the photo was added, and only the project's
 * final country counts: the server fills the paths on insert from the project's country
 * (schema.md §4.4) and the upload queue derives the object names from the stored project
 * (and the blob's real type, `.jpg` for the JPEG fallback) and writes them back.
 */
import { liveQuery } from 'dexie';
import { dropPhotoBlobs, mutate, publicRow, putPhotoBlob } from '../db';
import { enqueuePhotoUpload, ensureStorageSpace, isSyncError, withQuotaGuard } from '../sync';
import { compressPhoto, type CompressedPhoto } from './compress';
import {
  DETACHED_PREFIX,
  detachedRecords,
  editorOnScreen,
  forgetDetachedPhotos,
  photoBatchRunning,
} from './detached';
import { PhotoError } from './errors';
import { MAX_PHOTOS, newPhotoRow, type NewPhotoMeta, type PhotoRow } from './model';
import {
  countryIso2,
  draftKeys,
  livePhotosOf,
  localBlobKinds,
  photoIdsWithFullBlob,
  storedPhoto,
  storedPhotoIds,
  storedProject,
} from './queries';
import { revokePhotoUrls } from './urls';

function asPhotoError(e: unknown): unknown {
  if (e instanceof PhotoError) return e;
  if (isSyncError(e) && e.kind === 'storage_full')
    return new PhotoError('storage_full', 'device storage full', { cause: e });
  return e;
}

/** Stores both blobs of a compressed photo; nothing is left behind when it fails. */
export async function storePhotoBlobs(
  photoId: string,
  projectId: string,
  photo: Pick<CompressedPhoto, 'full' | 'thumb' | 'mime'>,
): Promise<void> {
  try {
    await ensureStorageSpace(photo.full.size + photo.thumb.size);
    const info = { projectId, mime: photo.mime };
    await withQuotaGuard(() => putPhotoBlob(photoId, 'thumb', photo.thumb, info));
    await withQuotaGuard(() => putPhotoBlob(photoId, 'full', photo.full, info));
  } catch (e) {
    await dropPhotoBlobs(photoId).catch(() => undefined);
    throw asPhotoError(e);
  }
}

// ---------------------------------------------------------------------------------------
// Immediate commit (contract §3.7)
// ---------------------------------------------------------------------------------------

/**
 * Adds a photo to a project stored on this device: compresses it, keeps both versions in
 * `photo_blobs`, writes the `project_photos` row through `mutate()` (it becomes the cover when
 * the project has none) and queues the upload. Works offline.
 *
 * @throws PhotoError `project_missing`, `limit_reached` (10 live photos), `storage_full`,
 *         and the compression errors (`not_image`, `too_large`, `decode_failed`, `encode_failed`)
 */
export async function addPhoto(
  projectId: string,
  file: Blob,
  meta: { category?: string; caption?: string } = {},
): Promise<PhotoRow> {
  const project = await storedProject(projectId);
  if (!project || project.deleted_at) throw new PhotoError('project_missing', projectId);
  if ((await livePhotosOf(projectId)).length >= MAX_PHOTOS) throw new PhotoError('limit_reached');

  const compressed = await compressPhoto(file);
  // Compression takes a while: count again (another call may have added one meanwhile).
  const live = await livePhotosOf(projectId);
  if (live.length >= MAX_PHOTOS) throw new PhotoError('limit_reached');

  const row = newPhotoRow(projectId, compressed, await countryIso2(project.country_id), {
    category: meta.category,
    caption: meta.caption,
    isCover: !live.some((p) => p.is_cover),
  });
  await storePhotoBlobs(row.id, projectId, compressed);
  try {
    await withQuotaGuard(() => mutate('project_photos', row.id, row, { insert: true }));
  } catch (e) {
    await dropPhotoBlobs(row.id).catch(() => undefined);
    throw asPhotoError(e);
  }
  await enqueuePhotoUpload(row.id);
  return publicRow((await storedPhoto(row.id)) ?? row);
}

// ---------------------------------------------------------------------------------------
// Staging (photo editor)
// ---------------------------------------------------------------------------------------

export type StageOptions = NewPhotoMeta;

/**
 * Stores the blobs of a compressed photo and returns its new (unsaved) row for the form.
 * The row is written by the form's save; the upload is queued once it is stored. Its storage
 * paths stay empty until then (see the header: the project's FINAL country decides them).
 */
export async function stagePhoto(
  projectId: string,
  photo: CompressedPhoto,
  options: StageOptions = {},
): Promise<PhotoRow> {
  const row = newPhotoRow(projectId, photo, null, options);
  await storePhotoBlobs(row.id, projectId, photo);
  watchStagedPhotos([row.id]);
  return row;
}

/**
 * Queues the upload of every photo of the list whose row is stored, still pending and whose
 * full-size blob is on this device. Call it right after `saveProjectBundle()`. Idempotent;
 * returns how many photos were (re)queued.
 */
export async function queuePhotoUploads(photos: ReadonlyArray<{ id: string }>): Promise<number> {
  let queued = 0;
  const saved: string[] = [];
  for (const { id } of photos) {
    const row = await storedPhoto(id);
    if (!row) continue; // not saved yet: stays watched
    unwatch(id);
    saved.push(id);
    if (row.deleted_at || row.purged_at || row.upload_state === 'uploaded') continue;
    if (!(await localBlobKinds(id)).full) continue; // taken on another device
    await enqueuePhotoUpload(id);
    queued++;
  }
  // A saved photo no longer waits for its editor (detached.ts).
  await forgetDetachedPhotos(saved).catch(() => undefined);
  return queued;
}

/**
 * Frees the blobs of photos that were staged but never saved (the user discarded the form).
 * Photos whose row is stored are left alone.
 */
export async function discardStagedPhotos(photos: ReadonlyArray<{ id: string }>): Promise<void> {
  const stored = await storedPhotoIds(photos.map((p) => p.id));
  for (const { id } of photos) {
    if (stored.has(id)) continue;
    unwatch(id);
    revokePhotoUrls(id);
    await dropPhotoBlobs(id);
  }
  await forgetDetachedPhotos(photos.map((p) => p.id)).catch(() => undefined);
}

/**
 * Safety net for interrupted sessions: queues every stored, pending photo of the device (or
 * of one project) that still has its full-size blob. Cheap — reads blob keys, not bytes.
 * Without a project (the shell runs it on start) it also frees the photos left by a form
 * that was closed while they were being prepared and that no form can reach any more.
 */
export async function reconcilePhotoUploads(projectId?: string): Promise<number> {
  const ids = await photoIdsWithFullBlob(projectId);
  const queued = await queuePhotoUploads(ids.map((id) => ({ id })));
  if (projectId === undefined) {
    await sweepDetachedPhotos().catch((error: unknown) =>
      console.warn('[photos] could not sweep detached photos', error),
    );
  }
  return queued;
}

/**
 * The user discarded the stored draft of `projectId`: also free the photos of that form that
 * finished after it was closed (detached.ts) — they were never in the draft itself. Returns
 * how many photos were freed. (For the form's "discard draft" paths.)
 */
export async function discardDetachedPhotos(projectId: string): Promise<number> {
  const record = (await detachedRecords()).find((r) => r.projectId === projectId);
  if (!record || record.rows.length === 0) return 0;
  await discardStagedPhotos(record.rows);
  return record.rows.length;
}

/**
 * Photos that finished after their form was closed (detached.ts) wait for the next editor of
 * their project. Those that no form can bring back any more — the project is neither on the
 * device nor in a stored form draft — are freed here (blobs and entry). Never touches a
 * project whose batch is still running or whose editor is on screen. Returns how many photos
 * were freed.
 */
export async function sweepDetachedPhotos(): Promise<number> {
  const records = await detachedRecords();
  if (records.length === 0) return 0;
  const keys = (await draftKeys()).filter((k) => !k.startsWith(DETACHED_PREFIX));
  let freed = 0;
  for (const { projectId, rows } of records) {
    if (photoBatchRunning(projectId) || editorOnScreen(projectId)) continue;
    const stored = await storedPhotoIds(rows.map((r) => r.id));
    const saved = rows.filter((r) => stored.has(r.id)).map((r) => r.id);
    if (saved.length > 0) await forgetDetachedPhotos(saved);
    const waiting = rows.filter((r) => !stored.has(r.id));
    if (waiting.length === 0) continue;
    const project = await storedProject(projectId);
    const reachable =
      (project !== undefined && !project.deleted_at) || keys.some((k) => k.includes(projectId));
    if (reachable) continue;
    await discardStagedPhotos(waiting);
    freed += waiting.length;
  }
  return freed;
}

// --- watcher of staged photos ------------------------------------------------------------

const watched = new Set<string>();
let subscription: { unsubscribe(): void } | null = null;
let resubscribeScheduled = false;

function resubscribe(): void {
  if (resubscribeScheduled) return;
  resubscribeScheduled = true;
  queueMicrotask(() => {
    resubscribeScheduled = false;
    subscription?.unsubscribe();
    subscription = null;
    if (watched.size === 0) return;
    const ids = [...watched];
    subscription = liveQuery(() => storedPhotoIds(ids)).subscribe({
      next: (stored) => {
        const ready = ids.filter((id) => stored.has(id) && watched.has(id));
        if (ready.length > 0) void queuePhotoUploads(ready.map((id) => ({ id })));
      },
      error: () => undefined,
    });
  });
}

function unwatch(id: string): void {
  if (watched.delete(id)) resubscribe();
}

/** Queue these staged photos for upload as soon as the form stores their rows. */
export function watchStagedPhotos(ids: readonly string[]): void {
  let changed = false;
  for (const id of ids) {
    if (!watched.has(id)) {
      watched.add(id);
      changed = true;
    }
  }
  if (changed) resubscribe();
}

/** Tests / sign-out: stop watching. */
export function stopWatchingStagedPhotos(): void {
  watched.clear();
  subscription?.unsubscribe();
  subscription = null;
}

/** Diagnostics: ids currently watched. */
export function watchedStagedPhotos(): string[] {
  return [...watched];
}

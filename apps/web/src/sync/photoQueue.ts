/**
 * Photo upload queue (brief §4.4, §6; ARCHITECTURE §3.3).
 *
 * A photo is two objects in bucket `photos`: `…/{photo_id}_thumb.{ext}` and `…_full.{ext}`.
 * The queue keeps one small entry per photo in `meta` (key `photo_upload:<photoId>`), with
 * the resumable-upload URL and acknowledged offset of each object, so an upload continues
 * where it stopped after a reload, a crash or a network drop.
 *
 * Rules:
 *  - a photo is uploaded only after its `project_photos` row AND its project have been
 *    acknowledged by the server (the storage policy checks the project);
 *  - first in, first out; the thumbnail goes first (small, makes the photo visible to others);
 *  - nothing is uploaded offline, or on a metered connection when "Wi-Fi only" is on;
 *  - when both objects are stored the row gets `upload_state = 'uploaded'` through the
 *    outbox, the full-size blob is freed and the thumbnail stays for offline display.
 */
import { type Clock, throwIfAborted, yieldToUi } from './clock';
import { type SyncErrorKind, toSyncError } from './errors';
import { photoUploadGate } from './network';
import type { DbPort, NetworkPort, PhotoKind, PrefsPort, ResumableUploader } from './ports';

export const PHOTO_BUCKET = 'photos';
export const PHOTO_META_PREFIX = 'photo_upload:';
const PART_ORDER: readonly PhotoKind[] = ['thumb', 'full'];

export interface PhotoPartState {
  done: boolean;
  /** TUS upload URL of the unfinished upload (resume across reloads). */
  uploadUrl: string | null;
  /** Bytes the server acknowledged (informational; the server's HEAD answer is authoritative). */
  offset: number;
  /** Object name the upload was started with. */
  objectName: string | null;
}

export interface PhotoUploadEntry {
  photoId: string;
  /** Queue position: enqueue time, then a per-run sequence for photos added in the same ms. */
  enqueuedAt: number;
  order: number;
  attempts: number;
  /** Not before this time (backoff of a failing photo). */
  nextAttemptAt: number;
  lastError: SyncErrorKind | null;
  parts: Record<PhotoKind, PhotoPartState>;
}

export interface PhotoQueueDeps {
  db: DbPort;
  uploader: ResumableUploader;
  net: NetworkPort;
  prefs: PrefsPort;
  clock: Clock;
}

export interface PhotoRunOptions {
  signal?: AbortSignal;
  /** Stop starting new photos after this long; the engine continues in the next cycle. */
  budgetMs?: number;
}

export interface PhotoRunOutcome {
  uploaded: number;
  /** Photos whose row or project the server has not acknowledged yet. */
  waiting: number;
  failed: number;
  /** Entries dropped because the photo no longer exists. */
  dropped: number;
  /** Photos that could be uploaded right now but were not reached (budget). */
  more: boolean;
  blocked: 'offline' | 'wifi_only' | null;
}

export interface PhotoQueue {
  enqueue(photoId: string): Promise<void>;
  pendingCount(): Promise<number>;
  list(): Promise<PhotoUploadEntry[]>;
  run(options?: PhotoRunOptions): Promise<PhotoRunOutcome>;
}

const metaKey = (photoId: string): string => `${PHOTO_META_PREFIX}${photoId}`;
const emptyPart = (): PhotoPartState => ({ done: false, uploadUrl: null, offset: 0, objectName: null });

const PATH_RE =
  /^projects\/[A-Z]{2}\/[0-9a-f-]{36}\/[0-9a-f-]{36}_(full|thumb)\.(webp|jpg|jpeg)$/;

function extensionFor(blob: Blob): 'webp' | 'jpg' {
  return blob.type === 'image/jpeg' ? 'jpg' : 'webp';
}

function contentTypeFor(objectName: string): 'image/webp' | 'image/jpeg' {
  return objectName.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
}

function acknowledged(row: Record<string, unknown> | undefined): boolean {
  return !!row && typeof row.version === 'number' && row.version > 0;
}

/** Retry delays of a failing photo: 15 s, 30 s, 1 min … capped at 30 min (4 h when refused). */
function retryDelay(kind: SyncErrorKind, attempts: number, retryAfterMs: number | undefined): number {
  const permanent = kind === 'forbidden' || kind === 'invalid' || kind === 'not_found' || kind === 'conflict';
  const base = permanent ? 10 * 60_000 : 15_000;
  const cap = permanent ? 4 * 60 * 60_000 : 30 * 60_000;
  return Math.max(retryAfterMs ?? 0, Math.min(cap, base * Math.pow(2, Math.max(0, attempts - 1))));
}

export function createPhotoQueue(deps: PhotoQueueDeps): PhotoQueue {
  const { db, uploader, net, prefs, clock } = deps;
  let orderCounter = 0;

  async function list(): Promise<PhotoUploadEntry[]> {
    const entries = (await db.listMeta<PhotoUploadEntry>(PHOTO_META_PREFIX)).map((e) => e.value);
    return entries.sort(
      (a, b) => a.enqueuedAt - b.enqueuedAt || a.order - b.order || (a.photoId < b.photoId ? -1 : 1),
    );
  }

  function patchEntry(
    photoId: string,
    change: (entry: PhotoUploadEntry) => PhotoUploadEntry,
  ): Promise<PhotoUploadEntry | undefined> {
    // Never re-create an entry that was removed meanwhile (photo deleted, other tab finished).
    return db.updateMeta<PhotoUploadEntry>(metaKey(photoId), (cur) => (cur ? change(cur) : undefined));
  }

  function patchPart(photoId: string, kind: PhotoKind, part: Partial<PhotoPartState>): Promise<unknown> {
    return patchEntry(photoId, (e) => ({ ...e, parts: { ...e.parts, [kind]: { ...e.parts[kind], ...part } } }));
  }

  async function drop(photoId: string, alsoThumb: boolean): Promise<void> {
    await db.dropPhotoBlob(photoId, 'full');
    if (alsoThumb) await db.dropPhotoBlob(photoId, 'thumb');
    await db.deleteMeta(metaKey(photoId));
  }

  /** Object names: the row's paths when they fit the blobs, else derived from the project. */
  async function objectNames(
    entry: PhotoUploadEntry,
    row: Record<string, unknown>,
    project: Record<string, unknown>,
    blobs: Partial<Record<PhotoKind, Blob>>,
  ): Promise<Record<PhotoKind, string> | null> {
    const { photoId } = entry;
    let iso2: string | null = null;
    const names = {} as Record<PhotoKind, string>;
    for (const kind of PART_ORDER) {
      const part = entry.parts[kind];
      if (part.done && part.objectName) {
        names[kind] = part.objectName; // already stored under this name
        continue;
      }
      const stored = row[kind === 'full' ? 'storage_path_full' : 'storage_path_thumb'];
      const blob = blobs[kind];
      const storedOk = typeof stored === 'string' && PATH_RE.test(stored);
      // Keep the stored name unless the blob is of the other image type (JPEG fallback).
      if (storedOk && (!blob || contentTypeFor(stored) === (blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp'))) {
        names[kind] = stored;
        continue;
      }
      if (iso2 === null) {
        const countryId = project.country_id;
        const country = typeof countryId === 'string' ? await db.getRow('countries', countryId) : undefined;
        const code = country?.iso2;
        if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code)) return null;
        iso2 = code;
      }
      const ext = blob ? extensionFor(blob) : 'webp';
      names[kind] = `projects/${iso2}/${String(row.project_id)}/${photoId}_${kind}.${ext}`;
    }
    return names;
  }

  type OneResult = 'uploaded' | 'waiting' | 'dropped';

  async function processOne(entry: PhotoUploadEntry, signal: AbortSignal | undefined): Promise<OneResult> {
    const { photoId } = entry;
    const row = await db.getRow('project_photos', photoId);
    if (!row || (row.deleted_at !== null && row.deleted_at !== undefined)) {
      await drop(photoId, true);
      return 'dropped';
    }
    const bothDone = entry.parts.thumb.done && entry.parts.full.done;
    if (row.upload_state === 'uploaded' && !bothDone) {
      // Another device/tab finished it (or the flip was pulled back): nothing left to send.
      await drop(photoId, false);
      return 'dropped';
    }
    if (!acknowledged(row)) return 'waiting';
    const project = typeof row.project_id === 'string' ? await db.getRow('projects', row.project_id) : undefined;
    if (!project || !acknowledged(project)) return 'waiting';

    const blobs: Partial<Record<PhotoKind, Blob>> = {};
    for (const kind of PART_ORDER) {
      if (entry.parts[kind].done) continue;
      const blob = await db.photoBlob(photoId, kind);
      if (!blob) {
        // Nothing to upload any more (blob evicted or removed): give up on this entry
        // without touching the row — the photo editor shows it as missing.
        await db.deleteMeta(metaKey(photoId));
        return 'dropped';
      }
      blobs[kind] = blob;
    }
    const names = await objectNames(entry, row, project, blobs);
    if (!names) return 'waiting'; // the project's country is not known locally yet

    for (const kind of PART_ORDER) {
      const part = entry.parts[kind];
      const blob = blobs[kind];
      if (part.done || !blob) continue;
      throwIfAborted(signal);
      const objectName = names[kind];
      // A stored URL belongs to one object name; never resume it under another name.
      const resumeUrl = part.objectName === objectName ? part.uploadUrl : null;
      if (part.objectName !== objectName) await patchPart(photoId, kind, { objectName, uploadUrl: null, offset: 0 });
      const abort = new AbortController();
      const forward = (): void => abort.abort();
      signal?.addEventListener('abort', forward, { once: true });
      const writes: Array<Promise<unknown>> = [];
      try {
        await uploader.upload({
          blob,
          bucket: PHOTO_BUCKET,
          objectName,
          contentType: contentTypeFor(objectName),
          uploadUrl: resumeUrl,
          onUploadUrl: (url) => writes.push(patchPart(photoId, kind, { uploadUrl: url, objectName })),
          onProgress: (offset) => writes.push(patchPart(photoId, kind, { offset })),
          signal: abort.signal,
        });
      } finally {
        signal?.removeEventListener('abort', forward);
        await Promise.allSettled(writes);
      }
      await patchPart(photoId, kind, { done: true, uploadUrl: null, offset: blob.size });
    }

    // Both objects exist. Flip the row through the outbox, then free the big blob.
    const patch: Record<string, unknown> = {};
    if (row.upload_state !== 'uploaded') patch.upload_state = 'uploaded';
    if (row.storage_path_full !== names.full) patch.storage_path_full = names.full;
    if (row.storage_path_thumb !== names.thumb) patch.storage_path_thumb = names.thumb;
    if (Object.keys(patch).length > 0) await db.mutate('project_photos', photoId, patch);
    await db.dropPhotoBlob(photoId, 'full');
    await db.deleteMeta(metaKey(photoId));
    return 'uploaded';
  }

  return {
    async enqueue(photoId) {
      const now = clock.now();
      const order = orderCounter++;
      await db.updateMeta<PhotoUploadEntry>(
        metaKey(photoId),
        (cur) =>
          cur ?? {
            photoId,
            enqueuedAt: now,
            order,
            attempts: 0,
            nextAttemptAt: 0,
            lastError: null,
            parts: { thumb: emptyPart(), full: emptyPart() },
          },
      );
    },

    async pendingCount() {
      return (await db.listMeta<PhotoUploadEntry>(PHOTO_META_PREFIX)).length;
    },

    list,

    async run(options = {}) {
      const signal = options.signal;
      const outcome: PhotoRunOutcome = { uploaded: 0, waiting: 0, failed: 0, dropped: 0, more: false, blocked: null };
      const deadline = clock.now() + (options.budgetMs ?? 90_000);
      const entries = await list();
      if (entries.length === 0) return outcome;

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i] as PhotoUploadEntry;
        throwIfAborted(signal);
        const gate = photoUploadGate(net, prefs);
        if (!gate.ok) {
          outcome.blocked = gate.reason;
          break;
        }
        if (clock.now() >= deadline) {
          outcome.more = true;
          break;
        }
        if (entry.nextAttemptAt > clock.now()) {
          outcome.failed++;
          continue;
        }
        try {
          const result = await processOne(entry, signal);
          if (result === 'uploaded') outcome.uploaded++;
          else if (result === 'waiting') outcome.waiting++;
          else outcome.dropped++;
        } catch (e) {
          const err = toSyncError(e);
          // Stop requests are not failures: the stored URL lets the upload resume later.
          if (err.kind === 'aborted') {
            if (!net.isOnline()) {
              outcome.blocked = 'offline';
              break;
            }
            throw err;
          }
          // The session is unusable or the device is full: the engine has to deal with it.
          if (err.fatalForSession || err.kind === 'storage_full') throw err;
          outcome.failed++;
          await patchEntry(entry.photoId, (cur) => ({
            ...cur,
            attempts: cur.attempts + 1,
            lastError: err.kind,
            nextAttemptAt: clock.now() + retryDelay(err.kind, cur.attempts + 1, err.retryAfterMs),
          }));
          // Connectivity trouble hits every photo alike: leave the rest for the next cycle.
          if (err.kind === 'network' || err.kind === 'timeout' || err.kind === 'rate_limited') {
            if (!net.isOnline()) outcome.blocked = 'offline';
            break;
          }
        }
        await yieldToUi(clock, signal);
      }
      return outcome;
    },
  };
}

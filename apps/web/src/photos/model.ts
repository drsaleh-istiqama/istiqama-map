/**
 * Pure rules of a project's photo list (the editor's state = the form's `photos` array):
 * at most 10 live photos (brief §6.3), exactly one cover while there are photos, a retake
 * takes the place, type, caption and cover flag of the photo it replaces.
 */
import { newRow, PHOTO_CATEGORIES, type Row } from '../db';
import type { CompressedPhoto, PhotoMime } from './compress';

export type PhotoRow = Row<'project_photos'>;
export type PhotoCategory = PhotoRow['category'];

export const MAX_PHOTOS = 10;
export const CAPTION_MAX_LENGTH = 160;

export const isLivePhoto = (p: Pick<PhotoRow, 'deleted_at'>): boolean =>
  p.deleted_at === null || p.deleted_at === undefined;

export function livePhotos(photos: readonly PhotoRow[]): PhotoRow[] {
  return photos.filter(isLivePhoto);
}

export function remainingSlots(photos: readonly PhotoRow[], max = MAX_PHOTOS): number {
  return Math.max(0, max - livePhotos(photos).length);
}

/**
 * Exactly one live cover when there is at least one live photo: keeps the first live cover,
 * else promotes the first live photo. Deleted rows never carry the flag (server rule §4.4).
 * Rows that do not change keep their identity.
 */
export function withSingleCover(photos: readonly PhotoRow[]): PhotoRow[] {
  const coverId =
    photos.find((p) => isLivePhoto(p) && p.is_cover)?.id ?? photos.find(isLivePhoto)?.id ?? null;
  return photos.map((p) => {
    const want = p.id === coverId;
    return p.is_cover === want ? p : { ...p, is_cover: want };
  });
}

export function setCover(photos: readonly PhotoRow[], photoId: string): PhotoRow[] {
  if (!photos.some((p) => p.id === photoId && isLivePhoto(p))) return [...photos];
  return photos.map((p) => {
    const want = p.id === photoId;
    return p.is_cover === want ? p : { ...p, is_cover: want };
  });
}

export function addPhotoRow(photos: readonly PhotoRow[], row: PhotoRow): PhotoRow[] {
  return withSingleCover([...photos, row]);
}

/** Removes a photo from the list (a stored one is soft-deleted when the form is saved). */
export function removePhotoRow(photos: readonly PhotoRow[], photoId: string): PhotoRow[] {
  return withSingleCover(photos.filter((p) => p.id !== photoId));
}

/** A retake: the new row takes the old one's position, type, caption and cover flag. */
export function replacePhotoRow(
  photos: readonly PhotoRow[],
  oldId: string,
  row: PhotoRow,
): PhotoRow[] {
  const index = photos.findIndex((p) => p.id === oldId);
  if (index < 0) return addPhotoRow(photos, row);
  const old = photos[index] as PhotoRow;
  const next = [...photos];
  next[index] = { ...row, category: old.category, caption: old.caption, is_cover: old.is_cover };
  return withSingleCover(next);
}

export function updatePhotoRow(
  photos: readonly PhotoRow[],
  photoId: string,
  patch: Partial<Pick<PhotoRow, 'category' | 'caption'>>,
): PhotoRow[] {
  return photos.map((p) => (p.id === photoId ? { ...p, ...patch } : p));
}

export function extensionOf(mime: PhotoMime): 'webp' | 'jpg' {
  return mime === 'image/jpeg' ? 'jpg' : 'webp';
}

/**
 * Object names in bucket `photos` (schema.md §4.4 CHECK):
 * `projects/{ISO2}/{project_id}/{photo_id}_{full|thumb}.{webp|jpg}`.
 */
export function storagePaths(
  iso2: string,
  projectId: string,
  photoId: string,
  mime: PhotoMime,
): { full: string; thumb: string } {
  const ext = extensionOf(mime);
  const base = `projects/${iso2}/${projectId}/${photoId}`;
  return { full: `${base}_full.${ext}`, thumb: `${base}_thumb.${ext}` };
}

export interface NewPhotoMeta {
  category?: PhotoCategory | string | null;
  caption?: string | null;
  isCover?: boolean;
}

export function isPhotoCategory(value: unknown): value is PhotoCategory {
  return typeof value === 'string' && (PHOTO_CATEGORIES as readonly string[]).includes(value);
}

export function cleanCaption(caption: string | null | undefined): string | null {
  const text = (caption ?? '').trim().slice(0, CAPTION_MAX_LENGTH);
  return text === '' ? null : text;
}

/**
 * A new `project_photos` row for a compressed photo (not stored yet). With `iso2` null — a
 * photo staged in the form, whose country may still change, or an unknown country — the paths
 * stay null: the server fills them on insert from the project's country (schema.md §4.4) and
 * the upload queue derives the object names from the stored project and writes them back.
 */
export function newPhotoRow(
  projectId: string,
  photo: Pick<CompressedPhoto, 'full' | 'width' | 'height' | 'takenAt' | 'mime'>,
  iso2: string | null,
  meta: NewPhotoMeta = {},
): PhotoRow {
  const row = newRow('project_photos', {
    project_id: projectId,
    taken_at: photo.takenAt,
    width: photo.width,
    height: photo.height,
    bytes: photo.full.size,
    is_cover: meta.isCover ?? false,
    category: isPhotoCategory(meta.category) ? meta.category : 'unspecified',
    caption: cleanCaption(meta.caption),
    upload_state: 'pending',
  });
  if (iso2) {
    const paths = storagePaths(iso2, projectId, row.id, photo.mime);
    row.storage_path_full = paths.full;
    row.storage_path_thumb = paths.thumb;
  }
  return row;
}

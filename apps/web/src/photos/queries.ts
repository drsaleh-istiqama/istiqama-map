/**
 * Read-only queries of the photo module on top of the exported Dexie instance
 * (docs/contracts/web.md §5: feature modules never edit `src/db`; their own queries live here).
 */
import { db, type Row } from '../db';

export type PhotoRow = Row<'project_photos'>;

const isLive = (row: { deleted_at?: string | null }): boolean =>
  row.deleted_at === null || row.deleted_at === undefined;

/** ISO2 code of a country stored on the device, or null. */
export async function countryIso2(countryId: string | null | undefined): Promise<string | null> {
  if (!countryId) return null;
  const country = await db.countries.get(countryId);
  const code = country?.iso2;
  return typeof code === 'string' && /^[A-Z]{2}$/.test(code) ? code : null;
}

/** The project row on the device (live or not), or undefined. */
export function storedProject(projectId: string): Promise<Row<'projects'> | undefined> {
  return db.projects.get(projectId);
}

/** Live photos of a project stored on the device. */
export async function livePhotosOf(projectId: string): Promise<PhotoRow[]> {
  const rows = await db.project_photos.where('project_id').equals(projectId).toArray();
  return rows.filter(isLive);
}

/** The stored photo row, or undefined (a photo staged in a form has none yet). */
export function storedPhoto(photoId: string): Promise<PhotoRow | undefined> {
  return db.project_photos.get(photoId);
}

/** Ids among `photoIds` that have a stored row. */
export async function storedPhotoIds(photoIds: readonly string[]): Promise<Set<string>> {
  if (photoIds.length === 0) return new Set();
  const rows = await db.project_photos.bulkGet([...photoIds]);
  return new Set(rows.filter((r): r is PhotoRow => r !== undefined).map((r) => r.id));
}

/** Which kinds of blob the device holds for a photo. */
export async function localBlobKinds(photoId: string): Promise<{ full: boolean; thumb: boolean }> {
  const keys = (await db.photo_blobs
    .where(':id')
    .anyOf([`${photoId}:full`, `${photoId}:thumb`])
    .primaryKeys()) as string[];
  return { full: keys.includes(`${photoId}:full`), thumb: keys.includes(`${photoId}:thumb`) };
}

/** Records of the `drafts` store whose key starts with `prefix` (key range on the primary key). */
export async function detachedRecordValues(
  prefix: string,
): Promise<Array<{ key: string; value: unknown }>> {
  const recs = await db.drafts.where('key').startsWith(prefix).toArray();
  return recs.map((r) => ({ key: r.key, value: r.value }));
}

/** Every key of the `drafts` store (form drafts are keyed by their project id). */
export async function draftKeys(): Promise<string[]> {
  return (await db.drafts.toCollection().primaryKeys()) as string[];
}

/** Photo ids that have a full-size blob on the device (candidates for the upload queue). */
export async function photoIdsWithFullBlob(projectId?: string): Promise<string[]> {
  // Primary keys only (`<photo id>:<kind>`): never materialise the image bytes.
  const keys = (
    projectId
      ? await db.photo_blobs.where('project_id').equals(projectId).primaryKeys()
      : await db.photo_blobs.toCollection().primaryKeys()
  ) as string[];
  return keys.filter((k) => k.endsWith(':full')).map((k) => k.slice(0, -':full'.length));
}

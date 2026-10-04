/**
 * Peer modules the form uses (docs/contracts/web.md §3.7, §3.8, §5): the photo editor and
 * upload helpers (`src/photos`), the person picker (`src/people/PersonPicker.tsx`) and the map
 * location picker (`src/map`). All are loaded lazily — the form chunk stays small and MapLibre
 * never enters it. A chunk that cannot be fetched resolves to null and the form falls back
 * (notice / minimal picker) instead of breaking.
 */
import type { ComponentType } from 'preact';
import type * as MapModule from '../../map';
import type { PersonPickerProps, PersonSelection } from '../../people/PersonPicker';
import type * as PhotosApi from '../../photos';
import type { PhotoEditorProps } from '../../photos';

export type { PersonPickerProps, PhotoEditorProps };
export type PersonPickerSelection = PersonSelection;
export type NewPersonInput = Extract<PersonSelection, { newPerson: unknown }>['newPerson'];
export type PickLocation = (typeof MapModule)['pickLocation'];

type PhotosModule = typeof PhotosApi;

function quiet<T>(p: Promise<T>): Promise<T | null> {
  return p.catch((error: unknown) => {
    console.warn('[form] peer module failed to load', error);
    return null;
  });
}

let photos: Promise<PhotosModule | null> | null = null;
function loadPhotos(): Promise<PhotosModule | null> {
  photos ??= quiet(import('../../photos'));
  return photos;
}

/** The `<PhotoEditor>` of `src/photos`, or null when it cannot be loaded. */
export async function loadPhotoEditor(): Promise<ComponentType<PhotoEditorProps> | null> {
  return (await loadPhotos())?.PhotoEditor ?? null;
}

/** The `<PersonPicker>` of `src/people`, or null when it cannot be loaded. */
export async function loadPersonPicker(): Promise<ComponentType<PersonPickerProps> | null> {
  return (await quiet(import('../../people/PersonPicker')))?.default ?? null;
}

/** `pickLocation` of `src/map`, or null when the map module cannot be loaded. */
export async function loadPickLocation(): Promise<PickLocation | null> {
  return (await quiet(import('../../map')))?.pickLocation ?? null;
}

/** After `saveProjectBundle()`: hand the staged photos of the bundle to the upload queue. */
export async function queuePhotoUploads(rows: ReadonlyArray<{ id: string }>): Promise<void> {
  if (rows.length === 0) return;
  const m = await loadPhotos();
  if (m) await m.queuePhotoUploads(rows);
}

/** Discarded form: free the blobs of photos that were staged but never saved. */
export async function discardStagedPhotos(rows: ReadonlyArray<{ id: string }>): Promise<void> {
  if (rows.length === 0) return;
  const m = await loadPhotos();
  if (m) await m.discardStagedPhotos(rows);
}

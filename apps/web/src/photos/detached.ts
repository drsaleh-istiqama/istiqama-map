/**
 * Photos that finish after their editor is gone (brief §7.4, v2 parity 5.8).
 *
 * The form is a route: a nav-bar tap or the Android back button unmounts it while the editor
 * may still be compressing a batch. The form stores its draft on unmount, but a photo that
 * finished afterwards used to reach a callback nobody listened to: missing from the draft,
 * its blobs orphaned on the device. Now:
 *   - the batch goes on (the user chose these photos); each finished photo is staged as
 *     usual and RECORDED here under its project — durably, in the `drafts` store, under the
 *     photo module's own key `photos:detached:<project id>`;
 *   - an editor of that project on screen receives it at once (`listenDetachedPhotos`);
 *     otherwise the next editor opened for the project (restored draft, edit form) takes it
 *     back into the form (`detachedPhotosOf`), and the form autosaves it with its draft;
 *   - an entry is forgotten as soon as its photo is saved (row stored) or discarded
 *     (`forgetDetachedPhotos`, called by persist.ts);
 *   - entries no form can reach any more are freed on start (`sweepDetachedPhotos` in
 *     persist.ts, run by `reconcilePhotoUploads()`);
 *   - while a batch runs, reloading or closing the page asks for confirmation.
 *
 * Writes go through the exported `drafts` API only (feature modules never write `src/db`
 * tables directly) and are serialised here, so that two finishing photos never overwrite
 * each other's entry.
 */
import { signal, type ReadonlySignal } from '@preact/signals';
import { drafts, getLocalSession } from '../db';
import { t } from '../i18n';
import type { PhotoRow } from './model';
import { detachedRecordValues, localBlobKinds, storedPhotoIds } from './queries';

export const DETACHED_PREFIX = 'photos:detached:';
const keyOf = (projectId: string): string => `${DETACHED_PREFIX}${projectId}`;

interface DetachedEntry {
  /** Local session user when the photo was chosen (drafts are per user). */
  userId: string | null;
  row: PhotoRow;
}
interface DetachedRecord {
  v: 1;
  projectId: string;
  entries: DetachedEntry[];
}

function isRecord(value: unknown): value is DetachedRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<DetachedRecord>;
  return (
    r.v === 1 &&
    typeof r.projectId === 'string' &&
    Array.isArray(r.entries) &&
    r.entries.every(
      (e) =>
        !!e &&
        typeof e === 'object' &&
        !!e.row &&
        typeof (e.row as { id?: unknown }).id === 'string',
    )
  );
}

// --- serialised read-modify-write --------------------------------------------------------
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

async function currentUser(): Promise<string | null> {
  try {
    return (await getLocalSession()).userId ?? null;
  } catch {
    return null;
  }
}

// --- editors on screen ---------------------------------------------------------------------
type Listener = (rows: PhotoRow[]) => void;
const listeners = new Map<string, Set<Listener>>();

/** An editor of `projectId` is on screen: late photos of that project go to it at once. */
export function listenDetachedPhotos(projectId: string, listener: Listener): () => void {
  let set = listeners.get(projectId);
  if (!set) listeners.set(projectId, (set = new Set()));
  set.add(listener);
  return () => {
    const current = listeners.get(projectId);
    current?.delete(listener);
    if (current && current.size === 0) listeners.delete(projectId);
  };
}

/** True while an editor of this project is on screen. */
export function editorOnScreen(projectId: string): boolean {
  return (listeners.get(projectId)?.size ?? 0) > 0;
}

// --- the durable record --------------------------------------------------------------------

/**
 * Keeps staged photos whose editor is gone (or now shows another project) for their project,
 * and hands them to an editor of that project that is on screen.
 */
export async function recordDetachedPhotos(projectId: string, rows: PhotoRow[]): Promise<void> {
  if (rows.length === 0) return;
  const userId = await currentUser();
  await serial(async () => {
    const key = keyOf(projectId);
    const value = await drafts.get(key);
    const previous = isRecord(value) ? value.entries : [];
    const ids = new Set(rows.map((r) => r.id));
    const record: DetachedRecord = {
      v: 1,
      projectId,
      entries: [
        ...previous.filter((e) => !ids.has(e.row.id)),
        ...rows.map((row) => ({ userId, row })),
      ],
    };
    await drafts.put(key, record);
  });
  for (const listener of [...(listeners.get(projectId) ?? [])]) listener(rows);
}

/**
 * The photos of this user waiting for an editor of `projectId`: staged (blobs on the device)
 * and not saved yet. Entries whose photo was saved or whose blobs are gone are forgotten.
 */
export async function detachedPhotosOf(projectId: string): Promise<PhotoRow[]> {
  const value = await drafts.get(keyOf(projectId));
  if (!isRecord(value)) return [];
  const userId = await currentUser();
  const rows = value.entries.filter((e) => e.userId === userId).map((e) => e.row);
  const stored = await storedPhotoIds(rows.map((r) => r.id));
  const usable: PhotoRow[] = [];
  const stale: string[] = [];
  for (const row of rows) {
    if (stored.has(row.id) || !(await localBlobKinds(row.id)).full) stale.push(row.id);
    else usable.push(row);
  }
  if (stale.length > 0) await forgetDetachedPhotos(stale);
  return usable;
}

/** Every record (all users), for the start-up sweep. */
export async function detachedRecords(): Promise<Array<{ projectId: string; rows: PhotoRow[] }>> {
  const out: Array<{ projectId: string; rows: PhotoRow[] }> = [];
  for (const { value } of await detachedRecordValues(DETACHED_PREFIX)) {
    if (isRecord(value))
      out.push({ projectId: value.projectId, rows: value.entries.map((e) => e.row) });
  }
  return out;
}

/** These photos were saved or discarded: drop their entries (records left empty go). */
export function forgetDetachedPhotos(photoIds: readonly string[]): Promise<void> {
  if (photoIds.length === 0) return Promise.resolve();
  const drop = new Set(photoIds);
  return serial(async () => {
    for (const { key, value } of await detachedRecordValues(DETACHED_PREFIX)) {
      if (!isRecord(value)) {
        await drafts.remove(key); // unreadable entry under our own prefix
        continue;
      }
      const left = value.entries.filter((e) => !drop.has(e.row.id));
      if (left.length === value.entries.length) continue;
      if (left.length === 0) await drafts.remove(key);
      else await drafts.put(key, { ...value, entries: left });
    }
  });
}

// --- running batches -----------------------------------------------------------------------
const batches = signal<ReadonlyMap<string, number>>(new Map());
/** Projects with a photo batch still being compressed (count per project). */
export const activePhotoBatches: ReadonlySignal<ReadonlyMap<string, number>> = batches;

/** True while a batch of this project is being compressed (reading it subscribes). */
export function photoBatchRunning(projectId: string): boolean {
  return (batches.value.get(projectId) ?? 0) > 0;
}

function onBeforeUnload(event: BeforeUnloadEvent): string {
  // Reloading or closing the page would drop the photos still being prepared.
  event.preventDefault();
  const text = t('photos.busy');
  event.returnValue = text; // older engines need a non-empty value to ask
  return text;
}

function setBatches(next: Map<string, number>): void {
  const wasRunning = batches.peek().size > 0;
  batches.value = next;
  const running = next.size > 0;
  if (typeof window === 'undefined' || wasRunning === running) return;
  if (running) window.addEventListener('beforeunload', onBeforeUnload);
  else window.removeEventListener('beforeunload', onBeforeUnload);
}

/** A batch of `projectId` starts; call the returned function (once) when it ends. */
export function beginPhotoBatch(projectId: string): () => void {
  const next = new Map(batches.peek());
  next.set(projectId, (next.get(projectId) ?? 0) + 1);
  setBatches(next);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const after = new Map(batches.peek());
    const n = (after.get(projectId) ?? 0) - 1;
    if (n > 0) after.set(projectId, n);
    else after.delete(projectId);
    setBatches(after);
  };
}

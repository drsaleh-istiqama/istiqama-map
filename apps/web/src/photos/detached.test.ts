/**
 * Photos that finished after their editor was gone (detached.ts) and their clean-up
 * (persist.ts): kept per project, handed to an editor on screen, forgotten once saved or
 * discarded, freed on start when no form can bring them back; the page asks before closing
 * while a batch runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyServerRows,
  db,
  drafts,
  loadProjectBundle,
  photoBlob,
  saveProjectBundle,
  type Row,
} from '../db';
import { freshDb, serverProject, serverRow, tid } from '../db/testing/factory';
import type { CompressedPhoto } from './compress';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(async (_id: string) => undefined),
}));

vi.mock('../sync', () => ({
  enqueuePhotoUpload: mocks.enqueue,
  ensureStorageSpace: async () => undefined,
  withQuotaGuard: async <T>(fn: () => Promise<T>) => fn(),
  isSyncError: () => false,
}));

const {
  activePhotoBatches,
  beginPhotoBatch,
  DETACHED_PREFIX,
  detachedPhotosOf,
  detachedRecords,
  editorOnScreen,
  forgetDetachedPhotos,
  listenDetachedPhotos,
  photoBatchRunning,
  recordDetachedPhotos,
} = await import('./detached');
const {
  discardDetachedPhotos,
  discardStagedPhotos,
  queuePhotoUploads,
  reconcilePhotoUploads,
  stagePhoto,
  stopWatchingStagedPhotos,
  sweepDetachedPhotos,
} = await import('./persist');

function compressed(): CompressedPhoto {
  return {
    full: new Blob([new Uint8Array(3000).fill(1)], { type: 'image/webp' }),
    thumb: new Blob([new Uint8Array(300).fill(2)], { type: 'image/webp' }),
    width: 1600,
    height: 1200,
    takenAt: null,
    mime: 'image/webp',
  };
}

let countryId: string;
let project: Row<'projects'>;

beforeEach(async () => {
  await freshDb();
  mocks.enqueue.mockClear();
  countryId = tid(0x10);
  await applyServerRows('countries', [
    serverRow('countries', {
      id: countryId,
      iso2: 'TZ',
      iso3: 'TZA',
      name_ar: 'تنزانيا',
      name_en: 'Tanzania',
      name_sw: 'Tanzania',
      active: true,
    }),
  ]);
  project = serverProject({ country_id: countryId });
  await applyServerRows('projects', [project]);
});

afterEach(() => {
  stopWatchingStagedPhotos();
});

describe('the detached record', () => {
  it('keeps staged photos per project, durably, without touching form drafts', async () => {
    const newId = tid(0x80);
    const a = await stagePhoto(newId, compressed());
    const b = await stagePhoto(newId, compressed());
    await recordDetachedPhotos(newId, [a]);
    await recordDetachedPhotos(newId, [b, a]); // the same photo twice is kept once
    expect((await detachedPhotosOf(newId)).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect((await drafts.list()).map((d) => d.key)).toEqual([`${DETACHED_PREFIX}${newId}`]);
    expect(await detachedPhotosOf(tid(0x81))).toEqual([]);
  });

  it('two photos finishing at the same moment never overwrite each other', async () => {
    const newId = tid(0x80);
    const rows = await Promise.all([1, 2, 3].map(() => stagePhoto(newId, compressed())));
    await Promise.all(rows.map((r) => recordDetachedPhotos(newId, [r])));
    expect(await detachedPhotosOf(newId)).toHaveLength(3);
  });

  it('an editor of the project on screen receives late photos at once', async () => {
    const newId = tid(0x80);
    const received: string[] = [];
    const stop = listenDetachedPhotos(newId, (rows) => received.push(...rows.map((r) => r.id)));
    expect(editorOnScreen(newId)).toBe(true);
    const a = await stagePhoto(newId, compressed());
    await recordDetachedPhotos(newId, [a]);
    expect(received).toEqual([a.id]);
    stop();
    expect(editorOnScreen(newId)).toBe(false);
    const b = await stagePhoto(newId, compressed());
    await recordDetachedPhotos(newId, [b]);
    expect(received).toEqual([a.id]);
  });

  it('only photos still waiting are handed back: saved or blob-less ones are forgotten', async () => {
    const saved = await stagePhoto(project.id, compressed());
    const lost = await stagePhoto(project.id, compressed());
    const waiting = await stagePhoto(project.id, compressed());
    await recordDetachedPhotos(project.id, [saved, lost, waiting]);
    const bundle = (await loadProjectBundle(project.id))!;
    await saveProjectBundle({ ...bundle, photos: [{ ...saved, is_cover: true }] });
    await db.photo_blobs.where('photo_id').equals(lost.id).delete();
    expect((await detachedPhotosOf(project.id)).map((r) => r.id)).toEqual([waiting.id]);
    expect((await detachedRecords())[0]?.rows.map((r) => r.id)).toEqual([waiting.id]);
  });

  it('saving (queuePhotoUploads) and discarding forget their entries; empty records go', async () => {
    const a = await stagePhoto(project.id, compressed());
    const b = await stagePhoto(project.id, compressed());
    await recordDetachedPhotos(project.id, [a, b]);
    const bundle = (await loadProjectBundle(project.id))!;
    await saveProjectBundle({ ...bundle, photos: [{ ...a, is_cover: true }] });
    await queuePhotoUploads([a]);
    expect((await detachedRecords())[0]?.rows.map((r) => r.id)).toEqual([b.id]);
    await discardStagedPhotos([b]);
    expect(await detachedRecords()).toEqual([]);
    expect(await drafts.list()).toEqual([]);
    expect(await photoBlob(b.id, 'full')).toBeUndefined();
    await forgetDetachedPhotos([]); // no-op
  });

  it('an unreadable record under the photo prefix is removed, form drafts are not', async () => {
    const id = tid(0x80);
    await drafts.put(`${DETACHED_PREFIX}${id}`, { broken: true });
    await drafts.put(`project-form:new:${id}`, { anything: 1 });
    await forgetDetachedPhotos([tid(0x99)]);
    expect((await drafts.list()).map((d) => d.key)).toEqual([`project-form:new:${id}`]);
  });
});

describe('start-up sweep', () => {
  it('frees photos no form can bring back; keeps those of a stored project or a stored draft', async () => {
    const orphanProject = tid(0x80);
    const draftProject = tid(0x81);
    const orphan = await stagePhoto(orphanProject, compressed());
    const inDraft = await stagePhoto(draftProject, compressed());
    const forStored = await stagePhoto(project.id, compressed());
    await recordDetachedPhotos(orphanProject, [orphan]);
    await recordDetachedPhotos(draftProject, [inDraft]);
    await recordDetachedPhotos(project.id, [forStored]);
    await drafts.put(`project-form:new:${draftProject}`, { v: 1 });

    expect(await sweepDetachedPhotos()).toBe(1);
    expect(await photoBlob(orphan.id, 'full')).toBeUndefined();
    expect(await photoBlob(orphan.id, 'thumb')).toBeUndefined();
    expect(await detachedPhotosOf(orphanProject)).toEqual([]);
    expect(await detachedPhotosOf(draftProject)).toHaveLength(1);
    expect(await detachedPhotosOf(project.id)).toHaveLength(1);
    expect(await photoBlob(forStored.id, 'full')).toBeDefined();
  });

  it('never touches a project whose batch still runs or whose editor is on screen', async () => {
    const running = tid(0x80);
    const shown = tid(0x81);
    const a = await stagePhoto(running, compressed());
    const b = await stagePhoto(shown, compressed());
    await recordDetachedPhotos(running, [a]);
    await recordDetachedPhotos(shown, [b]);
    const end = beginPhotoBatch(running);
    const stop = listenDetachedPhotos(shown, () => undefined);
    expect(await sweepDetachedPhotos()).toBe(0);
    end();
    stop();
    expect(await reconcilePhotoUploads()).toBe(0); // the shell's start-up call sweeps too
    expect(await detachedRecords()).toEqual([]);
    expect(await db.photo_blobs.count()).toBe(0);
  });

  it('discardDetachedPhotos(projectId) frees that project only (form: "discard draft")', async () => {
    const a = await stagePhoto(project.id, compressed());
    const otherProject = tid(0x80);
    const b = await stagePhoto(otherProject, compressed());
    await recordDetachedPhotos(project.id, [a]);
    await recordDetachedPhotos(otherProject, [b]);
    expect(await discardDetachedPhotos(project.id)).toBe(1);
    expect(await discardDetachedPhotos(project.id)).toBe(0);
    expect(await photoBlob(a.id, 'full')).toBeUndefined();
    expect(await detachedPhotosOf(otherProject)).toHaveLength(1);
  });

  it('reconcilePhotoUploads(projectId) does not sweep', async () => {
    const orphanProject = tid(0x80);
    const orphan = await stagePhoto(orphanProject, compressed());
    await recordDetachedPhotos(orphanProject, [orphan]);
    await reconcilePhotoUploads(project.id);
    expect(await detachedPhotosOf(orphanProject)).toHaveLength(1);
  });
});

describe('running batches', () => {
  it('counts batches per project and asks before the page is closed while any runs', () => {
    const fire = (): Event => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event;
    };
    expect(fire().defaultPrevented).toBe(false);
    const endA = beginPhotoBatch('p1');
    const endB = beginPhotoBatch('p1');
    expect(photoBatchRunning('p1')).toBe(true);
    expect(photoBatchRunning('p2')).toBe(false);
    expect(activePhotoBatches.value.get('p1')).toBe(2);
    expect(fire().defaultPrevented).toBe(true);
    endA();
    endA(); // ending twice counts once
    expect(photoBatchRunning('p1')).toBe(true);
    endB();
    expect(photoBatchRunning('p1')).toBe(false);
    expect(activePhotoBatches.value.size).toBe(0);
    expect(fire().defaultPrevented).toBe(false);
  });
});

/**
 * The photo editor inside the REAL project form (regressions of the Unit 3 review, "photos"):
 *   - leaving the form (nav-bar tap, Android back button) while a chosen photo is still being
 *     compressed loses neither the photo nor leaves its blobs orphaned;
 *   - a photo added before the country is corrected never carries the first country's ISO2
 *     in its storage paths (brief §6: the project's own country).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Row } from '../db';
import type { FormAccess } from '../projects/form/access';
import type { FormDraft } from '../projects/form/model';
import type * as CompressModule from './compress';
import type { CompressedPhoto } from './compress';

const mocks = vi.hoisted(() => ({
  compress: vi.fn(),
  editor: null as unknown,
}));

vi.mock('../auth', async () => {
  const { signal } = await import('@preact/signals');
  return {
    me: signal({
      user_id: 'u1',
      profile: { full_name: 'Amina' },
      scopes: { write: { branches: [], countries: [] } },
    }),
    session: signal({ user: { id: 'u1' } }),
    can: {
      write: signal(true),
      review: signal(false),
      seeRestricted: signal(false),
      seePeople: signal(true),
      admin: signal(false),
    },
    supabase: {
      from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }),
    },
  };
});
vi.mock('../sync', async () => {
  const { signal } = await import('@preact/signals');
  return {
    transport: { rpc: vi.fn(async () => []) },
    syncStatus: signal({
      online: false,
      state: 'idle',
      pendingOps: 0,
      pendingPhotos: 0,
      failedOps: 0,
      lastSyncAt: null,
      lastError: null,
    }),
    syncNow: vi.fn(async () => undefined),
    enqueuePhotoUpload: vi.fn(async () => undefined),
    ensureStorageSpace: async () => undefined,
    withQuotaGuard: async <T,>(fn: () => Promise<T>) => fn(),
    isSyncError: () => false,
  };
});
vi.mock('./compress', async (original) => ({
  ...(await original<typeof CompressModule>()),
  compressPhoto: mocks.compress,
}));
vi.mock('../projects/form/peers', async () => {
  const persist = await import('./persist');
  return {
    loadPhotoEditor: async () => mocks.editor,
    loadPersonPicker: async () => null,
    loadPickLocation: async () => null,
    queuePhotoUploads: persist.queuePhotoUploads,
    discardStagedPhotos: persist.discardStagedPhotos,
  };
});

const { db, drafts, newRow } = await import('../db');
const { PhotoEditor } = await import('./PhotoEditor');
const { reconcilePhotoUploads, stopWatchingStagedPhotos } = await import('./persist');
const { detachedPhotosOf } = await import('./detached');
const { setPhotoStorage } = await import('./storage');
const { clearPhotoUrls } = await import('./urls');
const { draftKey, newDraft } = await import('../projects/form/model');
const { ProjectForm } = await import('../projects/form/ProjectForm');

setPhotoStorage({
  downloadThumb: async () => {
    throw new Error('offline');
  },
  signFull: async () => {
    throw new Error('offline');
  },
  cachedThumb: async () => null,
});

const TZ = '01900000-0000-7000-8000-0000000000a1';
const KE = '01900000-0000-7000-8000-0000000000a2';
const ACCESS: FormAccess = {
  userId: 'u1',
  fullName: 'Amina',
  write: true,
  review: false,
  restrictedWrite: false,
  restrictedRead: false,
  branches: [],
  countries: [],
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const compressed = (tag: string): CompressedPhoto => ({
  full: new Blob([`full-${tag}`], { type: 'image/webp' }),
  thumb: new Blob([`thumb-${tag}`], { type: 'image/webp' }),
  width: 1600,
  height: 1200,
  takenAt: null,
  mime: 'image/webp',
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function renderForm(draft: FormDraft) {
  return render(
    <ProjectForm
      initial={draft}
      access={ACCESS}
      onSaved={() => undefined}
      onLeave={() => undefined}
      onOpenProject={() => undefined}
    />,
  );
}

async function chooseFiles(names: string[]): Promise<void> {
  const input = await screen.findByTestId('form-photo-input');
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: names.map((n) => new File([n], n, { type: 'image/jpeg' })),
  });
  fireEvent.change(input);
}

const storedDraft = async (d: FormDraft): Promise<FormDraft | undefined> =>
  (await drafts.get(draftKey(d.mode, d.projectId))) as FormDraft | undefined;

beforeEach(async () => {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });
  await Promise.all(db.tables.map((table) => table.clear()));
  await db.countries.bulkPut([
    newRow('countries', {
      id: TZ,
      iso2: 'TZ',
      name_ar: 'تنزانيا',
      name_en: 'Tanzania',
      active: true,
      default_currency: 'TZS',
    } as Partial<Row<'countries'>>),
    newRow('countries', {
      id: KE,
      iso2: 'KE',
      name_ar: 'كينيا',
      name_en: 'Kenya',
      active: true,
      default_currency: 'KES',
    } as Partial<Row<'countries'>>),
  ]);
  mocks.editor = PhotoEditor;
  mocks.compress.mockReset();
  clearPhotoUrls();
});

afterEach(() => {
  cleanup();
  stopWatchingStagedPhotos();
  clearPhotoUrls();
  document.body.innerHTML = '';
});

it('a photo still compressing when the form is left comes back into the restored draft', async () => {
  const draft = newDraft({ userId: 'u1', countryId: TZ });
  const view = renderForm(draft);
  fireEvent.input(screen.getByTestId('form-name'), { target: { value: 'مسجد الصور' } });
  const gates = [deferred<CompressedPhoto>(), deferred<CompressedPhoto>()];
  mocks.compress.mockImplementation(() => gates[mocks.compress.mock.calls.length - 1]!.promise);
  await chooseFiles(['a.jpg', 'b.jpg']);
  await screen.findByTestId('photo-progress');

  // The user taps another item of the navigation bar: the route unmounts the form.
  view.unmount();
  await sleep(50);
  gates[0]!.resolve(compressed('a'));
  await waitFor(() => expect(mocks.compress).toHaveBeenCalledTimes(2)); // the batch goes on
  gates[1]!.resolve(compressed('b'));

  // Both photos are kept for their project (blobs + rows), none is orphaned …
  await waitFor(async () => expect(await detachedPhotosOf(draft.projectId)).toHaveLength(2));
  expect(await db.photo_blobs.count()).toBe(4);
  const kept = await storedDraft(draft);
  expect(kept?.working.project.name_ar).toBe('مسجد الصور');

  // … and the next opening of the draft takes them back into the form, which autosaves them.
  renderForm(kept!);
  await waitFor(() => expect(screen.getAllByTestId('photo-card')).toHaveLength(2));
  expect(screen.getByTestId('photo-status').textContent).toContain(
    (await import('../i18n')).t('photos.reattached', { count: 2 }),
  );
  await waitFor(async () => expect((await storedDraft(draft))?.working.photos).toHaveLength(2), {
    timeout: 3000,
  });
  expect((await storedDraft(draft))?.working.photos.filter((p) => p.is_cover)).toHaveLength(1);

  // Opening it again does not add them twice.
  cleanup();
  renderForm((await storedDraft(draft))!);
  await waitFor(() => expect(screen.getAllByTestId('photo-card')).toHaveLength(2));
  await sleep(100);
  expect(screen.getAllByTestId('photo-card')).toHaveLength(2);
});

it('photos of a form that kept no draft are freed at the next start, not orphaned', async () => {
  const draft = newDraft({ userId: 'u1', countryId: TZ });
  const view = renderForm(draft);
  const gate = deferred<CompressedPhoto>();
  mocks.compress.mockReturnValue(gate.promise);
  await chooseFiles(['a.jpg']); // nothing typed: the form leaves no draft
  await screen.findByTestId('photo-progress');
  view.unmount();
  gate.resolve(compressed('a'));
  await waitFor(async () => expect(await detachedPhotosOf(draft.projectId)).toHaveLength(1));
  expect(await storedDraft(draft)).toBeUndefined();
  expect(await db.photo_blobs.count()).toBe(2);

  await reconcilePhotoUploads(); // what the shell runs on start
  expect(await db.photo_blobs.count()).toBe(0);
  expect(await detachedPhotosOf(draft.projectId)).toHaveLength(0);
});

it('a photo added before the country is corrected carries no stale ISO2 into the save', async () => {
  mocks.compress.mockImplementation(async (f: File) => compressed(f.name));
  let saved: FormDraft | null = null;
  const saveImpl = vi.fn(async (d: FormDraft) => {
    saved = d;
    return { photos: [] } as never;
  });
  render(
    <ProjectForm
      initial={newDraft({ userId: 'u1', countryId: TZ })}
      access={ACCESS}
      onSaved={() => undefined}
      onLeave={() => undefined}
      onOpenProject={() => undefined}
      saveImpl={saveImpl as never}
    />,
  );
  fireEvent.click(screen.getByTestId('form-type-mosque'));
  fireEvent.input(screen.getByTestId('form-name'), { target: { value: 'مسجد ممباسا' } });
  await chooseFiles(['a.jpg']);
  await screen.findByTestId('photo-card');
  // The collector corrects the country (Mombasa, Kenya) and gives the point.
  fireEvent.change(screen.getByTestId('form-country'), { target: { value: KE } });
  fireEvent.input(screen.getByTestId('form-lat'), { target: { value: '-4.05' } });
  fireEvent.input(screen.getByTestId('form-lon'), { target: { value: '39.66' } });
  await sleep(700);
  fireEvent.click(screen.getByTestId('form-save-draft'));
  await waitFor(() => expect(saveImpl).toHaveBeenCalled(), { timeout: 4000 });

  const d = saved as unknown as FormDraft;
  expect(d.working.project.country_id).toBe(KE);
  const photo = d.working.photos[0]!;
  // No path is decided while the country can still change: the server fills it on insert
  // from the project's (final) country and the upload queue writes the name it used back.
  expect(photo.storage_path_full).toBeNull();
  expect(photo.storage_path_thumb).toBeNull();
  expect(JSON.stringify(d.working.photos)).not.toContain('projects/TZ/');
});

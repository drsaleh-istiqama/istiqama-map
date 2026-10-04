import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyServerRows, db, newRow, photoBlob, putPhotoBlob } from '../db';
import { freshDb, serverRow, tid } from '../db/testing/factory';
import { t } from '../i18n';
import { Modal } from '../ui';
import type * as CompressModule from './compress';
import type { CompressedPhoto } from './compress';
import { PhotoError } from './errors';
import type { PhotoRow } from './model';

const mocks = vi.hoisted(() => ({
  compress: vi.fn(),
  enqueue: vi.fn(async (_id: string) => undefined),
}));

vi.mock('./compress', async (original) => ({
  ...(await original<typeof CompressModule>()),
  compressPhoto: mocks.compress,
}));
vi.mock('../sync', () => ({
  enqueuePhotoUpload: mocks.enqueue,
  ensureStorageSpace: async () => undefined,
  withQuotaGuard: async <T,>(fn: () => Promise<T>) => fn(),
  isSyncError: () => false,
}));

const { PhotoEditor, photoEditorBusy } = await import('./PhotoEditor');
const { stopWatchingStagedPhotos } = await import('./persist');
const { detachedPhotosOf, recordDetachedPhotos } = await import('./detached');
const { clearPhotoUrls } = await import('./urls');
const { setPhotoStorage } = await import('./storage');

// The editor must work from local blobs only: any storage request fails the expectation below.
const remote = {
  downloadThumb: vi.fn(async () => {
    throw new Error('no network in the editor tests');
  }),
  signFull: vi.fn(async () => {
    throw new Error('no network in the editor tests');
  }),
  cachedThumb: vi.fn(async () => null),
};
setPhotoStorage(remote);

const PROJECT = '01900000-0000-7000-8000-0000000000a1';
let countryId: string;

function compressed(tag: string): CompressedPhoto {
  return {
    full: new Blob([`full-${tag}`], { type: 'image/webp' }),
    thumb: new Blob([`thumb-${tag}`], { type: 'image/webp' }),
    width: 1600,
    height: 1200,
    takenAt: null,
    mime: 'image/webp',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const file = (name: string): File => new File([name], name, { type: 'image/jpeg' });

function pick(input: HTMLElement, files: File[]): void {
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  fireEvent.change(input);
}

async function existingPhoto(values: Partial<PhotoRow> = {}): Promise<PhotoRow> {
  const row = newRow('project_photos', {
    project_id: PROJECT,
    upload_state: 'pending',
    ...values,
  });
  row.storage_path_full = `projects/TZ/${PROJECT}/${row.id}_full.webp`;
  row.storage_path_thumb = `projects/TZ/${PROJECT}/${row.id}_thumb.webp`;
  await putPhotoBlob(row.id, 'thumb', new Blob(['t'], { type: 'image/webp' }), {
    projectId: PROJECT,
  });
  return row;
}

let current: PhotoRow[] = [];
const onChangeSpy = vi.fn();
const onBusy = vi.fn();
let created: string[];
let revoked: string[];

function Harness({ initial, max }: { initial: PhotoRow[]; max?: number }) {
  const [photos, setPhotos] = useState(initial);
  return (
    <PhotoEditor
      projectId={PROJECT}
      photos={photos}
      countryId={countryId}
      max={max}
      onBusyChange={onBusy}
      onChange={(next) => {
        current = next;
        onChangeSpy(next);
        setPhotos(next);
      }}
    />
  );
}

function setup(initial: PhotoRow[] = [], max?: number) {
  current = initial;
  const utils = render(<Harness initial={initial} max={max} />);
  return {
    ...utils,
    choose: () => screen.getByTestId('photo-choose') as HTMLButtonElement,
    camera: () => screen.getByTestId('photo-camera') as HTMLButtonElement,
    chooseInput: () => screen.getByTestId('form-photo-input') as HTMLInputElement,
    cameraInput: () => screen.getByTestId('photo-camera-input') as HTMLInputElement,
    cards: () => screen.queryAllByTestId('photo-card'),
    status: () => screen.getByTestId('photo-status').textContent ?? '',
  };
}

beforeEach(async () => {
  await freshDb();
  clearPhotoUrls();
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
  mocks.compress.mockReset();
  mocks.compress.mockImplementation(async (f: File) => compressed(f.name));
  mocks.enqueue.mockClear();
  onChangeSpy.mockClear();
  onBusy.mockClear();
  created = [];
  revoked = [];
  let n = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:editor/${++n}`;
    created.push(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    revoked.push(url);
  });
});

afterEach(() => {
  cleanup();
  stopWatchingStagedPhotos();
  clearPhotoUrls();
  expect(remote.signFull).not.toHaveBeenCalled();
});

describe('PhotoEditor — choosing several photos', () => {
  it('adds every chosen photo with progress, first one as cover, blobs stored, rows not saved', async () => {
    const gates = [deferred<CompressedPhoto>(), deferred<CompressedPhoto>()];
    mocks.compress.mockImplementation(() => gates[mocks.compress.mock.calls.length - 1]!.promise);
    const ui = setup();
    expect(onChangeSpy).not.toHaveBeenCalled();
    fireEvent.click(ui.choose());
    pick(ui.chooseInput(), [file('a.jpg'), file('b.jpg')]);

    await waitFor(() =>
      expect(screen.getByTestId('photo-progress').textContent).toContain(
        t('photos.processing', { current: 1, total: 2 }),
      ),
    );
    expect(ui.choose().disabled).toBe(true);
    expect(screen.getByTestId('photo-editor').dataset.busy).toBe('true');
    await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(true));
    expect(photoEditorBusy.value).toBe(true);

    gates[0]!.resolve(compressed('a'));
    await waitFor(() => expect(ui.cards()).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByTestId('photo-progress').textContent).toContain(
        t('photos.processing', { current: 2, total: 2 }),
      ),
    );
    gates[1]!.resolve(compressed('b'));
    await waitFor(() => expect(ui.cards()).toHaveLength(2));
    await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(false));
    expect(photoEditorBusy.value).toBe(false);
    expect(screen.queryByTestId('photo-progress')).toBeNull();

    expect(current.map((p) => p.is_cover)).toEqual([true, false]);
    for (const p of current) {
      expect(p.project_id).toBe(PROJECT);
      // No path while the form's country can still change (persist.ts: project's final country).
      expect(p.storage_path_full).toBeNull();
      expect(await photoBlob(p.id, 'full')).toBeDefined();
      expect(await db.project_photos.get(p.id)).toBeUndefined(); // the form saves the rows
    }
    expect(ui.status()).toContain(t('photos.added', { count: 2 }));
    expect(screen.getByTestId('photo-count').textContent).toBe(
      t('photos.count', { count: 2, max: 10 }),
    );
  });

  it('enforces the 10-photo limit with a clear message', async () => {
    const initial = [];
    for (let i = 0; i < 9; i++) initial.push(await existingPhoto({ is_cover: i === 0 }));
    const ui = setup(initial);
    fireEvent.click(ui.choose());
    pick(ui.chooseInput(), [file('1.jpg'), file('2.jpg'), file('3.jpg')]);
    await waitFor(() => expect(ui.cards()).toHaveLength(10));
    expect(mocks.compress).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(ui.status()).toContain(t('photos.skipped', { count: 2, max: 10 })));
    expect(screen.getByTestId('photo-limit').textContent).toBe(t('photos.limit', { max: 10 }));
    expect(ui.choose().disabled).toBe(true);
    expect(ui.camera().disabled).toBe(true);
    // retake stays possible at the limit
    expect((within(ui.cards()[0]!).getByTestId('photo-retake') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('reports a bad file next to its name and still adds the others', async () => {
    mocks.compress.mockImplementation(async (f: File) => {
      if (f.name === 'huge.jpg') throw new PhotoError('too_large');
      return compressed(f.name);
    });
    const ui = setup();
    fireEvent.click(ui.choose());
    pick(ui.chooseInput(), [file('huge.jpg'), file('ok.jpg')]);
    await waitFor(() => expect(ui.cards()).toHaveLength(1));
    const errors = await screen.findByTestId('photo-errors');
    expect(errors.textContent).toContain('huge.jpg');
    expect(errors.textContent).toContain(t('photos.error_too_large', { max: 25 }));
  });

  it('a cancelled picker changes nothing and Escape never reaches the parent form', async () => {
    const onClose = vi.fn();
    current = [];
    render(
      <Modal open title="form" onClose={onClose}>
        <Harness initial={[]} />
      </Modal>,
    );
    fireEvent.click(screen.getByTestId('photo-choose'));
    await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(true));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent(screen.getByTestId('form-photo-input'), new Event('cancel'));
    await waitFor(() =>
      expect(screen.getByTestId('photo-status').textContent).toBe(t('photos.pickerCancelled')),
    );
    // an Escape that trails the closing picker is still swallowed …
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(onChangeSpy).not.toHaveBeenCalled();
    // … and afterwards the form's own Escape handling is back
    await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(false), { timeout: 2000 });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('an empty selection counts as a cancelled picker', async () => {
    const ui = setup();
    fireEvent.click(ui.choose());
    pick(ui.chooseInput(), []);
    await waitFor(() => expect(ui.status()).toBe(t('photos.pickerCancelled')));
    expect(mocks.compress).not.toHaveBeenCalled();
  });
});

describe('PhotoEditor — camera: preview → accept / retake / cancel', () => {
  it('accept adds the reviewed photo; nothing is added before', async () => {
    const ui = setup();
    const click = vi.spyOn(ui.cameraInput(), 'click');
    fireEvent.click(ui.camera());
    expect(click).toHaveBeenCalledTimes(1);
    pick(ui.cameraInput(), [file('shot.jpg')]);
    const review = await screen.findByTestId('photo-review');
    const preview = within(review).getByTestId('photo-review-image') as HTMLImageElement;
    expect(preview.getAttribute('src')).toMatch(/^blob:editor\//);
    expect(ui.cards()).toHaveLength(0);
    expect(await db.photo_blobs.count()).toBe(0);
    await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(true)); // review pending blocks save

    fireEvent.click(screen.getByTestId('photo-accept'));
    await waitFor(() => expect(ui.cards()).toHaveLength(1));
    expect(screen.queryByTestId('photo-review')).toBeNull();
    expect(revoked).toContain(preview.getAttribute('src'));
    expect(current[0]?.is_cover).toBe(true);
    expect(await photoBlob(current[0]!.id, 'full')).toBeDefined();
    await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(false));
    expect(ui.status()).toContain(t('photos.accepted'));
  });

  it('cancel discards the capture and frees its preview', async () => {
    const ui = setup();
    fireEvent.click(ui.camera());
    pick(ui.cameraInput(), [file('shot.jpg')]);
    const preview = (await screen.findByTestId('photo-review-image')).getAttribute('src');
    fireEvent.click(screen.getByTestId('photo-review-cancel'));
    await waitFor(() => expect(screen.queryByTestId('photo-review')).toBeNull());
    expect(ui.cards()).toHaveLength(0);
    expect(revoked).toContain(preview);
    expect(await db.photo_blobs.count()).toBe(0);
    expect(ui.status()).toBe(t('photos.captureCancelled'));
    expect(onChangeSpy).not.toHaveBeenCalled();
  });

  it('retake from the review opens the camera again; the new capture replaces the preview', async () => {
    const ui = setup();
    fireEvent.click(ui.camera());
    pick(ui.cameraInput(), [file('first.jpg')]);
    const first = (await screen.findByTestId('photo-review-image')).getAttribute('src');
    const click = vi.spyOn(ui.cameraInput(), 'click');
    fireEvent.click(screen.getByTestId('photo-review-retake'));
    expect(click).toHaveBeenCalledTimes(1);
    // cancelling the second picker keeps the first capture in review
    fireEvent(ui.cameraInput(), new Event('cancel'));
    expect(screen.getByTestId('photo-review-image').getAttribute('src')).toBe(first);

    fireEvent.click(screen.getByTestId('photo-review-retake'));
    pick(ui.cameraInput(), [file('second.jpg')]);
    await waitFor(() =>
      expect(screen.getByTestId('photo-review-image').getAttribute('src')).not.toBe(first),
    );
    expect(revoked).toContain(first);
    fireEvent.click(screen.getByTestId('photo-accept'));
    await waitFor(() => expect(ui.cards()).toHaveLength(1));
    expect(mocks.compress.mock.calls.map((c) => (c[0] as File).name)).toEqual([
      'first.jpg',
      'second.jpg',
    ]);
  });
});

describe('PhotoEditor — per photo', () => {
  it('retake keeps the old photo until the new one is accepted, then takes its place and fields', async () => {
    const a = await existingPhoto({ is_cover: false });
    const b = await existingPhoto({ is_cover: true, category: 'other', caption: 'البوابة' });
    const ui = setup([a, b]);

    fireEvent.click(within(ui.cards()[1]!).getByTestId('photo-retake'));
    pick(ui.cameraInput(), [file('new.jpg')]);
    const review = await screen.findByTestId('photo-review');
    expect(review.textContent).toContain(t('photos.reviewReplaceHint', { n: 2 }));
    fireEvent.click(screen.getByTestId('photo-review-cancel'));
    await waitFor(() => expect(screen.queryByTestId('photo-review')).toBeNull());
    expect(ui.cards().map((c) => c.dataset.photoId)).toEqual([a.id, b.id]);
    expect(onChangeSpy).not.toHaveBeenCalled();

    fireEvent.click(within(ui.cards()[1]!).getByTestId('photo-retake'));
    pick(ui.cameraInput(), [file('new2.jpg')]);
    await screen.findByTestId('photo-review');
    fireEvent.click(screen.getByTestId('photo-accept'));
    await waitFor(() => expect(current.map((p) => p.id)).not.toContain(b.id));
    expect(current).toHaveLength(2);
    expect(current[0]?.id).toBe(a.id);
    expect(current[1]).toMatchObject({ category: 'other', caption: 'البوابة', is_cover: true });
    await waitFor(() => expect(ui.status()).toContain(t('photos.replaced', { n: 2 })));
    // b was never saved: its blob is freed
    await waitFor(async () => expect(await photoBlob(b.id, 'thumb')).toBeUndefined());
  });

  it('category select (enum.photo_category) and the caption shown for "other" only', async () => {
    const a = await existingPhoto({ is_cover: true });
    const ui = setup([a]);
    const card = ui.cards()[0]!;
    const select = within(card).getByTestId('photo-category') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toContain(
      t('enum.photo_category.mosque_front'),
    );
    expect(within(card).queryByTestId('photo-caption')).toBeNull();

    fireEvent.change(select, { target: { value: 'other' } });
    await waitFor(() => expect(current[0]?.category).toBe('other'));
    const caption = (await within(ui.cards()[0]!).findByTestId(
      'photo-caption',
    )) as HTMLInputElement;
    expect(caption.maxLength).toBe(160);
    fireEvent.input(caption, { target: { value: 'خزان الماء' } });
    await waitFor(() => expect(current[0]?.caption).toBe('خزان الماء'));

    fireEvent.change(within(ui.cards()[0]!).getByTestId('photo-category'), {
      target: { value: 'land' },
    });
    await waitFor(() => expect(current[0]?.category).toBe('land'));
    expect(within(ui.cards()[0]!).queryByTestId('photo-caption')).toBeNull();
  });

  it('delete asks first; confirming removes the photo and the cover moves on', async () => {
    const a = await existingPhoto({ is_cover: true });
    const b = await existingPhoto();
    const ui = setup([a, b]);

    fireEvent.click(within(ui.cards()[0]!).getByTestId('photo-delete'));
    fireEvent.click(await screen.findByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(ui.cards()).toHaveLength(2);
    expect(onChangeSpy).not.toHaveBeenCalled();

    fireEvent.click(within(ui.cards()[0]!).getByTestId('photo-delete'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() => expect(ui.cards()).toHaveLength(1));
    expect(current.map((p) => p.id)).toEqual([b.id]);
    expect(current[0]?.is_cover).toBe(true);
    expect(ui.cards()[0]?.dataset.cover).toBe('true');
    await waitFor(() => expect(ui.status()).toBe(t('photos.deleted')));
  });

  it('exactly one cover: marking another photo moves the flag', async () => {
    const a = await existingPhoto({ is_cover: true });
    const b = await existingPhoto();
    const c = await existingPhoto();
    const ui = setup([a, b, c]);
    const coverButton = within(ui.cards()[2]!).getByTestId('photo-cover');
    expect(coverButton.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(coverButton);
    await waitFor(() => expect(current.filter((p) => p.is_cover).map((p) => p.id)).toEqual([c.id]));
    expect(ui.cards().map((card) => card.dataset.cover)).toEqual(['false', 'false', 'true']);
    expect(within(ui.cards()[2]!).getByTestId('photo-cover').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getAllByTestId('photo-cover-badge')).toHaveLength(1);
  });

  it('shows thumbnails only (from the local blob) and never emits on mount (nothing detached)', async () => {
    const a = await existingPhoto({ is_cover: true });
    const ui = setup([a]);
    const img = await waitFor(() => {
      const el = within(ui.cards()[0]!).getByRole('img') as HTMLImageElement;
      expect(el.getAttribute('src')).toMatch(/^blob:/);
      return el;
    });
    expect(img).toBeTruthy();
    expect(await photoBlob(a.id, 'full')).toBeUndefined(); // no full-size image was needed
    expect(onChangeSpy).not.toHaveBeenCalled();
  });
});

describe('PhotoEditor — leaving the form while photos are being prepared', () => {
  const fireBeforeUnload = (): Event => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event;
  };

  it('the batch goes on after unmount; the next editor of the project takes the photos back', async () => {
    const gates = [deferred<CompressedPhoto>(), deferred<CompressedPhoto>()];
    mocks.compress.mockImplementation(() => gates[mocks.compress.mock.calls.length - 1]!.promise);
    const ui = setup();
    fireEvent.click(ui.choose());
    pick(ui.chooseInput(), [file('a.jpg'), file('b.jpg')]);
    await screen.findByTestId('photo-progress');
    expect(fireBeforeUnload().defaultPrevented).toBe(true); // reload / close asks first
    ui.unmount();
    onChangeSpy.mockClear();

    gates[0]!.resolve(compressed('a'));
    await waitFor(() => expect(mocks.compress).toHaveBeenCalledTimes(2));
    gates[1]!.resolve(compressed('b'));
    await waitFor(async () => expect(await detachedPhotosOf(PROJECT)).toHaveLength(2));
    expect(onChangeSpy).not.toHaveBeenCalled(); // never into the dead form
    expect(await db.photo_blobs.count()).toBe(4);
    await waitFor(() => expect(fireBeforeUnload().defaultPrevented).toBe(false));

    const again = setup([]);
    await waitFor(() => expect(again.cards()).toHaveLength(2));
    expect(current.map((p) => p.is_cover)).toEqual([true, false]);
    expect(again.status()).toContain(t('photos.reattached', { count: 2 }));
    expect(again.status()).toContain(t('photos.saveReminder'));
  });

  it('an editor opened while the earlier batch still runs blocks saving and receives the photos', async () => {
    const gate = deferred<CompressedPhoto>();
    mocks.compress.mockReturnValue(gate.promise);
    const ui = setup();
    fireEvent.click(ui.choose());
    pick(ui.chooseInput(), [file('a.jpg')]);
    await screen.findByTestId('photo-progress');
    ui.unmount();

    onBusy.mockClear();
    const again = setup([]);
    expect(await screen.findByTestId('photo-background')).toBeTruthy();
    expect(screen.getByTestId('photo-background').textContent).toBe(t('photos.background'));
    expect(screen.getByTestId('photo-editor').dataset.busy).toBe('true');
    await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(true)); // the form cannot save
    expect(again.choose().disabled).toBe(true);

    gate.resolve(compressed('a'));
    await waitFor(() => expect(again.cards()).toHaveLength(1));
    await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(false));
    expect(screen.queryByTestId('photo-background')).toBeNull();
    expect(again.choose().disabled).toBe(false);
  });

  it('a camera capture compressed after leaving is dropped: no blob, no preview URL', async () => {
    const gate = deferred<CompressedPhoto>();
    mocks.compress.mockReturnValue(gate.promise);
    const ui = setup();
    fireEvent.click(ui.camera());
    pick(ui.cameraInput(), [file('shot.jpg')]);
    await screen.findByTestId('photo-progress');
    ui.unmount();
    gate.resolve(compressed('shot'));
    await new Promise((r) => setTimeout(r, 50));
    expect(created).toHaveLength(0);
    expect(await db.photo_blobs.count()).toBe(0);
    expect(await detachedPhotosOf(PROJECT)).toEqual([]);
  });

  it('kept photos beyond the limit are freed with a message instead of exceeding it', async () => {
    const initial = [];
    for (let i = 0; i < 9; i++) initial.push(await existingPhoto({ is_cover: i === 0 }));
    const { stagePhoto } = await import('./persist');
    const late = [
      await stagePhoto(PROJECT, compressed('x')),
      await stagePhoto(PROJECT, compressed('y')),
    ];
    await recordDetachedPhotos(PROJECT, late);
    const ui = setup(initial);
    await waitFor(() => expect(ui.cards()).toHaveLength(10));
    await waitFor(() => expect(ui.status()).toContain(t('photos.skipped', { count: 1, max: 10 })));
    expect(ui.status()).toContain(t('photos.reattached', { count: 1 }));
    await waitFor(async () => expect(await detachedPhotosOf(PROJECT)).toHaveLength(1));
    await waitFor(async () => expect(await photoBlob(late[1]!.id, 'full')).toBeUndefined());
  });
});

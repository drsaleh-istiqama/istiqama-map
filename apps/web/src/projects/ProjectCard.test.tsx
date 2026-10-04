import { cleanup, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth', async () => (await import('./testkit')).authModule());
vi.mock('../sync', async () => (await import('./testkit')).syncModule());

import { applyServerRows, putPhotoBlob, type Row } from '../db';
import { freshDb, serverProject, serverRow } from '../db/testing/factory';
import { setLocale } from '../i18n';
import { clearPhotoUrls } from '../photos';
import { setPhotoStorage, type PhotoStorage } from '../photos/storage';
import { clearViewFilters } from '../routes';
import { COVER_DELAY_MS, CoverThumb } from './CoverThumb';
import { ProjectList } from './ProjectList';
import { resetSyncMocks, useRole } from './testkit';

const WITH_LOCAL = '00000000-0080-7000-8000-0000000000e1';
const WITH_UPLOADED = '00000000-0080-7000-8000-0000000000e2';
const WITHOUT = '00000000-0080-7000-8000-0000000000e3';

const image = (n: number): Blob => new Blob([new Uint8Array(n)], { type: 'image/webp' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let storage: { [K in keyof PhotoStorage]: ReturnType<typeof vi.fn> };

function photo(projectId: string, values: Partial<Row<'project_photos'>>): Row<'project_photos'> {
  const row = serverRow('project_photos', { project_id: projectId, ...values });
  return {
    ...row,
    storage_path_full: `projects/TZ/${projectId}/${row.id}_full.webp`,
    storage_path_thumb: `projects/TZ/${projectId}/${row.id}_thumb.webp`,
  };
}

function coverImg(id: string): HTMLImageElement | null {
  return rowOf(id).querySelector<HTMLImageElement>('[data-testid=project-cover] img');
}

function rowOf(id: string): HTMLElement {
  return screen.getAllByTestId('project-row').find((r) => r.getAttribute('data-id') === id)!;
}

beforeEach(async () => {
  await freshDb();
  await setLocale('en');
  clearViewFilters();
  clearPhotoUrls();
  resetSyncMocks();
  useRole('field_collector');
  let n = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test/${++n}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  storage = {
    downloadThumb: vi.fn(async () => image(40)),
    signFull: vi.fn(async () => 'http://127.0.0.1:54321/signed'),
    cachedThumb: vi.fn(async () => null),
  };
  setPhotoStorage(storage as unknown as PhotoStorage);
});
afterEach(() => {
  cleanup();
  clearPhotoUrls();
  setPhotoStorage(null);
  vi.restoreAllMocks();
});

describe('register rows show the cover thumbnail (brief §6)', () => {
  it('local blob first, the uploaded thumbnail otherwise, nothing without photos', async () => {
    await applyServerRows('projects', [
      serverProject({ id: WITH_LOCAL, name_ar: 'أ مسجد بصورة محلية' }),
      serverProject({ id: WITH_UPLOADED, name_ar: 'ب مسجد بصورة مرفوعة' }),
      serverProject({ id: WITHOUT, name_ar: 'ج مسجد بلا صورة' }),
    ]);
    const local = photo(WITH_LOCAL, { is_cover: true, upload_state: 'pending' });
    const other = photo(WITH_LOCAL, { is_cover: false, upload_state: 'pending' });
    const uploaded = photo(WITH_UPLOADED, { is_cover: true, upload_state: 'uploaded' });
    await applyServerRows('project_photos', [other, local, uploaded]);
    await putPhotoBlob(local.id, 'thumb', image(10));
    await putPhotoBlob(local.id, 'full', image(500));

    render(<ProjectList viewKey="cover" />);
    await waitFor(() => expect(screen.getAllByTestId('project-row')).toHaveLength(3));

    await waitFor(() => expect(coverImg(WITH_LOCAL)).toBeTruthy());
    const localImg = coverImg(WITH_LOCAL)!;
    expect(localImg.getAttribute('src')).toMatch(/^blob:/);
    expect(localImg.getAttribute('loading')).toBe('lazy');
    expect(localImg.getAttribute('alt')).toBe('');
    expect(within(rowOf(WITH_LOCAL)).getByTestId('project-cover').getAttribute('data-state')).toBe(
      'ready',
    );

    await waitFor(() => expect(coverImg(WITH_UPLOADED)).toBeTruthy());
    expect(storage.downloadThumb).toHaveBeenCalledTimes(1);
    expect(storage.downloadThumb).toHaveBeenCalledWith(uploaded.storage_path_thumb);
    expect(storage.signFull).not.toHaveBeenCalled();

    expect(within(rowOf(WITHOUT)).queryByTestId('project-cover')).toBeNull();
  });

  it('a row that only flies past while scrolling never resolves its thumbnail', async () => {
    await applyServerRows('projects', [serverProject({ id: WITH_UPLOADED })]);
    const uploaded = photo(WITH_UPLOADED, { is_cover: true, upload_state: 'uploaded' });
    await applyServerRows('project_photos', [uploaded]);
    const view = render(<CoverThumb photoId={uploaded.id} />);
    await sleep(COVER_DELAY_MS / 3);
    view.unmount();
    await sleep(COVER_DELAY_MS * 2);
    expect(storage.downloadThumb).not.toHaveBeenCalled();
  });

  it('a deleted cover shows an empty slot instead of a stale image', async () => {
    await applyServerRows('projects', [serverProject({ id: WITH_UPLOADED })]);
    const gone = photo(WITH_UPLOADED, {
      is_cover: true,
      upload_state: 'uploaded',
      deleted_at: '2026-10-01T00:00:00Z',
    });
    await applyServerRows('project_photos', [gone]);
    render(<CoverThumb photoId={gone.id} />);
    await sleep(COVER_DELAY_MS * 2);
    expect(screen.getByTestId('project-cover').getAttribute('data-state')).toBe('empty');
    expect(storage.downloadThumb).not.toHaveBeenCalled();
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newRow, putPhotoBlob, type Row } from '../db';
import { freshDb } from '../db/testing/factory';
import { t } from '../i18n';
import { fullImageNotice, Gallery, navigateIndex, photoCaption } from './Gallery';
import { setPhotoStorage, type PhotoStorage } from './storage';
import { clearPhotoUrls } from './urls';

const PROJECT = '01900000-0000-7000-8000-0000000000a1';

function photo(values: Partial<Row<'project_photos'>> = {}): Row<'project_photos'> {
  const row = newRow('project_photos', {
    project_id: PROJECT,
    upload_state: 'uploaded',
    ...values,
  });
  row.storage_path_full = `projects/TZ/${PROJECT}/${row.id}_full.webp`;
  row.storage_path_thumb = `projects/TZ/${PROJECT}/${row.id}_thumb.webp`;
  return row;
}

let storage: { [K in keyof PhotoStorage]: ReturnType<typeof vi.fn> };
let online: boolean;
let signed = 0;

beforeEach(async () => {
  await freshDb();
  clearPhotoUrls();
  online = true;
  signed = 0;
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
  let n = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:gallery/${++n}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  storage = {
    downloadThumb: vi.fn(async () => new Blob(['thumb'], { type: 'image/webp' })),
    signFull: vi.fn(
      async (path: string) =>
        `http://127.0.0.1:54321/storage/v1/object/sign/photos/${path}?token=${++signed}`,
    ),
    cachedThumb: vi.fn(async () => null),
  };
  setPhotoStorage(storage as unknown as PhotoStorage);
});

afterEach(() => {
  cleanup();
  clearPhotoUrls();
  // Never fall back to the real Supabase storage: a thumbnail still resolving when a test
  // ends must not reach the local gateway.
  setPhotoStorage({
    downloadThumb: async () => {
      throw new Error('test finished');
    },
    signFull: async () => {
      throw new Error('test finished');
    },
    cachedThumb: async () => null,
  });
});

describe('Gallery grid', () => {
  it('shows one thumbnail button per live photo, with type and description', async () => {
    const a = photo({ is_cover: true, category: 'mosque_front' });
    const b = photo({ category: 'other', caption: 'خزان الماء' });
    const gone = photo({ deleted_at: '2026-10-01T00:00:00Z' });
    render(<Gallery photos={[a, b, gone]} />);
    const items = screen.getAllByTestId('photo-gallery-item');
    expect(items).toHaveLength(2);
    expect(screen.getByTestId('photo-gallery').textContent).toContain(
      t('enum.photo_category.mosque_front'),
    );
    expect(screen.getByTestId('photo-gallery').textContent).toContain('خزان الماء');
    expect(items[0]?.getAttribute('aria-label')).toContain(
      t('photos.photoLabel', { n: 1, total: 2 }),
    );
    await waitFor(() => expect(storage.downloadThumb).toHaveBeenCalledTimes(2));
    expect(storage.signFull).not.toHaveBeenCalled(); // lists never load full images
  });

  it('empty state', () => {
    render(<Gallery photos={[]} />);
    expect(screen.getByTestId('photo-gallery-empty').textContent).toBe(t('photos.galleryEmpty'));
  });

  it('arrow keys move the focus between thumbnails (mirrored in RTL), Home/End jump', async () => {
    render(<Gallery photos={[photo(), photo(), photo()]} />);
    await waitFor(() => expect(storage.downloadThumb).toHaveBeenCalledTimes(3));
    const items = screen.getAllByTestId('photo-gallery-item');
    items[0]!.focus();
    fireEvent.keyDown(items[0]!, { key: 'ArrowLeft' }); // Arabic: left = next
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: 'End' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
  });
});

describe('Gallery viewer', () => {
  it('a tap opens the full image through a signed URL, with a loading state', async () => {
    const a = photo({ taken_at: '2026-09-30T14:05:09+03:00' });
    render(<Gallery photos={[a]} />);
    fireEvent.click(screen.getByTestId('photo-gallery-item'));
    const viewer = await screen.findByTestId('photo-viewer');
    const img = (await within(viewer).findByTestId('photo-viewer-image')) as HTMLImageElement;
    expect(img.getAttribute('src')).toContain(`/object/sign/photos/${a.storage_path_full}`);
    expect(storage.signFull).toHaveBeenCalledWith(a.storage_path_full, expect.any(Number));
    expect(within(viewer).getByRole('status', { name: t('photos.loading') })).toBeTruthy();
    fireEvent.load(img);
    await waitFor(() =>
      expect(within(viewer).queryByRole('status', { name: t('photos.loading') })).toBeNull(),
    );
    expect(viewer.textContent).toContain(t('photos.takenAt', { date: '' }).trim().split(' ')[0]!);
  });

  it('a photo not uploaded yet shows its local full-size blob', async () => {
    const a = photo({ upload_state: 'pending' });
    await putPhotoBlob(a.id, 'full', new Blob(['full'], { type: 'image/webp' }));
    render(<Gallery photos={[a]} />);
    fireEvent.click(screen.getByTestId('photo-gallery-item'));
    const img = await screen.findByTestId('photo-viewer-image');
    expect(img.getAttribute('src')).toMatch(/^blob:gallery\//);
    expect(storage.signFull).not.toHaveBeenCalled();
  });

  it('offline: a clear message, the thumbnail stays visible, no request', async () => {
    online = false;
    const a = photo();
    await putPhotoBlob(a.id, 'thumb', new Blob(['t'], { type: 'image/webp' }));
    render(<Gallery photos={[a]} />);
    fireEvent.click(screen.getByTestId('photo-gallery-item'));
    const notice = await screen.findByTestId('photo-viewer-notice');
    expect(notice.textContent).toContain(t('photos.fullOffline'));
    expect(screen.queryByTestId('photo-viewer-image')).toBeNull();
    const figure = screen.getByTestId('photo-viewer-figure');
    expect(within(figure).getByRole('img').getAttribute('src')).toMatch(/^blob:/);
    expect(storage.signFull).not.toHaveBeenCalled();
    expect(storage.downloadThumb).not.toHaveBeenCalled();
  });

  it('a failed load offers a retry that signs a new URL', async () => {
    render(<Gallery photos={[photo()]} />);
    fireEvent.click(screen.getByTestId('photo-gallery-item'));
    const img = await screen.findByTestId('photo-viewer-image');
    fireEvent.error(img);
    const notice = await screen.findByTestId('photo-viewer-notice');
    expect(notice.textContent).toContain(t('photos.fullError'));
    fireEvent.click(screen.getByTestId('photo-viewer-retry'));
    const again = await screen.findByTestId('photo-viewer-image');
    await waitFor(() => expect(again.getAttribute('src')).toContain('token=2'));
    expect(storage.signFull).toHaveBeenCalledTimes(2);
  });

  it('a photo not uploaded yet, with no image on this device: the notice does not claim a thumbnail', async () => {
    // Review finding: "…the thumbnail is shown" while the viewer showed no image at all.
    const a = photo({ upload_state: 'pending' });
    render(<Gallery photos={[a]} />);
    fireEvent.click(screen.getByTestId('photo-gallery-item'));
    const notice = await screen.findByTestId('photo-viewer-notice');
    expect(notice.textContent).toBe(t('photos.fullMissingNoThumb'));
    expect(notice.textContent).not.toContain(t('photos.fullMissing'));
    const figure = screen.getByTestId('photo-viewer-figure');
    expect(within(figure).queryByRole('img')).toBeNull();
    expect(figure.dataset.thumb).toBe('missing');
    expect(figure.textContent).toContain(t('photos.unavailable'));
    expect(storage.signFull).not.toHaveBeenCalled();
  });

  it('a photo not uploaded yet whose thumbnail is on this device: "thumbnail shown"', async () => {
    const a = photo({ upload_state: 'pending' });
    await putPhotoBlob(a.id, 'thumb', new Blob(['t'], { type: 'image/webp' }));
    render(<Gallery photos={[a]} />);
    fireEvent.click(screen.getByTestId('photo-gallery-item'));
    const notice = await screen.findByTestId('photo-viewer-notice');
    await waitFor(() => expect(notice.textContent).toBe(t('photos.fullMissing')));
    const figure = screen.getByTestId('photo-viewer-figure');
    expect(figure.dataset.thumb).toBe('shown');
    expect(within(figure).getByRole('img').getAttribute('src')).toMatch(/^blob:/);
  });

  it('offline without a cached thumbnail: no "thumbnail shown" either', async () => {
    online = false;
    render(<Gallery photos={[photo()]} />);
    fireEvent.click(screen.getByTestId('photo-gallery-item'));
    const notice = await screen.findByTestId('photo-viewer-notice');
    await waitFor(() => expect(notice.textContent).toBe(t('photos.fullOfflineNoThumb')));
    expect(screen.getByTestId('photo-viewer-figure').textContent).toContain(t('photos.offline'));
  });

  it('an uploaded photo whose full image cannot be signed: "not available", thumbnail kept', async () => {
    storage.signFull.mockImplementation(async () => {
      throw new Error('object not found');
    });
    render(<Gallery photos={[photo()]} />);
    fireEvent.click(screen.getByTestId('photo-gallery-item'));
    const notice = await screen.findByTestId('photo-viewer-notice');
    await waitFor(() => expect(notice.textContent).toBe(t('photos.fullUnavailable')));
    expect(fullImageNotice({ upload_state: 'uploaded' }, 'missing', false, false)).toBe(
      t('photos.fullUnavailableNoThumb'),
    );
    expect(fullImageNotice({ upload_state: 'uploaded' }, 'ready', true, true)).toBe(
      t('photos.fullError'),
    );
    expect(fullImageNotice({ upload_state: 'uploaded' }, 'ready', false, true)).toBeNull();
  });

  it('keyboard and buttons move between photos; Esc closes the viewer', async () => {
    const photos = [photo(), photo(), photo()];
    render(<Gallery photos={photos} />);
    fireEvent.click(screen.getAllByTestId('photo-gallery-item')[0]!);
    const title = () => screen.getByTestId('photo-viewer').querySelector('h2')?.textContent;
    await waitFor(() => expect(title()).toBe(t('photos.photoLabel', { n: 1, total: 3 })));
    expect((screen.getByTestId('photo-viewer-prev') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(document.body, { key: 'ArrowLeft' }); // RTL: next
    await waitFor(() => expect(title()).toBe(t('photos.photoLabel', { n: 2, total: 3 })));
    fireEvent.click(screen.getByTestId('photo-viewer-next'));
    await waitFor(() => expect(title()).toBe(t('photos.photoLabel', { n: 3, total: 3 })));
    expect((screen.getByTestId('photo-viewer-next') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document.body, { key: 'Home' });
    await waitFor(() => expect(title()).toBe(t('photos.photoLabel', { n: 1, total: 3 })));

    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('photo-viewer')).toBeNull());
    // each photo shown got its own, fresh signed URL
    await waitFor(() => expect(storage.signFull.mock.calls.length).toBeGreaterThanOrEqual(3));
  });
});

describe('helpers', () => {
  it('navigateIndex mirrors the arrows for right-to-left layouts', () => {
    expect(navigateIndex('ArrowLeft', 0, 3, true)).toBe(1);
    expect(navigateIndex('ArrowLeft', 0, 3, false)).toBe(0);
    expect(navigateIndex('ArrowRight', 0, 3, false)).toBe(1);
    expect(navigateIndex('End', 0, 3, true)).toBe(2);
    expect(navigateIndex('Home', 2, 3, true)).toBe(0);
    expect(navigateIndex('Enter', 0, 3, true)).toBeNull();
    expect(navigateIndex('ArrowLeft', 0, 0, true)).toBeNull();
  });

  it('photoCaption joins type and description, hides "unspecified"', () => {
    expect(photoCaption(photo())).toBe('');
    expect(photoCaption(photo({ category: 'land', caption: 'ساحة' }))).toBe(
      `${t('enum.photo_category.land')} — ساحة`,
    );
  });
});

describe('viewer colours (AA)', () => {
  // happy-dom does not apply stylesheets: check the rules themselves against the tokens.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const css = fs.readFileSync(path.join(here, 'photos.css'), 'utf8');
  const tokens = fs.readFileSync(path.join(here, '../ui/tokens.css'), 'utf8');

  const rule = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    if (!match) throw new Error(`no rule ${selector}`);
    return match[2] ?? '';
  };
  const token = (name: string): string => {
    const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(tokens);
    if (!match?.[1]) throw new Error(`no token ${name}`);
    return match[1];
  };
  const luminance = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  it('the placeholder text on the dark stage reaches 4.5:1 and is not dimmed', () => {
    const stageBg = /background:\s*var\((--[\w-]+)\)/.exec(rule('.photo-viewer__stage'))?.[1];
    const textColour = /(?:^|\s|;)color:\s*var\((--[\w-]+)\)/.exec(
      rule('.photo-viewer__placeholder .photo-thumb'),
    )?.[1];
    expect(stageBg).toBe('--c-navy-900');
    expect(textColour).toBeDefined();
    expect(contrast(token(textColour!), token(stageBg!))).toBeGreaterThanOrEqual(4.5);
    // Opacity on the wrapper would fade the text too; only the image is dimmed.
    expect(rule('.photo-viewer__placeholder')).not.toMatch(/opacity/);
  });
});

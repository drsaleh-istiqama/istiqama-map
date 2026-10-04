import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  download: vi.fn(),
  createSignedUrl: vi.fn(),
}));

vi.mock('../auth', () => ({
  supabase: {
    storage: {
      from: (bucket: string) => {
        mocks.from(bucket);
        return { download: mocks.download, createSignedUrl: mocks.createSignedUrl };
      },
    },
  },
}));
vi.mock('../env', () => ({ env: { supabaseUrl: 'http://127.0.0.1:54321' } }));

const { supabasePhotoStorage, PHOTO_BUCKET } = await import('./storage');

const PATH =
  'projects/TZ/01900000-0000-7000-8000-000000000001/01900000-0000-7000-8000-0000000000aa_thumb.webp';

describe('supabasePhotoStorage', () => {
  beforeEach(() => {
    mocks.from.mockClear();
    mocks.download.mockReset();
    mocks.createSignedUrl.mockReset();
  });
  afterEach(() => {
    delete (globalThis as { caches?: unknown }).caches;
  });

  it('downloads thumbnails from the private "photos" bucket with the session', async () => {
    const blob = new Blob(['x'], { type: 'image/webp' });
    mocks.download.mockResolvedValue({ data: blob, error: null });
    await expect(supabasePhotoStorage.downloadThumb(PATH)).resolves.toBe(blob);
    expect(mocks.from).toHaveBeenCalledWith(PHOTO_BUCKET);
    expect(PHOTO_BUCKET).toBe('photos');
    expect(mocks.download).toHaveBeenCalledWith(PATH, {}, undefined);
  });

  it('turns storage errors into rejections', async () => {
    mocks.download.mockResolvedValue({ data: null, error: { message: 'Object not found' } });
    await expect(supabasePhotoStorage.downloadThumb(PATH)).rejects.toThrow('Object not found');
    mocks.createSignedUrl.mockResolvedValue({ data: null, error: { message: 'Unauthorized' } });
    await expect(supabasePhotoStorage.signFull(PATH, 300)).rejects.toThrow('Unauthorized');
  });

  it('signs full-size paths for the requested lifetime', async () => {
    mocks.createSignedUrl.mockResolvedValue({
      data: { signedUrl: 'http://127.0.0.1:54321/storage/v1/object/sign/photos/x?token=abc' },
      error: null,
    });
    await expect(
      supabasePhotoStorage.signFull('projects/TZ/p/x_full.webp', 300),
    ).resolves.toContain('token=abc');
    expect(mocks.createSignedUrl).toHaveBeenCalledWith('projects/TZ/p/x_full.webp', 300);
  });

  it('reads cached thumbnails from Cache Storage without a request', async () => {
    const match = vi.fn(async (url: string) =>
      url.endsWith('_thumb.webp')
        ? new Response(new Blob(['img'], { type: 'image/webp' }))
        : undefined,
    );
    (globalThis as { caches?: unknown }).caches = { match };
    const blob = await supabasePhotoStorage.cachedThumb(PATH);
    expect(blob?.size).toBe(3);
    expect(match).toHaveBeenCalledWith(`http://127.0.0.1:54321/storage/v1/object/photos/${PATH}`, {
      ignoreSearch: true,
      ignoreVary: true,
    });
    await expect(supabasePhotoStorage.cachedThumb('projects/TZ/p/none.webp')).resolves.toBeNull();
  });

  it('no Cache Storage (old engines, tests) → null', async () => {
    await expect(supabasePhotoStorage.cachedThumb(PATH)).resolves.toBeNull();
  });
});

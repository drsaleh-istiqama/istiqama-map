import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertImageFile,
  canEncodeWebp,
  compressPhoto,
  fitWithin,
  FULL_QUALITY,
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  resetEncoderDetection,
  sniffImage,
  THUMB_QUALITY,
} from './compress';
import { PhotoError } from './errors';
import { containsExifMarker } from './exif';
import { bytesOf, installFakeImaging, type FakeImaging } from './testing/fakeCanvas';
import { blobOf, buildJpeg, buildPng, buildTiff, TAG } from './testing/samples';

const EXIF_TIFF = buildTiff(true, {
  [TAG.DateTimeOriginal]: '2026:09:30 14:05:09',
  [TAG.OffsetTimeOriginal]: '+03:00',
});

let fake: FakeImaging;

function jpeg(width: number, height: number, withExif = true): Blob {
  return fake.register(blobOf(buildJpeg(withExif ? EXIF_TIFF : null), 'image/jpeg'), width, height);
}

const errorCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return e instanceof PhotoError ? e.code : `other: ${String(e)}`;
  }
};

beforeEach(() => {
  resetEncoderDetection();
  fake = installFakeImaging();
});

afterEach(() => {
  fake.restore();
});

describe('fitWithin', () => {
  it('scales the longest side down and never enlarges', () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual([1600, 1200]);
    expect(fitWithin(3000, 4000, 1600)).toEqual([1200, 1600]);
    expect(fitWithin(1600, 1200, 400)).toEqual([400, 300]);
    expect(fitWithin(800, 600, 1600)).toEqual([800, 600]);
    expect(fitWithin(10000, 10, 1600)).toEqual([1600, 2]);
    expect(fitWithin(5000, 1, 400)).toEqual([400, 1]);
  });
});

describe('compressPhoto — sizes and format', () => {
  it('landscape 4000×3000 → full 1600×1200 (q0.8) + thumb 400×300, WebP', async () => {
    const out = await compressPhoto(jpeg(4000, 3000));
    expect(out).toMatchObject({ width: 1600, height: 1200, mime: 'image/webp' });
    expect(out.full.type).toBe('image/webp');
    expect(out.thumb.type).toBe('image/webp');
    const [detect, full, thumb] = fake.encodes;
    expect(detect).toMatchObject({ width: 1, height: 1, type: 'image/webp' });
    expect(full).toMatchObject({
      width: 1600,
      height: 1200,
      type: 'image/webp',
      quality: FULL_QUALITY,
    });
    expect(thumb).toMatchObject({
      width: 400,
      height: 300,
      type: 'image/webp',
      quality: THUMB_QUALITY,
    });
    expect(out.thumb.size).toBeLessThan(out.full.size);
  });

  it('portrait 3000×4000 → 1200×1600 + 300×400', async () => {
    const out = await compressPhoto(jpeg(3000, 4000));
    expect([out.width, out.height]).toEqual([1200, 1600]);
    expect(fake.encodes.at(-1)).toMatchObject({ width: 300, height: 400 });
  });

  it('small photos are not enlarged', async () => {
    const out = await compressPhoto(jpeg(800, 600));
    expect([out.width, out.height]).toEqual([800, 600]);
    expect(fake.encodes.at(-1)).toMatchObject({ width: 400, height: 300 });
  });

  it('decodes with EXIF orientation applied by the browser', async () => {
    await compressPhoto(jpeg(4000, 3000));
    expect(fake.decodes[0]?.options).toEqual({ imageOrientation: 'from-image' });
  });

  it('JPEG fallback when the canvas cannot encode WebP; detection runs once', async () => {
    fake.supported.delete('image/webp');
    const a = await compressPhoto(jpeg(4000, 3000));
    const b = await compressPhoto(jpeg(2000, 1000));
    expect(a.mime).toBe('image/jpeg');
    expect(a.full.type).toBe('image/jpeg');
    expect(a.thumb.type).toBe('image/jpeg');
    expect(b.mime).toBe('image/jpeg');
    const probes = fake.encodes.filter((e) => e.width === 1 && e.height === 1);
    expect(probes).toHaveLength(1);
    expect(fake.encodes.filter((e) => e.width > 1).every((e) => e.type === 'image/jpeg')).toBe(
      true,
    );
    await expect(canEncodeWebp()).resolves.toBe(false);
  });

  it('switches both versions to JPEG when WebP was detected but the real encoding is refused', async () => {
    await canEncodeWebp(); // detection succeeds
    fake.supported.delete('image/webp');
    const out = await compressPhoto(jpeg(4000, 3000));
    expect(out.mime).toBe('image/jpeg');
    expect(out.full.type).toBe('image/jpeg');
    expect(out.thumb.type).toBe('image/jpeg');
  });

  it('falls back to <canvas> when OffscreenCanvas is missing', async () => {
    fake.restore();
    fake = installFakeImaging({ offscreen: false });
    const out = await compressPhoto(jpeg(4000, 3000));
    expect([out.width, out.height]).toEqual([1600, 1200]);
    expect(fake.encodes.length).toBeGreaterThanOrEqual(3);
    expect(fake.encodes.every((e) => e.via === 'canvas')).toBe(true);
  });

  it('lowers the quality only when the full version would exceed the bucket limit', async () => {
    fake.sizeFor = (w, _h, q) =>
      w <= 1 ? 10 : q === FULL_QUALITY ? MAX_OUTPUT_BYTES + 1 : w === 1600 ? 3_000_000 : 20_000;
    const out = await compressPhoto(jpeg(4000, 3000));
    expect(out.full.size).toBe(3_000_000);
    const fullEncodes = fake.encodes.filter((e) => e.width === 1600);
    expect(fullEncodes.map((e) => e.quality)).toEqual([FULL_QUALITY, 0.65]);
  });

  it('gives up (encode_failed) when even the lowest quality is too large', async () => {
    fake.sizeFor = (w) => (w <= 1 ? 10 : MAX_OUTPUT_BYTES + 1);
    expect(await errorCode(compressPhoto(jpeg(4000, 3000)))).toBe('encode_failed');
    expect(fake.alive).toBe(0);
  });
});

describe('compressPhoto — EXIF', () => {
  it('fills takenAt from the original and the output carries no EXIF at all', async () => {
    const input = jpeg(4000, 3000);
    expect(containsExifMarker(await bytesOf(input))).toBe(true);
    const out = await compressPhoto(input);
    expect(out.takenAt).toBe('2026-09-30T14:05:09+03:00');
    expect(containsExifMarker(await bytesOf(out.full))).toBe(false);
    expect(containsExifMarker(await bytesOf(out.thumb))).toBe(false);
  });

  it('takenAt is null when the original has no EXIF', async () => {
    const out = await compressPhoto(jpeg(1000, 800, false));
    expect(out.takenAt).toBeNull();
  });
});

describe('compressPhoto — input checks', () => {
  it('rejects non-images, SVG and empty files before decoding', async () => {
    expect(await errorCode(compressPhoto(new Blob(['hello'], { type: 'text/plain' })))).toBe(
      'not_image',
    );
    expect(await errorCode(compressPhoto(new Blob(['<svg/>'], { type: 'image/svg+xml' })))).toBe(
      'not_image',
    );
    expect(await errorCode(compressPhoto(new Blob([], { type: 'image/jpeg' })))).toBe('not_image');
    expect(fake.decodes).toHaveLength(0);
  });

  it('rejects files larger than 25 MB without reading them', async () => {
    const huge = {
      size: MAX_INPUT_BYTES + 1,
      type: 'image/jpeg',
      slice: vi.fn(),
      arrayBuffer: vi.fn(),
    } as unknown as Blob;
    expect(await errorCode(compressPhoto(huge))).toBe('too_large');
    expect((huge.slice as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    const exactly = { size: MAX_INPUT_BYTES, type: 'image/jpeg' } as Blob;
    await expect(assertImageFile(exactly)).resolves.toBeUndefined();
  });

  it('accepts files without a MIME type only when the bytes are an image', async () => {
    await expect(assertImageFile(blobOf(buildPng(null)))).resolves.toBeUndefined();
    await expect(assertImageFile(blobOf(buildJpeg(null)))).resolves.toBeUndefined();
    expect(await errorCode(assertImageFile(new Blob(['just some text'])))).toBe('not_image');
    expect(sniffImage(Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99]))).toBe(
      true,
    );
  });

  it('decode_failed when neither createImageBitmap nor <img> can decode', async () => {
    const unknown = blobOf(buildJpeg(null), 'image/jpeg'); // not registered → bitmap decode fails
    expect(await errorCode(compressPhoto(unknown))).toBe('decode_failed');
  });

  it('falls back to <img> decoding when createImageBitmap is missing', async () => {
    fake.restore();
    fake = installFakeImaging({ bitmap: false });
    const proto = HTMLImageElement.prototype as unknown as Record<string, unknown>;
    const w = vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(3000);
    const h = vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(2000);
    const savedDecode = proto.decode;
    proto.decode = vi.fn(async () => undefined);
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-1');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    try {
      const out = await compressPhoto(blobOf(buildJpeg(null), 'image/jpeg'));
      expect([out.width, out.height]).toEqual([1600, 1067]);
      expect(create).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith('blob:fake-1');
    } finally {
      proto.decode = savedDecode;
      w.mockRestore();
      h.mockRestore();
    }
  });
});

describe('compressPhoto — memory', () => {
  it('runs one photo at a time and closes every bitmap', async () => {
    fake.decodeDelayMs = 5;
    const results = await Promise.all([
      compressPhoto(jpeg(4000, 3000)),
      compressPhoto(jpeg(3000, 4000)),
      compressPhoto(jpeg(2000, 2000)),
    ]);
    expect(results.map((r) => [r.width, r.height])).toEqual([
      [1600, 1200],
      [1200, 1600],
      [1600, 1600],
    ]);
    expect(fake.maxAlive).toBe(1);
    expect(fake.alive).toBe(0);
    expect(fake.closed).toBe(3);
    // every OffscreenCanvas (probe + full + thumb of each photo) was shrunk after use
    expect(fake.released).toBe(1 + 3 * 2);
  });

  it('closes the bitmap and releases canvases when drawing fails (out of memory)', async () => {
    fake.drawError = new Error('out of memory');
    expect(await errorCode(compressPhoto(jpeg(4000, 3000)))).toBe('encode_failed');
    expect(fake.alive).toBe(0);
    // the queue keeps working after a failure
    fake.drawError = null;
    await expect(compressPhoto(jpeg(800, 600))).resolves.toMatchObject({ width: 800 });
  });
});

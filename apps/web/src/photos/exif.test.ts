import { describe, expect, it } from 'vitest';
import {
  containsExifMarker,
  exifToIso,
  findExifBlock,
  parseExifTakenAt,
  parseTiffDateTime,
  readTakenAt,
} from './exif';
import {
  blobOf,
  buildHeifLike,
  buildJpeg,
  buildPng,
  buildTiff,
  buildWebp,
  TAG,
} from './testing/samples';

const WITH_OFFSET = {
  [TAG.DateTimeOriginal]: '2026:09:30 14:05:09',
  [TAG.OffsetTimeOriginal]: '+03:00',
};

/** What `exifToIso` must produce for a date without offset: the device's local offset. */
function localIso(y: number, mo: number, d: number, h: number, mi: number, s: number): string {
  const local = new Date(y, mo - 1, d, h, mi, s);
  const minutes = -local.getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

describe('TIFF / EXIF block', () => {
  it.each([true, false])(
    'reads DateTimeOriginal + OffsetTimeOriginal (little endian: %s)',
    (le) => {
      expect(parseTiffDateTime(buildTiff(le, WITH_OFFSET))).toEqual({
        dateTime: '2026:09:30 14:05:09',
        offset: '+03:00',
      });
    },
  );

  it('falls back to OffsetTime, then to DateTimeDigitized', () => {
    expect(
      parseTiffDateTime(
        buildTiff(true, {
          [TAG.DateTimeOriginal]: '2025:01:02 03:04:05',
          [TAG.OffsetTime]: '-05:30',
        }),
      ),
    ).toEqual({ dateTime: '2025:01:02 03:04:05', offset: '-05:30' });
    expect(
      parseTiffDateTime(
        buildTiff(false, {
          [TAG.DateTimeDigitized]: '2024:12:31 23:59:58',
          [TAG.OffsetTimeDigitized]: '+04:00',
        }),
      ),
    ).toEqual({ dateTime: '2024:12:31 23:59:58', offset: '+04:00' });
  });

  it('ignores blank, zero and impossible dates', () => {
    expect(
      parseTiffDateTime(buildTiff(true, { [TAG.DateTimeOriginal]: '0000:00:00 00:00:00' })),
    ).toBeNull();
    expect(parseTiffDateTime(buildTiff(true, { [TAG.DateTimeOriginal]: '    ' }))).toBeNull();
    expect(
      parseTiffDateTime(buildTiff(true, { [TAG.DateTimeOriginal]: '2026:04:31 10:00:00' })),
    ).toBeNull();
    expect(parseTiffDateTime(buildTiff(true, {}))).toBeNull();
  });

  it('rejects malformed blocks without throwing', () => {
    expect(parseTiffDateTime(new Uint8Array([0x49, 0x49, 0x2a, 0]))).toBeNull();
    const broken = buildTiff(true, WITH_OFFSET);
    new DataView(broken.buffer).setUint32(4, 99999, true); // IFD0 beyond the block
    expect(parseTiffDateTime(broken)).toBeNull();
    expect(parseTiffDateTime(new Uint8Array(0))).toBeNull();
  });
});

describe('exifToIso', () => {
  it('keeps the recorded offset', () => {
    expect(exifToIso({ dateTime: '2026:09:30 14:05:09', offset: '+03:00' })).toBe(
      '2026-09-30T14:05:09+03:00',
    );
    expect(exifToIso({ dateTime: '2026:09:30 14:05:09', offset: '-0530' })).toBe(
      '2026-09-30T14:05:09-05:30',
    );
  });

  it("uses the device's local offset when the camera recorded none", () => {
    expect(exifToIso({ dateTime: '2026:01:15 08:30:00', offset: null })).toBe(
      localIso(2026, 1, 15, 8, 30, 0),
    );
  });

  it('accepts dashes and slashes some cameras write, refuses garbage', () => {
    expect(exifToIso({ dateTime: '2026-09-30 14:05:09', offset: '+03:00' })).toBe(
      '2026-09-30T14:05:09+03:00',
    );
    expect(exifToIso({ dateTime: 'yesterday', offset: null })).toBeNull();
    expect(exifToIso({ dateTime: '2026:09:30 14:05:09', offset: '+25:00' })).toBeNull();
  });
});

describe('containers', () => {
  const tiffLe = buildTiff(true, WITH_OFFSET);
  const tiffBe = buildTiff(false, WITH_OFFSET);
  const expected = '2026-09-30T14:05:09+03:00';

  it('JPEG: APP1 Exif after APP0/APP2 segments, both byte orders', () => {
    expect(parseExifTakenAt(buildJpeg(tiffLe))).toBe(expected);
    expect(parseExifTakenAt(buildJpeg(tiffBe, { iccFiller: 3000 }))).toBe(expected);
  });

  it('JPEG without EXIF (screenshots, edited images) → null', () => {
    expect(parseExifTakenAt(buildJpeg(null))).toBeNull();
  });

  it('WebP: EXIF chunk after the image data, with or without the "Exif\\0\\0" prefix', () => {
    expect(parseExifTakenAt(buildWebp(tiffLe))).toBe(expected);
    expect(parseExifTakenAt(buildWebp(tiffBe, { exifPrefix: true }))).toBe(expected);
    expect(parseExifTakenAt(buildWebp(null))).toBeNull();
  });

  it('PNG eXIf chunk', () => {
    expect(parseExifTakenAt(buildPng(tiffLe))).toBe(expected);
    expect(parseExifTakenAt(buildPng(null))).toBeNull();
  });

  it('HEIC/HEIF (and iOS JPEG converted from HEIC): "Exif\\0\\0" + TIFF found by scanning', () => {
    expect(parseExifTakenAt(buildHeifLike(tiffBe))).toBe(expected);
  });

  it('random bytes → no block', () => {
    const noise = new Uint8Array(4096).map((_, i) => (i * 31 + 7) & 0xff);
    expect(findExifBlock(noise)).toBeNull();
    expect(parseExifTakenAt(noise)).toBeNull();
  });
});

describe('readTakenAt (Blob)', () => {
  const tiff = buildTiff(true, WITH_OFFSET);

  it('reads JPEG and PNG files', async () => {
    await expect(readTakenAt(blobOf(buildJpeg(tiff), 'image/jpeg'))).resolves.toBe(
      '2026-09-30T14:05:09+03:00',
    );
    await expect(readTakenAt(blobOf(buildPng(tiff), 'image/png'))).resolves.toBe(
      '2026-09-30T14:05:09+03:00',
    );
  });

  it('walks the chunks of a large WebP whose EXIF lies beyond the first 256 kB', async () => {
    const big = buildWebp(tiff, { imageBytes: 600 * 1024 + 1 });
    expect(big.length).toBeGreaterThan(600 * 1024);
    await expect(readTakenAt(blobOf(big, 'image/webp'))).resolves.toBe('2026-09-30T14:05:09+03:00');
  });

  it('returns null for files without EXIF and never throws', async () => {
    await expect(readTakenAt(blobOf(buildJpeg(null), 'image/jpeg'))).resolves.toBeNull();
    await expect(readTakenAt(new Blob([]))).resolves.toBeNull();
    const truncated = buildJpeg(tiff).subarray(0, 30);
    await expect(readTakenAt(blobOf(truncated, 'image/jpeg'))).resolves.toBeNull();
  });
});

describe('containsExifMarker', () => {
  it('finds the markers of every container and nothing in clean bytes', () => {
    const tiff = buildTiff(true, WITH_OFFSET);
    expect(containsExifMarker(buildJpeg(tiff))).toBe(true);
    expect(containsExifMarker(buildWebp(tiff))).toBe(true);
    expect(containsExifMarker(buildPng(tiff))).toBe(true);
    expect(containsExifMarker(buildJpeg(null))).toBe(false);
  });
});

/**
 * Test helpers: real container bytes built by hand (TIFF/EXIF, JPEG, WebP, PNG, HEIF-like),
 * so the EXIF reader is exercised on the byte layouts cameras write. Not used by the app.
 */

export const TAG = {
  DateTimeOriginal: 0x9003,
  DateTimeDigitized: 0x9004,
  OffsetTime: 0x9010,
  OffsetTimeOriginal: 0x9011,
  OffsetTimeDigitized: 0x9012,
} as const;

const enc = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

/**
 * A TIFF block: IFD0 with one Exif-IFD pointer, the Exif IFD with ASCII tags (values longer
 * than 4 bytes in a data area after the IFD, as cameras write them).
 */
export function buildTiff(littleEndian: boolean, tags: Record<number, string>): Uint8Array {
  const entries = Object.entries(tags)
    .map(([k, v]) => [Number(k), `${v}\0`] as const)
    .sort((a, b) => a[0] - b[0]);
  const ifd0 = 8;
  const exif = ifd0 + 2 + 12 + 4;
  let data = exif + 2 + entries.length * 12 + 4;
  const total = data + entries.reduce((n, [, text]) => n + (text.length > 4 ? text.length : 0), 0);
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const le = littleEndian;
  bytes[0] = bytes[1] = le ? 0x49 : 0x4d;
  view.setUint16(2, 42, le);
  view.setUint32(4, ifd0, le);
  view.setUint16(ifd0, 1, le);
  view.setUint16(ifd0 + 2, 0x8769, le);
  view.setUint16(ifd0 + 4, 4, le); // LONG
  view.setUint32(ifd0 + 6, 1, le);
  view.setUint32(ifd0 + 10, exif, le);
  view.setUint32(ifd0 + 14, 0, le);
  view.setUint16(exif, entries.length, le);
  entries.forEach(([tag, text], i) => {
    const e = exif + 2 + i * 12;
    view.setUint16(e, tag, le);
    view.setUint16(e + 2, 2, le); // ASCII
    view.setUint32(e + 4, text.length, le);
    if (text.length <= 4) {
      bytes.set(enc(text), e + 8);
    } else {
      view.setUint32(e + 8, data, le);
      bytes.set(enc(text), data);
      data += text.length;
    }
  });
  view.setUint32(exif + 2 + entries.length * 12, 0, le);
  return bytes;
}

const u16be = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const u32le = (n: number): number[] => [
  n & 0xff,
  (n >> 8) & 0xff,
  (n >> 16) & 0xff,
  (n >>> 24) & 0xff,
];
const u32be = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >> 16) & 0xff,
  (n >> 8) & 0xff,
  n & 0xff,
];

/** A JPEG: SOI, APP0 JFIF, (APP2 ICC filler), APP1 Exif, DQT, SOS + data, EOI. */
export function buildJpeg(
  tiff: Uint8Array | null,
  options: { iccFiller?: number } = {},
): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  const jfif = [...enc('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  out.push(0xff, 0xe0, ...u16be(jfif.length + 2), ...jfif);
  if (options.iccFiller) {
    const icc = [...enc('ICC_PROFILE\0'), ...new Array<number>(options.iccFiller).fill(7)];
    out.push(0xff, 0xe2, ...u16be(icc.length + 2), ...icc);
  }
  if (tiff) {
    const payload = [...enc('Exif\0\0'), ...tiff];
    out.push(0xff, 0xe1, ...u16be(payload.length + 2), ...payload);
  }
  out.push(0xff, 0xdb, ...u16be(5), 0, 1, 2);
  out.push(0xff, 0xda, ...u16be(4), 1, 2, 0x11, 0x22, 0x33, 0x44);
  out.push(0xff, 0xd9);
  return Uint8Array.from(out);
}

/** An extended WebP: VP8X, VP8 image data (`imageBytes` long), then EXIF (after the image). */
export function buildWebp(
  tiff: Uint8Array | null,
  options: { imageBytes?: number; exifPrefix?: boolean } = {},
): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.from(enc('WEBP'))];
  const chunk = (id: string, payload: Uint8Array): void => {
    parts.push(Uint8Array.from([...enc(id), ...u32le(payload.length)]), payload);
    if (payload.length & 1) parts.push(new Uint8Array(1));
  };
  chunk('VP8X', Uint8Array.from([0x08, 0, 0, 0, 9, 0, 0, 9, 0, 0]));
  chunk('VP8 ', new Uint8Array(options.imageBytes ?? 11).fill(0x5a));
  if (tiff)
    chunk('EXIF', options.exifPrefix ? Uint8Array.from([...enc('Exif\0\0'), ...tiff]) : tiff);
  const bodyLength = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(8 + bodyLength);
  out.set([...enc('RIFF'), ...u32le(bodyLength)], 0);
  let at = 8;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A PNG with an eXIf chunk before the image data. */
export function buildPng(tiff: Uint8Array | null): Uint8Array {
  const out: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (id: string, payload: ArrayLike<number>): void => {
    out.push(...u32be(payload.length), ...enc(id), ...Array.from(payload), 0, 0, 0, 0);
  };
  chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  if (tiff) chunk('eXIf', tiff);
  chunk('IDAT', [1, 2, 3]);
  chunk('IEND', []);
  return Uint8Array.from(out);
}

/** A HEIF-like file: `ftyp heic` box, filler, then the Exif item ("Exif\0\0" + TIFF). */
export function buildHeifLike(tiff: Uint8Array): Uint8Array {
  const ftyp = [0, 0, 0, 24, ...enc('ftypheic'), 0, 0, 0, 0, ...enc('mif1heic')];
  const filler = new Array<number>(300).fill(0x11);
  return Uint8Array.from([...ftyp, ...filler, 0, 0, 0, 6, ...enc('Exif\0\0'), ...tiff, 0, 0]);
}

/** A Blob from bytes (copied into a fresh ArrayBuffer). */
export function blobOf(bytes: Uint8Array, type = ''): Blob {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Blob([copy.buffer], { type });
}

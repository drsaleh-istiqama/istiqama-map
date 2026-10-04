/**
 * Capture time from the EXIF block of the ORIGINAL file (brief §6: EXIF is removed except the
 * capture time). The re-encoded photo carries no EXIF at all — the canvas never copies
 * metadata — so `taken_at` is the only thing that survives, as a column of the row.
 *
 * Supported containers: JPEG (APP1 "Exif"), WebP (RIFF chunk "EXIF"), PNG (chunk "eXIf"), and
 * any other file whose first bytes contain an "Exif\0\0" + TIFF header (HEIC/HEIF, JPEG
 * converted from HEIC by iOS). Only the bytes that are needed are read from the Blob.
 *
 * Tags: DateTimeOriginal (0x9003) with OffsetTimeOriginal (0x9011), else DateTimeDigitized
 * (0x9004) with OffsetTimeDigitized (0x9012); OffsetTime (0x9010) is the fallback offset.
 * Without any offset the camera's clock is taken as the device's local time.
 */

const TAG_EXIF_IFD = 0x8769;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;
const TAG_OFFSET_TIME = 0x9010;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;
const TAG_OFFSET_TIME_DIGITIZED = 0x9012;
const TYPE_ASCII = 2;
const TYPE_LONG = 4;

/** How much of the file head is read for JPEG / PNG / generic scanning. */
export const EXIF_HEAD_BYTES = 256 * 1024;

export interface ExifDateTime {
  /** `YYYY:MM:DD HH:MM:SS` as written by the camera. */
  dateTime: string;
  /** `+HH:MM` / `-HH:MM` when the camera recorded it. */
  offset: string | null;
}

const ascii = (bytes: Uint8Array, start: number, length: number): string => {
  let out = '';
  for (let i = start; i < start + length && i < bytes.length; i++) {
    const c = bytes[i] as number;
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out;
};

const startsWith = (bytes: Uint8Array, at: number, text: string): boolean => {
  if (at < 0 || at + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
};

/** A TIFF header ("II*\0" or "MM\0*") at `at`. */
function isTiffHeader(bytes: Uint8Array, at: number): boolean {
  return (
    (startsWith(bytes, at, 'II') && bytes[at + 2] === 0x2a && bytes[at + 3] === 0x00) ||
    (startsWith(bytes, at, 'MM') && bytes[at + 2] === 0x00 && bytes[at + 3] === 0x2a)
  );
}

/**
 * Reads the capture date tags of a TIFF block (the payload of an EXIF segment).
 * Returns null when the block is malformed or carries no capture date.
 */
export function parseTiffDateTime(tiff: Uint8Array): ExifDateTime | null {
  if (tiff.length < 8 || !isTiffHeader(tiff, 0)) return null;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const le = tiff[0] === 0x49;
  const u16 = (o: number): number => view.getUint16(o, le);
  const u32 = (o: number): number => view.getUint32(o, le);

  /** Tag → entry offset of one IFD (no recursion, bounded by the block size). */
  const readIfd = (offset: number): Map<number, number> | null => {
    if (offset < 8 || offset + 2 > tiff.length) return null;
    const count = u16(offset);
    if (count === 0 || offset + 2 + count * 12 > tiff.length) return null;
    const entries = new Map<number, number>();
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      entries.set(u16(entry), entry);
    }
    return entries;
  };

  const readAscii = (entries: Map<number, number>, tag: number): string | null => {
    const entry = entries.get(tag);
    if (entry === undefined || u16(entry + 2) !== TYPE_ASCII) return null;
    const count = u32(entry + 4);
    if (count === 0 || count > 64) return null;
    const at = count <= 4 ? entry + 8 : u32(entry + 8);
    if (at + count > tiff.length) return null;
    const text = ascii(tiff, at, count).trim();
    return text === '' ? null : text;
  };

  const ifd0 = readIfd(u32(4));
  if (!ifd0) return null;
  const pointer = ifd0.get(TAG_EXIF_IFD);
  if (pointer === undefined) return null;
  const pointerType = u16(pointer + 2);
  if (pointerType !== TYPE_LONG && pointerType !== 13 /* IFD */) return null;
  const exif = readIfd(u32(pointer + 8));
  if (!exif) return null;

  const fallbackOffset = readAscii(exif, TAG_OFFSET_TIME);
  const original = readAscii(exif, TAG_DATETIME_ORIGINAL);
  if (original && parseDateTime(original)) {
    return {
      dateTime: original,
      offset: readAscii(exif, TAG_OFFSET_TIME_ORIGINAL) ?? fallbackOffset,
    };
  }
  const digitized = readAscii(exif, TAG_DATETIME_DIGITIZED);
  if (digitized && parseDateTime(digitized)) {
    return {
      dateTime: digitized,
      offset: readAscii(exif, TAG_OFFSET_TIME_DIGITIZED) ?? fallbackOffset,
    };
  }
  return null;
}

interface DateParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const DATE_RE = /^(\d{4})[:\-/](\d{2})[:\-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;

function parseDateTime(text: string): DateParts | null {
  const m = DATE_RE.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (h > 23 || mi > 59 || s > 60) return null;
  // Reject impossible dates (31 April …).
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1) return null;
  return { y, mo, d, h, mi, s: Math.min(s, 59) };
}

const OFFSET_RE = /^([+-])(\d{2}):?(\d{2})$/;
const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

function formatOffset(minutesEast: number): string {
  const sign = minutesEast < 0 ? '-' : '+';
  const abs = Math.abs(minutesEast);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * ISO 8601 timestamp with offset for an EXIF date, e.g. `2026-09-30T14:05:09+03:00`.
 * Without a recorded offset the device's local offset at that date is used (the photo was
 * normally taken by this phone, in this time zone).
 */
export function exifToIso(value: ExifDateTime): string | null {
  const p = parseDateTime(value.dateTime);
  if (!p) return null;
  let offset: string;
  const m = value.offset ? OFFSET_RE.exec(value.offset.trim()) : null;
  if (m) {
    const hours = Number(m[2]);
    const minutes = Number(m[3]);
    if (hours > 14 || minutes > 59) return null;
    offset = `${m[1]}${pad(hours)}:${pad(minutes)}`;
  } else {
    const local = new Date(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    if (Number.isNaN(local.getTime())) return null;
    offset = formatOffset(-local.getTimezoneOffset());
  }
  return `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${offset}`;
}

// ---------------------------------------------------------------------------------------
// Containers (synchronous, on bytes already in memory)
// ---------------------------------------------------------------------------------------

/** The TIFF block of the first APP1 "Exif" segment of a JPEG, or null. */
export function jpegExifBlock(bytes: Uint8Array): Uint8Array | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    let marker = bytes[at + 1] as number;
    // Fill bytes
    while (marker === 0xff && at + 2 < bytes.length) {
      at++;
      marker = bytes[at + 1] as number;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = ((bytes[at + 2] as number) << 8) | (bytes[at + 3] as number);
    if (length < 2) return null;
    const start = at + 4;
    const end = at + 2 + length;
    if (marker === 0xe1 && startsWith(bytes, start, 'Exif\0\0')) {
      const tiff = bytes.subarray(start + 6, Math.min(end, bytes.length));
      return isTiffHeader(tiff, 0) ? tiff : null;
    }
    at = end;
  }
  return null;
}

/** EXIF payload of a WebP chunk ("Exif\0\0" prefix tolerated), or null. */
export function webpExifPayload(chunk: Uint8Array): Uint8Array | null {
  const tiff = startsWith(chunk, 0, 'Exif\0\0') ? chunk.subarray(6) : chunk;
  return isTiffHeader(tiff, 0) ? tiff : null;
}

/** The "EXIF" chunk of a WebP file held completely in memory, or null. */
export function webpExifBlock(bytes: Uint8Array): Uint8Array | null {
  if (!startsWith(bytes, 0, 'RIFF') || !startsWith(bytes, 8, 'WEBP')) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 12;
  while (at + 8 <= bytes.length) {
    const size = view.getUint32(at + 4, true);
    if (startsWith(bytes, at, 'EXIF')) {
      return webpExifPayload(bytes.subarray(at + 8, Math.min(at + 8 + size, bytes.length)));
    }
    at += 8 + size + (size & 1);
  }
  return null;
}

/** The "eXIf" chunk of a PNG, or null. */
export function pngExifBlock(bytes: Uint8Array): Uint8Array | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((b, i) => bytes[i] === b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at, false);
    if (startsWith(bytes, at + 4, 'eXIf')) {
      const data = bytes.subarray(at + 8, Math.min(at + 8 + length, bytes.length));
      return webpExifPayload(data);
    }
    if (startsWith(bytes, at + 4, 'IDAT') || startsWith(bytes, at + 4, 'IEND')) return null;
    at += 12 + length;
  }
  return null;
}

/** First "Exif\0\0" immediately followed by a TIFF header (HEIC/HEIF and unknown containers). */
export function scanExifBlock(bytes: Uint8Array): Uint8Array | null {
  for (let i = 0; i + 10 <= bytes.length; i++) {
    if (bytes[i] === 0x45 && startsWith(bytes, i, 'Exif\0\0') && isTiffHeader(bytes, i + 6)) {
      return bytes.subarray(i + 6);
    }
  }
  return null;
}

/** EXIF TIFF block of a file held in memory, whatever the container. */
export function findExifBlock(bytes: Uint8Array): Uint8Array | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegExifBlock(bytes) ?? scanExifBlock(bytes);
  if (startsWith(bytes, 0, 'RIFF')) return webpExifBlock(bytes);
  if (bytes[0] === 0x89 && startsWith(bytes, 1, 'PNG')) return pngExifBlock(bytes);
  return scanExifBlock(bytes);
}

/** Capture time (ISO 8601 with offset) of a file held in memory, or null. */
export function parseExifTakenAt(bytes: Uint8Array): string | null {
  const block = findExifBlock(bytes);
  if (!block) return null;
  const value = parseTiffDateTime(block);
  return value ? exifToIso(value) : null;
}

/** True when the bytes contain an EXIF marker anywhere (used to prove the output is clean). */
export function containsExifMarker(bytes: Uint8Array): boolean {
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (
      (bytes[i] === 0x45 || bytes[i] === 0x65) && // "E" / "e"
      (startsWith(bytes, i, 'Exif') || startsWith(bytes, i, 'EXIF') || startsWith(bytes, i, 'eXIf'))
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------
// Blob reader (reads only what it needs: 2 GB phones, 25 MB originals)
// ---------------------------------------------------------------------------------------

async function readBytes(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, Math.min(end, blob.size)).arrayBuffer());
}

/** Walks the chunk headers of a WebP Blob without reading the image data. */
async function webpExifFromBlob(blob: Blob): Promise<Uint8Array | null> {
  let at = 12;
  for (let guard = 0; guard < 64 && at + 8 <= blob.size; guard++) {
    const head = await readBytes(blob, at, at + 8);
    const size = new DataView(head.buffer).getUint32(4, true);
    if (startsWith(head, 0, 'EXIF')) {
      if (size > 1024 * 1024) return null;
      return webpExifPayload(await readBytes(blob, at + 8, at + 8 + size));
    }
    at += 8 + size + (size & 1);
  }
  return null;
}

/**
 * Capture time of an original photo, read from its EXIF block; null when the file has none
 * (screenshots, edited images, cameras with EXIF disabled) or it cannot be read.
 */
export async function readTakenAt(file: Blob): Promise<string | null> {
  try {
    const head = await readBytes(file, 0, EXIF_HEAD_BYTES);
    let block: Uint8Array | null;
    if (startsWith(head, 0, 'RIFF') && startsWith(head, 8, 'WEBP')) {
      // The EXIF chunk of an extended WebP follows the image data: walk the chunk headers.
      block = file.size <= head.length ? webpExifBlock(head) : await webpExifFromBlob(file);
    } else {
      block = findExifBlock(head);
    }
    if (!block) return null;
    const value = parseTiffDateTime(block);
    return value ? exifToIso(value) : null;
  } catch {
    return null;
  }
}

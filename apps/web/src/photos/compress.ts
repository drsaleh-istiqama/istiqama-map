/**
 * On-device compression (brief §6): two versions of every photo, re-encoded on a canvas —
 *   full  : longest side ≤ 1600 px, quality 0.8
 *   thumb : longest side ≤ 400 px
 * WebP when the browser can encode it (detected once by encoding a 1×1 canvas), JPEG
 * otherwise. Re-encoding drops every byte of metadata: the output has NO EXIF; the capture
 * time is read from the original first (`exif.ts`) and travels as `taken_at`.
 *
 * Memory (2 GB Android phones): one photo at a time (a module-level queue), the decoded
 * bitmap is closed as soon as the full-size canvas holds it, the thumbnail is drawn from the
 * full-size canvas (not from the original), and canvases are shrunk to 0×0 after use.
 */
import { PhotoError } from './errors';
import { readTakenAt } from './exif';

export const FULL_MAX_SIDE = 1600;
export const THUMB_MAX_SIDE = 400;
export const FULL_QUALITY = 0.8;
export const THUMB_QUALITY = 0.7;
/** Largest original accepted (v2 parity 5.7). */
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;
/** The `photos` bucket refuses objects above 5 MB (authz.md §4.4): stay well below it. */
export const MAX_OUTPUT_BYTES = Math.floor(4.5 * 1024 * 1024);

export type PhotoMime = 'image/webp' | 'image/jpeg';

export interface CompressedPhoto {
  full: Blob;
  thumb: Blob;
  /** Size of the full version (what `project_photos.width/height` store). */
  width: number;
  height: number;
  /** Capture time from the original's EXIF (ISO 8601 with offset), or null. */
  takenAt: string | null;
  mime: PhotoMime;
}

// ---------------------------------------------------------------------------------------
// Input checks
// ---------------------------------------------------------------------------------------

const head = async (file: Blob, n: number): Promise<Uint8Array> =>
  new Uint8Array(await file.slice(0, n).arrayBuffer());

/** Raster image signatures, for files the picker hands over without a MIME type. */
export function sniffImage(bytes: Uint8Array): boolean {
  const at = (i: number): number => bytes[i] ?? -1;
  const text = (from: number, s: string): boolean =>
    [...s].every((c, i) => at(from + i) === c.charCodeAt(0));
  return (
    (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) || // JPEG
    (at(0) === 0x89 && text(1, 'PNG')) || // PNG
    text(0, 'GIF8') || // GIF
    (text(0, 'RIFF') && text(8, 'WEBP')) || // WebP
    text(0, 'BM') || // BMP
    (text(4, 'ftyp') &&
      /^(heic|heix|hevc|heim|heis|mif1|msf1|avif)$/.test(
        String.fromCharCode(at(8), at(9), at(10), at(11)),
      )) // HEIC / HEIF / AVIF
  );
}

/** Rejects what is not a raster image or is larger than 25 MB, before anything is decoded. */
export async function assertImageFile(file: Blob): Promise<void> {
  if (file.size > MAX_INPUT_BYTES) throw new PhotoError('too_large', `${file.size} bytes`);
  if (file.size === 0) throw new PhotoError('not_image', 'empty file');
  const type = (file.type || '').toLowerCase();
  if (type) {
    if (!type.startsWith('image/') || type.includes('svg')) throw new PhotoError('not_image', type);
    return;
  }
  if (!sniffImage(await head(file, 16))) throw new PhotoError('not_image', 'unknown content');
}

// ---------------------------------------------------------------------------------------
// Canvas helpers (OffscreenCanvas when available, <canvas> otherwise)
// ---------------------------------------------------------------------------------------

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

interface Surface {
  readonly canvas: OffscreenCanvas | HTMLCanvasElement;
  readonly ctx: Ctx2D;
  encode(type: PhotoMime, quality: number): Promise<Blob>;
  /** Frees the pixel memory (0×0) — browsers keep canvas buffers until GC otherwise. */
  release(): void;
}

function createSurface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      return {
        canvas,
        ctx,
        encode: (type, quality) => canvas.convertToBlob({ type, quality }),
        release: () => {
          canvas.width = 0;
          canvas.height = 0;
        },
      };
    }
  }
  if (typeof document === 'undefined') throw new PhotoError('encode_failed', 'no canvas');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new PhotoError('encode_failed', 'no 2d context');
  return {
    canvas,
    ctx,
    encode: (type, quality) =>
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new PhotoError('encode_failed', type))),
          type,
          quality,
        );
      }),
    release: () => {
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}

let webpSupport: Promise<boolean> | null = null;

/** Whether the canvas can encode WebP (Safari < 17 silently returns PNG). Detected once. */
export function canEncodeWebp(): Promise<boolean> {
  webpSupport ??= (async () => {
    let surface: Surface | null = null;
    try {
      surface = createSurface(1, 1);
      surface.ctx.fillStyle = '#fff';
      surface.ctx.fillRect(0, 0, 1, 1);
      const blob = await surface.encode('image/webp', FULL_QUALITY);
      return blob.type === 'image/webp';
    } catch {
      return false;
    } finally {
      surface?.release();
    }
  })();
  return webpSupport;
}

/** Tests only: forget the result of the WebP detection. */
export function resetEncoderDetection(): void {
  webpSupport = null;
}

/** Size that fits `max` on the longest side, never enlarged. */
export function fitWithin(width: number, height: number, max: number): [number, number] {
  const longest = Math.max(width, height);
  if (longest <= max) return [Math.max(1, Math.round(width)), Math.max(1, Math.round(height))];
  const scale = max / longest;
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

// ---------------------------------------------------------------------------------------
// Decoding (EXIF orientation applied by the browser)
// ---------------------------------------------------------------------------------------

interface Decoded {
  image: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

async function decodeWithBitmap(file: Blob): Promise<Decoded | null> {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    if (!bitmap.width || !bitmap.height) {
      bitmap.close();
      return null;
    }
    let closed = false;
    return {
      image: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => {
        if (closed) return;
        closed = true;
        bitmap.close();
      },
    };
  } catch {
    return null; // old engines reject the options bag, some cannot decode HEIC: try <img>
  }
}

async function decodeWithImage(file: Blob): Promise<Decoded | null> {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  const url = URL.createObjectURL(file);
  const img = new Image();
  const release = (): void => {
    img.removeAttribute('src');
    URL.revokeObjectURL(url);
  };
  try {
    img.decoding = 'async';
    img.src = url; // <img> applies EXIF orientation (CSS image-orientation: from-image)
    if (typeof img.decode === 'function') await img.decode();
    else
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('image load failed'));
      });
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (!width || !height) {
      release();
      return null;
    }
    let closed = false;
    return {
      image: img,
      width,
      height,
      close: () => {
        if (closed) return;
        closed = true;
        release();
      },
    };
  } catch {
    release();
    return null;
  }
}

async function decode(file: Blob): Promise<Decoded> {
  const decoded = (await decodeWithBitmap(file)) ?? (await decodeWithImage(file));
  if (!decoded) throw new PhotoError('decode_failed', file.type || 'unknown type');
  return decoded;
}

// ---------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------

function paint(surface: Surface, image: CanvasImageSource, width: number, height: number): void {
  const { ctx } = surface;
  ctx.fillStyle = '#fff'; // transparent PNGs would turn black in JPEG
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, width, height);
}

/** Encodes in `mime`; returns what the browser really produced (it may ignore the type). */
async function encodeAs(surface: Surface, mime: PhotoMime, quality: number): Promise<Blob> {
  let blob: Blob;
  try {
    blob = await surface.encode(mime, quality);
  } catch (e) {
    throw e instanceof PhotoError ? e : new PhotoError('encode_failed', mime, { cause: e });
  }
  if (!blob || blob.size === 0) throw new PhotoError('encode_failed', `${mime}: empty`);
  return blob;
}

/** Full version within the bucket limit: quality 0.8, lowered only for extreme images. */
async function encodeFull(surface: Surface, mime: PhotoMime): Promise<Blob> {
  let blob = await encodeAs(surface, mime, FULL_QUALITY);
  for (const quality of [0.65, 0.5]) {
    if (blob.size <= MAX_OUTPUT_BYTES) break;
    blob = await encodeAs(surface, mime, quality);
  }
  if (blob.size > MAX_OUTPUT_BYTES) throw new PhotoError('encode_failed', 'output too large');
  return blob;
}

const mimeOf = (blob: Blob): PhotoMime | null =>
  blob.type === 'image/webp' ? 'image/webp' : blob.type === 'image/jpeg' ? 'image/jpeg' : null;

async function compressNow(file: Blob): Promise<CompressedPhoto> {
  await assertImageFile(file);
  const takenAt = await readTakenAt(file);
  let mime: PhotoMime = (await canEncodeWebp()) ? 'image/webp' : 'image/jpeg';

  const decoded = await decode(file);
  let fullSurface: Surface | null = null;
  let thumbSurface: Surface | null = null;
  try {
    const [width, height] = fitWithin(decoded.width, decoded.height, FULL_MAX_SIDE);
    fullSurface = createSurface(width, height);
    paint(fullSurface, decoded.image, width, height);
    decoded.close(); // the original's pixels are no longer needed

    let full = await encodeFull(fullSurface, mime);
    if (mimeOf(full) !== mime) {
      // The browser ignored the requested type (WebP detection passed, encoding did not).
      mime = 'image/jpeg';
      full = await encodeFull(fullSurface, mime);
      if (mimeOf(full) !== mime) throw new PhotoError('encode_failed', `got ${full.type}`);
    }

    const [tw, th] = fitWithin(width, height, THUMB_MAX_SIDE);
    thumbSurface = createSurface(tw, th);
    paint(thumbSurface, fullSurface.canvas, tw, th);
    fullSurface.release();
    fullSurface = null;
    const thumb = await encodeAs(thumbSurface, mime, THUMB_QUALITY);
    if (mimeOf(thumb) !== mime) throw new PhotoError('encode_failed', `thumb ${thumb.type}`);

    return { full, thumb, width, height, takenAt, mime };
  } catch (e) {
    if (e instanceof PhotoError) throw e;
    // drawImage on a huge image can throw (out of memory) on low-end phones.
    throw new PhotoError('encode_failed', e instanceof Error ? e.message : String(e), { cause: e });
  } finally {
    decoded.close();
    fullSurface?.release();
    thumbSurface?.release();
  }
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Compresses one photo. Calls are queued and run strictly one after the other, so a batch of
 * ten 12-megapixel photos never holds more than one decoded image in memory.
 *
 * @throws PhotoError `not_image`, `too_large`, `decode_failed`, `encode_failed`
 */
export function compressPhoto(file: Blob): Promise<CompressedPhoto> {
  const run = queue.then(
    () => compressNow(file),
    () => compressNow(file),
  );
  queue = run.catch(() => undefined);
  return run;
}

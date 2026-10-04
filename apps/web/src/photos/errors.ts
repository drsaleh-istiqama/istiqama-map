/**
 * Errors of the photo module. Every failure the user can cause or fix has a code with a
 * translation `photos.error_<code>`; the editor shows it next to the file name.
 */

export type PhotoErrorCode =
  /** The file is not an image the app accepts (wrong type, SVG, empty file). */
  | 'not_image'
  /** The original is larger than 25 MB (v2 parity 5.7). */
  | 'too_large'
  /** The browser could not decode the image (corrupt file, HEIC on an engine without HEIC). */
  | 'decode_failed'
  /** Re-encoding on the canvas failed (out of memory on very old phones). */
  | 'encode_failed'
  /** The device has no room left for the photo (IndexedDB quota). */
  | 'storage_full'
  /** The project already has the maximum number of photos (10). */
  | 'limit_reached'
  /** `addPhoto` was called for a project that is not on this device. */
  | 'project_missing';

export class PhotoError extends Error {
  constructor(
    readonly code: PhotoErrorCode,
    detail?: string,
    options?: { cause?: unknown },
  ) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = 'PhotoError';
  }
}

export function isPhotoError(e: unknown): e is PhotoError {
  return e instanceof PhotoError;
}

/** Locale key describing a failure (namespace `photos`); unknown failures get a generic text. */
export function photoErrorKey(e: unknown): string {
  if (isPhotoError(e)) return `photos.error_${e.code}`;
  const code = (e as { kind?: unknown } | null)?.kind;
  if (code === 'storage_full') return 'photos.error_storage_full';
  return 'photos.error_unknown';
}

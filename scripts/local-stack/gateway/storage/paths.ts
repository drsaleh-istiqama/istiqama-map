/**
 * Object names and their location on disk.
 *
 * Supabase Storage validates keys with the regular expression below (S3-safe characters) and
 * keeps them in S3, where "../" means nothing. Locally objects are plain files under
 * STORAGE_DIR/<bucket>/<name>, so names are additionally checked segment by segment and the
 * resolved path must stay inside the storage root.
 */
import path from 'node:path';

// Same expression as supabase/storage (src/storage/limits.ts isValidKey).
const KEY_RE = /^(\w|\/|!|-|\.|\*|'|\(|\)| |&|\$|@|=|;|:|\+|,|\?)*$/;

export function isValidObjectName(name: string): boolean {
  if (name.length === 0 || name.length > 1024) return false;
  if (!KEY_RE.test(name)) return false;
  for (const segment of name.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false;
  }
  return true;
}

export function isValidBucketId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= 100 &&
    !id.includes('/') &&
    !id.startsWith('.') &&
    KEY_RE.test(id) &&
    id !== '..'
  );
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** Make one path segment safe on every filesystem (Windows forbids `<>:"|?*`, trailing dots…). */
export function encodeSegment(segment: string): string {
  let out = segment.replace(
    /[<>:"|?*%\\]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'),
  );
  if (/[. ]$/.test(out))
    out =
      out.slice(0, -1) +
      '%' +
      out
        .charCodeAt(out.length - 1)
        .toString(16)
        .toUpperCase()
        .padStart(2, '0');
  if (WINDOWS_RESERVED.test(out))
    out = '%' + out.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0') + out.slice(1);
  return out;
}

export class UnsafePathError extends Error {}

/** Absolute file path of an object; throws UnsafePathError for anything that would leave the root. */
export function objectFsPath(storageDir: string, bucketId: string, name: string): string {
  if (!isValidBucketId(bucketId)) throw new UnsafePathError(`invalid bucket id: ${bucketId}`);
  if (!isValidObjectName(name)) throw new UnsafePathError(`invalid object name: ${name}`);
  const root = path.resolve(storageDir);
  const full = path.resolve(root, encodeSegment(bucketId), ...name.split('/').map(encodeSegment));
  const rel = path.relative(root, full);
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new UnsafePathError(`path escapes the storage root: ${name}`);
  }
  return full;
}

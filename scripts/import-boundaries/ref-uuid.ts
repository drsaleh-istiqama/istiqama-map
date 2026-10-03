/**
 * TypeScript twin of the SQL function `private.ref_uuid(key)` (migration 0060).
 *
 * Deterministic, name-based UUID in the RFC 9562 version-3 layout, derived from
 * md5('istiqama-map:' + key). The same key gives the same id in every environment.
 * Key scheme: docs/contracts/reference-data.md, section 1.
 */
import { createHash } from 'node:crypto';

const NAMESPACE = 'istiqama-map:';
const VARIANT = '89ab';

export function refUuid(key: string): string {
  const h = createHash('md5')
    .update(NAMESPACE + key, 'utf8')
    .digest('hex');
  const variant = VARIANT[parseInt(h.charAt(16), 16) % 4] ?? '8';
  const hex = h.slice(0, 12) + '3' + h.slice(13, 16) + variant + h.slice(17);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/** Id of an imported boundary: one row per (country, level, code). */
export function adminAreaKey(iso3: string, level: number, code: string): string {
  return `admin_area:${iso3}:${level}:${code}`;
}

/** Id of a locality taken over from the v2 location tree. */
export function v2LocalityKey(iso2: string, regionKey: string, localityKey: string): string {
  return `locality:v2:${iso2}:${regionKey}:${localityKey}`;
}

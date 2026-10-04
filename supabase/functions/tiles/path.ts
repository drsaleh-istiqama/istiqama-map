/**
 * Pure parts of the `tiles` function: path / filter parsing and cache policy
 * (docs/contracts/geo-search-tiles.md §6).
 */
import { errors, isRecord } from '../_shared/http.ts';

export const MAX_ZOOM = 22;
export const MVT = 'application/vnd.mapbox-vector-tile';

export interface TileCoords {
  z: number;
  x: number;
  y: number;
}

/**
 * `/tiles/{z}/{x}/{y}` (optionally with `.mvt` / `.pbf`, with or without a
 * `/functions/v1` prefix). Null when the path is not a tile path; throws 422 when the
 * coordinates do not exist at that zoom.
 */
export function parseTilePath(pathname: string): TileCoords | null {
  const m = /(?:^|\/)tiles\/(\d{1,2})\/(\d{1,9})\/(\d{1,9})(?:\.(?:mvt|pbf))?\/?$/.exec(pathname);
  if (!m) return null;
  const z = Number(m[1]);
  const x = Number(m[2]);
  const y = Number(m[3]);
  if (z > MAX_ZOOM) throw errors.validation('invalid_tile', `Zoom must be 0…${MAX_ZOOM}.`);
  const size = 2 ** z;
  if (x >= size || y >= size)
    throw errors.validation('invalid_tile', `Tile ${z}/${x}/${y} is outside the zoom level.`);
  return { z, x, y };
}

const STRING_FILTERS = ['country_id', 'branch_id', 'type', 'status', 'record_state'] as const;
const LAYERS = new Set(['clusters', 'points', 'needs']);
const VALUE_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type TileFilters = Record<string, string | string[]>;

function stringOrList(key: string, value: unknown): string | string[] {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 || list.length > 20)
    throw errors.validation('invalid_filter', `Filter "${key}" must have 1…20 values.`);
  for (const item of list) {
    if (typeof item !== 'string' || !VALUE_RE.test(item))
      throw errors.validation('invalid_filter', `Filter "${key}" has an invalid value.`);
  }
  return Array.isArray(value) ? (list as string[]) : (list[0] as string);
}

/**
 * Filters from the query string: `f=<json>` (what the map sends) or `p_filters=<json>`.
 * Only the documented keys are forwarded, in a fixed order (stable upstream URLs).
 */
export function parseTileFilters(params: URLSearchParams): TileFilters {
  const raw = params.get('f') ?? params.get('p_filters');
  if (raw === null || raw.trim() === '') return {};
  if (raw.length > 2000) throw errors.validation('invalid_filter', 'The filter is too long.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw errors.validation('invalid_filter', 'The filter is not valid JSON.');
  }
  if (!isRecord(parsed)) throw errors.validation('invalid_filter', 'The filter must be a JSON object.');
  const out: TileFilters = {};
  for (const key of STRING_FILTERS) {
    const value = parsed[key];
    if (value === undefined || value === null || value === '') continue;
    out[key] = stringOrList(key, value);
  }
  const layers = parsed.layers;
  if (layers !== undefined && layers !== null) {
    if (!Array.isArray(layers) || layers.length === 0 || layers.some((l) => typeof l !== 'string' || !LAYERS.has(l)))
      throw errors.validation('invalid_filter', 'Filter "layers" must be a subset of clusters, points, needs.');
    out.layers = [...new Set(layers as string[])];
  }
  return out;
}

/** Tiles depend on the caller's scope: private caching only. */
export function tileCacheControl(z: number): string {
  return z < 14 ? 'private, max-age=300, stale-while-revalidate=600' : 'private, max-age=30';
}

/** Does an `If-None-Match` header match `etag`? (weak comparison, `*` matches anything) */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const bare = (tag: string): string => tag.trim().replace(/^W\//, '');
  const wanted = bare(etag);
  return ifNoneMatch.split(',').some((candidate) => {
    const c = candidate.trim();
    return c === '*' || bare(c) === wanted;
  });
}

/** Strong ETag of a tile body (first 128 bits of SHA-256, hex). */
export async function bodyEtag(body: Uint8Array): Promise<string> {
  if (body.byteLength === 0) return '"empty"';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body as BufferSource));
  let hex = '';
  for (let i = 0; i < 16; i++) hex += digest[i]!.toString(16).padStart(2, '0');
  return `"${hex}"`;
}

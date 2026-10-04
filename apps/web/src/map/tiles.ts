/**
 * Project vector tiles (docs/contracts/geo-search-tiles.md §6): URL template and the request
 * transform that adds the caller's credentials. Pure — no MapLibre import.
 *
 * The tiles are PRIVATE (they contain only what the caller may read), so every request to
 * `GET /functions/v1/tiles/{z}/{x}/{y}` carries `Authorization: Bearer <user JWT>`, `apikey`
 * and `x-device-id`. MapLibre 6 awaits an async `transformRequest`, which lets us fetch a
 * fresh token (supabase-js refreshes it when it is about to expire).
 */
import type { ProjectFilter } from '../db';

export type TileLayerName = 'clusters' | 'points' | 'needs';

/** Filters the tile function understands (§6 `p_filters`); everything else is ignored there. */
export interface TileFilters {
  country_id?: string;
  branch_id?: string;
  type?: string;
  status?: string;
  record_state?: string;
  layers: TileLayerName[];
}

/** Same value rule as the server (`/^[A-Za-z0-9_-]{1,64}$/`): anything else would be a 422. */
const VALUE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Tile filters for a list filter. The text query, the admin area, "mine", "incomplete" and
 * "open maintenance" do not exist on tiles (the map fits itself to the area instead).
 * `needs` (heat maps) is only requested while a heat map is shown: it makes tiles bigger.
 */
export function tileFilters(filter: ProjectFilter, withNeeds: boolean): TileFilters {
  const out: TileFilters = {
    layers: withNeeds ? ['clusters', 'points', 'needs'] : ['clusters', 'points'],
  };
  const take = (value: string | undefined): string | undefined =>
    value && VALUE_RE.test(value) ? value : undefined;
  const country = take(filter.countryId);
  const branch = take(filter.branchId);
  const type = take(filter.type);
  const status = take(filter.status);
  const recordState = take(filter.recordState);
  if (country) out.country_id = country;
  if (branch) out.branch_id = branch;
  if (type) out.type = type;
  if (status) out.status = status;
  if (recordState) out.record_state = recordState;
  return out;
}

/**
 * `{functions}/tiles/{z}/{x}/{y}?f=<json>&e=<scope epoch>`. The JSON is URI-encoded, so its
 * braces never collide with MapLibre's `{z}/{x}/{y}` placeholders. `e` changes when the
 * caller's roles change and so invalidates browser / service-worker caches (§6).
 */
export function projectTilesUrl(
  functionsBase: string,
  filters: TileFilters,
  scopeEpoch: string | null | undefined,
): string {
  const base = functionsBase.replace(/\/+$/, '');
  const f = encodeURIComponent(JSON.stringify(filters));
  const e = encodeURIComponent(scopeEpoch ?? '0');
  return `${base}/tiles/{z}/{x}/{y}?f=${f}&e=${e}`;
}

export interface TransformDeps {
  /** `{VITE_SUPABASE_URL}/functions/v1` */
  functionsBase: string;
  anonKey: string;
  deviceId: () => string;
  /** Current access token of the signed-in user (null when signed out). */
  token: () => Promise<string | null>;
}

export interface TransformedRequest {
  url: string;
  headers?: Record<string, string>;
}

/** True for requests to the private project tiles. */
export function isProjectTileUrl(url: string, functionsBase: string): boolean {
  return url.startsWith(`${functionsBase.replace(/\/+$/, '')}/tiles/`);
}

/**
 * MapLibre `transformRequest`: adds the credentials to project tile requests and leaves every
 * other URL untouched. Returns a plain object (never `undefined`) for other URLs: MapLibre
 * awaits the result and needs a request back.
 */
export function createTransformRequest(
  deps: TransformDeps,
): (url: string, resourceType?: string) => TransformedRequest | Promise<TransformedRequest> {
  return (url) => {
    if (!isProjectTileUrl(url, deps.functionsBase)) return { url };
    return deps.token().then((token) => {
      const headers: Record<string, string> = {
        apikey: deps.anonKey,
        'x-device-id': deps.deviceId(),
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      return { url, headers };
    });
  };
}

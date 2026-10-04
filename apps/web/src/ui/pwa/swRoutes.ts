/**
 * Service-worker routing rules as pure functions (no Workbox, no browser globals), so the
 * decision "what may be cached, and how" is unit-tested. `src/sw.ts` wires each kind to a
 * Workbox strategy.
 */

export type RequestKind =
  /** Page navigation → network first, offline fallback to the precached shell. */
  | 'navigation'
  /** Supabase REST / RPC / Auth / Functions / Realtime → network only, NEVER cached. */
  | 'api'
  /** Vector tiles of projects (per-user content) → stale-while-revalidate, small and short-lived. */
  | 'mvt'
  /** Photo thumbnails (immutable per photo id) → cache first with expiration. */
  | 'thumbnail'
  /** Other storage objects: full-size photos via signed URLs, exports, imports → network only. */
  | 'storage'
  /** PMTiles basemap and offline map packs (range requests) → extension point for the map module. */
  | 'pmtiles'
  /** Locale JSON and font files that are not in the precache → cache first. */
  | 'static-data'
  /** Hashed build assets that are not in the precache → cache first. */
  | 'asset'
  /** Everything else → not handled by the service worker (plain network). */
  | 'other';

export interface RequestInfoLike {
  url: string;
  method?: string;
  /** `request.mode`; `'navigate'` for page loads. */
  mode?: string;
}

export interface RouteEnv {
  /** Origin the app is served from. */
  appOrigin: string;
  /** Origin of VITE_SUPABASE_URL. */
  supabaseOrigin: string;
  /** VITE_TILES_URL (may be a path under the Supabase storage origin). */
  tilesUrl: string;
}

const THUMBNAIL = /_thumb\.[a-z0-9]+$/i;
const MVT_PATHS = ['/rest/v1/rpc/tile_projects', '/functions/v1/tiles'];
const API_PREFIXES = ['/rest/v1/', '/auth/v1/', '/functions/v1/', '/realtime/v1/', '/graphql/v1'];

function startsWithPath(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

export function isSupabaseRequest(url: URL, env: RouteEnv): boolean {
  return env.supabaseOrigin !== '' && url.origin === env.supabaseOrigin;
}

/** Vector tiles of the project layers (`tile_projects` RPC or the `tiles` Edge Function). */
export function isMvtTile(url: URL, env: RouteEnv): boolean {
  return (
    isSupabaseRequest(url, env) && MVT_PATHS.some((path) => startsWithPath(url.pathname, path))
  );
}

/** Supabase REST / RPC / Auth / Functions calls, except the tile endpoints. */
export function isApiCall(url: URL, env: RouteEnv): boolean {
  return (
    isSupabaseRequest(url, env) &&
    API_PREFIXES.some((prefix) => url.pathname.startsWith(prefix)) &&
    !isMvtTile(url, env)
  );
}

export function isStorageObject(url: URL, env: RouteEnv): boolean {
  return isSupabaseRequest(url, env) && url.pathname.startsWith('/storage/v1/');
}

/** PMTiles archives: anything under VITE_TILES_URL or any `.pmtiles` file. */
export function isPmtiles(url: URL, env: RouteEnv): boolean {
  if (url.pathname.toLowerCase().endsWith('.pmtiles')) return true;
  if (!env.tilesUrl) return false;
  try {
    const base = new URL(env.tilesUrl, env.appOrigin);
    return (
      url.origin === base.origin && startsWithPath(url.pathname, base.pathname.replace(/\/+$/, ''))
    );
  } catch {
    return false;
  }
}

/** Storage object whose name ends in `_thumb.<ext>` (authenticated, public or signed URL). */
export function isThumbnail(url: URL, env: RouteEnv): boolean {
  return (
    isStorageObject(url, env) &&
    url.pathname.startsWith('/storage/v1/object/') &&
    THUMBNAIL.test(url.pathname)
  );
}

export function classifyRequest(request: RequestInfoLike, env: RouteEnv): RequestKind {
  let url: URL;
  try {
    url = new URL(request.url, env.appOrigin);
  } catch {
    return 'other';
  }
  // Only GET responses are ever cached; uploads (TUS), RPC POSTs and sign-in go straight to the network.
  if ((request.method ?? 'GET').toUpperCase() !== 'GET')
    return isSupabaseRequest(url, env) ? 'api' : 'other';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'other';

  if (isMvtTile(url, env)) return 'mvt';
  if (isApiCall(url, env)) return 'api';
  if (isPmtiles(url, env)) return 'pmtiles';
  if (isThumbnail(url, env)) return 'thumbnail';
  if (isStorageObject(url, env)) return 'storage';
  if (isSupabaseRequest(url, env)) return 'api';

  if (url.origin !== env.appOrigin) return 'other';
  if (request.mode === 'navigate') return 'navigation';
  if (/^\/locales\/[\w-]+\.json$/.test(url.pathname) || /\.woff2?$/.test(url.pathname))
    return 'static-data';
  if (url.pathname.startsWith('/assets/')) return 'asset';
  return 'other';
}

/**
 * Cache key of a thumbnail: origin + path, without the query string. Signed URLs differ only
 * in their short-lived `token`, and the object behind a photo id never changes.
 */
export function thumbnailCacheKey(url: string): string {
  const parsed = new URL(url);
  return (
    parsed.origin +
    parsed.pathname
      .replace('/object/sign/', '/object/')
      .replace('/object/authenticated/', '/object/')
  );
}

/** Responses that may be stored: successful, complete ones only (no errors, no opaque, no partial content). */
export function isCacheableStatus(status: number, allowEmpty = false): boolean {
  return status === 200 || (allowEmpty && status === 204);
}

/** Runtime cache names. Not versioned: photos and tiles survive application updates. */
export const CACHE_NAMES = {
  thumbnails: 'istiqama-thumbnails',
  tiles: 'istiqama-project-tiles',
  staticData: 'istiqama-static-data',
  assets: 'istiqama-assets',
  /** Full PMTiles files stored by the map module (offline packs); served with Range support. */
  mapPacks: 'istiqama-map-packs',
} as const;

/** Caches holding per-user content: emptied on sign-out (`purgeUserCaches()` in `register.ts`). */
export const USER_CACHES: readonly string[] = [CACHE_NAMES.thumbnails, CACHE_NAMES.tiles];

/** Cache names used by v2 (`istiqama-map-v2.5.0`): removed when v3 takes over the origin. */
export function isLegacyCache(name: string): boolean {
  return /^istiqama-map-v\d/.test(name);
}

/** Messages the page may post to the service worker. */
export const SW_MESSAGES = {
  /** Activate the waiting worker — sent only after the user accepted the update prompt. */
  skipWaiting: 'SKIP_WAITING',
  /** Reply on the transferred MessagePort with `{ version }`. */
  getVersion: 'GET_VERSION',
} as const;

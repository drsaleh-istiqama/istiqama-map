/// <reference lib="webworker" />
/**
 * Service worker (Workbox, injectManifest) — brief §1 and §12.
 *
 *  - The hashed application shell is precached; old precaches are removed.
 *  - One runtime rule per request type (see `ui/pwa/swRoutes.ts`, unit-tested):
 *      navigation   network first (3 s), offline fallback to the precached shell, never stored
 *      api          Supabase REST / RPC / Auth / Functions: network only, never cached
 *      storage      signed full-size photos, exports: network only
 *      thumbnail    `…_thumb.*` storage objects: cache first, bounded and expiring
 *      mvt          project vector tiles: stale-while-revalidate, small and short-lived
 *      pmtiles      EXTENSION POINT for the map module (offline packs, Range requests)
 *      static-data  locale JSON and fonts outside the precache: cache first
 *      asset        hashed build assets outside the precache: cache first
 *  - Only complete, successful responses are stored (no errors, no opaque responses).
 *  - `skipWaiting()` runs only when the page asks for it, i.e. after the user accepted the
 *    update prompt. The version comes from APP_VERSION (root package.json), nowhere else.
 */
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { clientsClaim } from 'workbox-core';
import type { WorkboxPlugin } from 'workbox-core/types';
import { ExpirationPlugin } from 'workbox-expiration';
import {
  cleanupOutdatedCaches,
  matchPrecache,
  precacheAndRoute,
  type PrecacheEntry,
} from 'workbox-precaching';
import { RangeRequestsPlugin } from 'workbox-range-requests';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst, NetworkOnly, StaleWhileRevalidate } from 'workbox-strategies';
import {
  CACHE_NAMES,
  classifyRequest,
  isLegacyCache,
  SW_MESSAGES,
  thumbnailCacheKey,
  type RequestKind,
  type RouteEnv,
} from './ui/pwa/swRoutes';
import { APP_VERSION } from './version';

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<PrecacheEntry | string>;
  __WB_DISABLE_DEV_LOGS?: boolean;
};

self.__WB_DISABLE_DEV_LOGS = true;

const SHELL_URL = 'index.html';
const NAVIGATION_TIMEOUT_SECONDS = 3;
const DAY = 24 * 60 * 60;

function safeOrigin(url: string | undefined): string {
  try {
    return url ? new URL(url).origin : '';
  } catch {
    return '';
  }
}

const routeEnv: RouteEnv = {
  appOrigin: self.location.origin,
  supabaseOrigin: safeOrigin(import.meta.env.VITE_SUPABASE_URL as string | undefined),
  tilesUrl: (import.meta.env.VITE_TILES_URL as string | undefined) ?? '',
};

const kinds = new WeakMap<Request, RequestKind>();
function kindOf(request: Request): RequestKind {
  let kind = kinds.get(request);
  if (!kind) {
    kind = classifyRequest(
      { url: request.url, method: request.method, mode: request.mode },
      routeEnv,
    );
    kinds.set(request, kind);
  }
  return kind;
}
const is =
  (kind: RequestKind) =>
  ({ request }: { request: Request }): boolean =>
    kindOf(request) === kind;

/** Never store anything through this strategy. */
const neverStore: WorkboxPlugin = { cacheWillUpdate: async () => null };
const okOnly = new CacheableResponsePlugin({ statuses: [200] });

// --- Navigation: network first, the precached shell when offline, slow or broken --------------
const precachedShell = async (): Promise<Response | undefined> => matchPrecache(SHELL_URL);
registerRoute(
  new NavigationRoute(
    new NetworkFirst({
      cacheName: 'istiqama-navigation-unused',
      networkTimeoutSeconds: NAVIGATION_TIMEOUT_SECONDS,
      plugins: [
        neverStore,
        {
          // A 404/500 from the host is as good as no answer: fall back to the shell.
          fetchDidSucceed: async ({ response }) => {
            if (response.ok || response.type === 'opaqueredirect') return response;
            throw new Error(`navigation failed with status ${response.status}`);
          },
          // "Cache" of this strategy = the precached shell (used on timeout and on failure).
          cachedResponseWillBeUsed: async ({ cachedResponse }) =>
            cachedResponse ?? (await precachedShell()),
          handlerDidError: async () => precachedShell(),
        },
      ],
    }),
    // Real files (manifest, icons, downloads) are not application routes.
    { denylist: [/\/[^/?]+\.[a-z0-9]+$/i] },
  ),
);

// --- Precache: hashed shell (JS, CSS, HTML, fonts, icons, locale chunks) -----------------------
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// --- Supabase REST / RPC / Auth / Functions: NEVER cached --------------------------------------
registerRoute(is('api'), new NetworkOnly());

// --- Storage: full-size photos (signed URLs), exports, imports: network only -------------------
registerRoute(is('storage'), new NetworkOnly());

// --- Photo thumbnails: immutable per photo id → cache first, bounded ---------------------------
registerRoute(
  is('thumbnail'),
  new CacheFirst({
    cacheName: CACHE_NAMES.thumbnails,
    matchOptions: { ignoreVary: true },
    plugins: [
      { cacheKeyWillBeUsed: async ({ request }) => thumbnailCacheKey(request.url) },
      okOnly,
      new ExpirationPlugin({ maxEntries: 1500, maxAgeSeconds: 30 * DAY, purgeOnQuotaError: true }),
    ],
  }),
);

// --- Project vector tiles (per-user content): stale-while-revalidate, small, short-lived -------
// docs/contracts/geo-search-tiles.md §6. Emptied on sign-out by `purgeUserCaches()`.
registerRoute(
  is('mvt'),
  new StaleWhileRevalidate({
    cacheName: CACHE_NAMES.tiles,
    plugins: [
      new CacheableResponsePlugin({ statuses: [200, 204] }),
      new ExpirationPlugin({ maxEntries: 500, maxAgeSeconds: 60 * 60, purgeOnQuotaError: true }),
    ],
  }),
);

// ==============================================================================================
// EXTENSION POINT — map module (PMTiles basemap, glyphs, sprites, offline map packs)
// ----------------------------------------------------------------------------------------------
// Requests under VITE_TILES_URL (and any *.pmtiles) arrive here. This rule stores nothing by
// itself. When the map module has saved a COMPLETE file in the Cache Storage bucket
// `CACHE_NAMES.mapPacks` (cache.put(url, fullResponse)), Range requests for that URL are
// answered from it with 206 Partial Content (workbox-range-requests); everything else goes to
// the network untouched. Packs kept in OPFS / IndexedDB bypass the service worker entirely.
// ==============================================================================================
registerRoute(
  is('pmtiles'),
  new CacheFirst({
    cacheName: CACHE_NAMES.mapPacks,
    matchOptions: { ignoreSearch: true, ignoreVary: true },
    plugins: [neverStore, new RangeRequestsPlugin()],
  }),
);

// --- Locale JSON and fonts that are not part of the precache ------------------------------------
registerRoute(
  is('static-data'),
  new CacheFirst({
    cacheName: CACHE_NAMES.staticData,
    plugins: [
      okOnly,
      new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 365 * DAY, purgeOnQuotaError: true }),
    ],
  }),
);

// --- Hashed build assets that are not part of the precache (oversized chunks, newer build) ------
registerRoute(
  is('asset'),
  new CacheFirst({
    cacheName: CACHE_NAMES.assets,
    plugins: [
      okOnly,
      new ExpirationPlugin({ maxEntries: 60, maxAgeSeconds: 30 * DAY, purgeOnQuotaError: true }),
    ],
  }),
);

// --- Lifecycle ---------------------------------------------------------------------------------
clientsClaim();

self.addEventListener('activate', (event) => {
  // v2 cached every response without limit under `istiqama-map-v2.x`; drop those caches.
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter(isLegacyCache).map((name) => caches.delete(name)))),
  );
});

self.addEventListener('message', (event) => {
  const type = (event.data as { type?: unknown } | null)?.type;
  if (type === SW_MESSAGES.skipWaiting) {
    // Sent by the page only after the user accepted the "update available" prompt.
    void self.skipWaiting();
  } else if (type === SW_MESSAGES.getVersion) {
    event.ports[0]?.postMessage({ version: APP_VERSION });
  }
});

import { describe, expect, it } from 'vitest';
import { ESSENTIAL_GLYPHS, GLYPH_CACHE, glyphFileUrl } from '../../map/glyphs';
import {
  CACHE_NAMES,
  classifyRequest,
  GLYPH_CACHE_POLICY,
  glyphWarmUrls,
  isApiCall,
  isCacheableStatus,
  isLegacyCache,
  isMvtTile,
  isPmtiles,
  isThumbnail,
  thumbnailCacheKey,
  USER_CACHES,
  type RouteEnv,
} from './swRoutes';

const APP = 'https://map.example.org';
const API = 'https://api.example.org';
const env: RouteEnv = {
  appOrigin: APP,
  supabaseOrigin: API,
  tilesUrl: `${API}/storage/v1/object/public/tiles`,
};
const kind = (url: string, init: { method?: string; mode?: string } = {}) =>
  classifyRequest({ url, ...init }, env);

describe('classifyRequest', () => {
  it('navigations inside the app → navigation (network first, shell fallback)', () => {
    expect(kind(`${APP}/`, { mode: 'navigate' })).toBe('navigation');
    expect(kind(`${APP}/projects/0190/edit`, { mode: 'navigate' })).toBe('navigation');
    expect(kind(`${APP}/reports?x=1`, { mode: 'navigate' })).toBe('navigation');
  });

  it('Supabase REST, RPC, Auth and Functions are never cached', () => {
    expect(kind(`${API}/rest/v1/projects?select=*`)).toBe('api');
    expect(kind(`${API}/rest/v1/rpc/my_context`)).toBe('api');
    expect(kind(`${API}/rest/v1/app_settings?select=key,value`)).toBe('api');
    expect(kind(`${API}/auth/v1/user`)).toBe('api');
    expect(kind(`${API}/functions/v1/export`)).toBe('api');
    expect(kind(`${API}/realtime/v1/websocket`)).toBe('api');
    expect(kind(`${API}/anything/else`)).toBe('api');
  });

  it('non-GET requests to Supabase are api (push, pull, sign-in, TUS uploads) — even on tile or storage paths', () => {
    expect(kind(`${API}/rest/v1/rpc/sync_push`, { method: 'POST' })).toBe('api');
    expect(kind(`${API}/rest/v1/rpc/sync_pull`, { method: 'POST' })).toBe('api');
    expect(kind(`${API}/auth/v1/token?grant_type=refresh_token`, { method: 'POST' })).toBe('api');
    expect(kind(`${API}/storage/v1/upload/resumable/abc`, { method: 'PATCH' })).toBe('api');
    expect(kind(`${API}/storage/v1/upload/resumable/abc`, { method: 'HEAD' })).toBe('api');
    expect(kind(`${API}/rest/v1/rpc/tile_projects`, { method: 'POST' })).toBe('api');
    expect(
      kind(`${API}/storage/v1/object/photos/projects/TZ/p/x_thumb.webp`, { method: 'DELETE' }),
    ).toBe('api');
  });

  it('project vector tiles → mvt (stale-while-revalidate)', () => {
    expect(kind(`${API}/rest/v1/rpc/tile_projects?z=7&x=78&y=65&p_filters=%7B%7D`)).toBe('mvt');
    expect(kind(`${API}/functions/v1/tiles/7/78/65?e=abc`)).toBe('mvt');
    expect(kind(`${API}/functions/v1/tiles?z=7&x=78&y=65`)).toBe('mvt');
    expect(kind(`${API}/functions/v1/tiles-admin`)).toBe('api');
    expect(kind(`${API}/rest/v1/rpc/tile_projects_other`)).toBe('api');
  });

  it('thumbnails → thumbnail (cache first) for authenticated, public and signed URLs', () => {
    const path = 'photos/projects/TZ/0190aaaa/0190bbbb_thumb.webp';
    expect(kind(`${API}/storage/v1/object/${path}`)).toBe('thumbnail');
    expect(kind(`${API}/storage/v1/object/authenticated/${path}`)).toBe('thumbnail');
    expect(kind(`${API}/storage/v1/object/sign/${path}?token=eyJ.a.b`)).toBe('thumbnail');
    expect(kind(`${API}/storage/v1/object/photos/projects/TZ/p/x_thumb.jpg`)).toBe('thumbnail');
  });

  it('full-size photos, signed downloads and exports → storage (network only)', () => {
    expect(kind(`${API}/storage/v1/object/sign/photos/projects/TZ/p/x_full.webp?token=t`)).toBe(
      'storage',
    );
    expect(kind(`${API}/storage/v1/object/photos/projects/TZ/p/x_full.webp`)).toBe('storage');
    expect(kind(`${API}/storage/v1/object/sign/exports/u1/projects.xlsx?token=t`)).toBe('storage');
    expect(kind(`${API}/storage/v1/object/photos/projects/TZ/p/thumbnail_full.webp`)).toBe(
      'storage',
    );
    expect(kind(`${API}/storage/v1/object/list/photos`)).toBe('storage');
  });

  it('PMTiles and everything under the tiles URL → pmtiles (map module extension point)', () => {
    expect(kind(`${API}/storage/v1/object/public/tiles/east-africa.pmtiles`)).toBe('pmtiles');
    expect(kind(`${API}/storage/v1/object/public/tiles/packs/tz-pemba.pmtiles`)).toBe('pmtiles');
    expect(kind(`${API}/storage/v1/object/public/tiles/fonts/Noto/0-255.pbf`)).toBe('pmtiles');
    expect(kind('https://cdn.example.net/maps/kenya.PMTILES')).toBe('pmtiles');
    expect(kind(`${API}/storage/v1/object/public/tilesets/x.bin`)).toBe('storage');
  });

  it('same-origin static files outside the precache', () => {
    expect(kind(`${APP}/locales/sw.json`)).toBe('static-data');
    expect(kind(`${APP}/assets/tajawal-arabic-400-normal-abc123.woff2`)).toBe('static-data');
    expect(kind(`${APP}/assets/MapView-9f8e7d.js`)).toBe('asset');
    expect(kind(`${APP}/assets/index-123.css`)).toBe('asset');
    expect(kind(`${APP}/manifest.webmanifest`)).toBe('other');
    expect(kind(`${APP}/some/data.json`)).toBe('other');
  });

  it('map glyph ranges of the app → glyphs (cache first in the map module bucket)', () => {
    expect(kind(`${APP}/map/fonts/Noto%20Sans%20Regular/0-255.pbf`)).toBe('glyphs');
    expect(kind(`${APP}/map/fonts/Noto%20Sans%20Medium/65024-65279.pbf`)).toBe('glyphs');
    // under a base path
    expect(kind(`${APP}/app/map/fonts/Noto%20Sans%20Italic/256-511.pbf`)).toBe('glyphs');
    // not glyph files
    expect(kind(`${APP}/map/fonts/OFL.txt`)).toBe('other');
    expect(kind(`${APP}/map/fonts/Noto%20Sans%20Regular/0-255.pbf.bak`)).toBe('other');
    expect(kind(`${APP}/map/sprites/light.json`)).toBe('other');
    expect(kind('https://example.com/map/fonts/Noto%20Sans%20Regular/0-255.pbf')).toBe('other');
    expect(kind(`${APP}/map/fonts/Noto%20Sans%20Regular/0-255.pbf`, { method: 'POST' })).toBe(
      'other',
    );
    // a self-hosted deployment where the API or the tiles share the app origin
    const shared: RouteEnv = { appOrigin: APP, supabaseOrigin: APP, tilesUrl: `${APP}/map` };
    expect(
      classifyRequest({ url: `${APP}/map/fonts/Noto%20Sans%20Regular/0-255.pbf` }, shared),
    ).toBe('glyphs');
  });

  it('other origins and odd requests are left alone', () => {
    expect(kind('https://example.com/whatever.js')).toBe('other');
    expect(kind('https://example.com/', { mode: 'navigate' })).toBe('other');
    expect(kind(`${APP}/api/form`, { method: 'POST' })).toBe('other');
    expect(kind('chrome-extension://abc/script.js')).toBe('other');
    expect(kind('http://[bad')).toBe('other');
  });

  it('works when the tiles are served from their own origin', () => {
    const own: RouteEnv = { ...env, tilesUrl: 'https://tiles.example.org/v1' };
    expect(classifyRequest({ url: 'https://tiles.example.org/v1/sprites/light.png' }, own)).toBe(
      'pmtiles',
    );
    expect(classifyRequest({ url: 'https://tiles.example.org/other/x.png' }, own)).toBe('other');
    expect(classifyRequest({ url: `${API}/storage/v1/object/public/tiles/a.png` }, own)).toBe(
      'storage',
    );
  });

  it('without a configured Supabase origin nothing is treated as API', () => {
    const none: RouteEnv = { appOrigin: APP, supabaseOrigin: '', tilesUrl: '' };
    expect(classifyRequest({ url: `${API}/rest/v1/projects` }, none)).toBe('other');
    expect(classifyRequest({ url: `${APP}/x`, mode: 'navigate' }, none)).toBe('navigation');
  });
});

describe('predicates', () => {
  const url = (value: string): URL => new URL(value);

  it('isApiCall excludes the tile endpoints', () => {
    expect(isApiCall(url(`${API}/rest/v1/rpc/search`), env)).toBe(true);
    expect(isApiCall(url(`${API}/rest/v1/rpc/tile_projects`), env)).toBe(false);
    expect(isMvtTile(url(`${API}/rest/v1/rpc/tile_projects`), env)).toBe(true);
    expect(isApiCall(url(`${APP}/rest/v1/rpc/search`), env)).toBe(false);
  });

  it('isThumbnail needs a storage object whose name ends in _thumb.<ext>', () => {
    expect(isThumbnail(url(`${API}/storage/v1/object/photos/a/b_thumb.webp`), env)).toBe(true);
    expect(isThumbnail(url(`${API}/storage/v1/object/photos/a/b_thumb.webp.bak`), env)).toBe(false);
    expect(isThumbnail(url(`${API}/storage/v1/object/photos/a/b_thumbs`), env)).toBe(false);
    expect(isThumbnail(url(`${APP}/storage/v1/object/photos/a/b_thumb.webp`), env)).toBe(false);
    expect(isThumbnail(url(`${API}/rest/v1/b_thumb.webp`), env)).toBe(false);
  });

  it('isPmtiles tolerates a trailing slash in the tiles URL', () => {
    const slash: RouteEnv = { ...env, tilesUrl: `${API}/storage/v1/object/public/tiles/` };
    expect(isPmtiles(url(`${API}/storage/v1/object/public/tiles/a.bin`), slash)).toBe(true);
    expect(isPmtiles(url(`${API}/storage/v1/object/public/tiles`), slash)).toBe(true);
    expect(isPmtiles(url(`${API}/storage/v1/object/public/tiles2/a.bin`), slash)).toBe(false);
  });
});

describe('cache rules', () => {
  it('a thumbnail has one cache key whatever the token or access path', () => {
    const key = `${API}/storage/v1/object/photos/projects/TZ/p/x_thumb.webp`;
    expect(
      thumbnailCacheKey(
        `${API}/storage/v1/object/sign/photos/projects/TZ/p/x_thumb.webp?token=AAA`,
      ),
    ).toBe(key);
    expect(
      thumbnailCacheKey(
        `${API}/storage/v1/object/sign/photos/projects/TZ/p/x_thumb.webp?token=BBB`,
      ),
    ).toBe(key);
    expect(
      thumbnailCacheKey(`${API}/storage/v1/object/authenticated/photos/projects/TZ/p/x_thumb.webp`),
    ).toBe(key);
    expect(thumbnailCacheKey(key)).toBe(key);
  });

  it('only complete successful responses may be stored — never errors, opaque or partial ones', () => {
    expect(isCacheableStatus(200)).toBe(true);
    for (const status of [0, 204, 206, 301, 304, 401, 403, 404, 429, 500, 503]) {
      expect(isCacheableStatus(status), String(status)).toBe(false);
    }
    expect(isCacheableStatus(204, true)).toBe(true); // an empty vector tile is a valid answer
    expect(isCacheableStatus(206, true)).toBe(false);
    expect(isCacheableStatus(500, true)).toBe(false);
  });

  it('per-user caches are the thumbnails and the project tiles', () => {
    expect([...USER_CACHES].sort()).toEqual([CACHE_NAMES.thumbnails, CACHE_NAMES.tiles].sort());
    expect(new Set(Object.values(CACHE_NAMES)).size).toBe(Object.values(CACHE_NAMES).length);
  });

  it('glyphs live in the bucket the map module reads — one copy, never two', () => {
    expect(CACHE_NAMES.glyphs).toBe(GLYPH_CACHE);
    // not purged on sign-out (shipped fonts, no user content)
    expect(USER_CACHES).not.toContain(CACHE_NAMES.glyphs);
    expect(GLYPH_CACHE_POLICY.maxEntries).toBeGreaterThanOrEqual(39); // every shipped range fits
    expect(GLYPH_CACHE_POLICY.maxAgeSeconds).toBeGreaterThan(0);
  });

  it('the ranges warmed at install are the map module essentials, under its own URLs', () => {
    const urls = glyphWarmUrls(`${APP}/`, ESSENTIAL_GLYPHS, glyphFileUrl);
    expect(urls).toHaveLength(ESSENTIAL_GLYPHS.length);
    expect(urls[0]).toBe(glyphFileUrl(`${APP}/`, 'Noto Sans Regular', '0-255'));
    expect(urls[0]).toBe(`${APP}/map/fonts/Noto%20Sans%20Regular/0-255.pbf`);
    // the worker would route every one of them to the glyph bucket
    for (const u of urls) expect(kind(u)).toBe('glyphs');
    // Arabic letters and their presentation forms are there (names are Arabic first)
    expect(urls).toContain(`${APP}/map/fonts/Noto%20Sans%20Regular/1536-1791.pbf`);
    expect(urls).toContain(`${APP}/map/fonts/Noto%20Sans%20Regular/65024-65279.pbf`);
    // a scope without a trailing slash and duplicates are handled
    expect(
      glyphWarmUrls(
        `${APP}/app`,
        [
          ['Noto Sans Regular', '0-255'],
          ['Noto Sans Regular', '0-255'],
        ],
        glyphFileUrl,
      ),
    ).toEqual([`${APP}/app/map/fonts/Noto%20Sans%20Regular/0-255.pbf`]);
  });

  it('every warmed range is a file that ships with the app', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const fonts = path.resolve(__dirname, '..', '..', '..', 'public', 'map', 'fonts');
    for (const [font, range] of ESSENTIAL_GLYPHS) {
      expect(fs.existsSync(path.join(fonts, font, `${range}.pbf`)), `${font} ${range}`).toBe(true);
    }
  });

  it('recognises the caches left behind by v2', () => {
    expect(isLegacyCache('istiqama-map-v2.5.0')).toBe(true);
    expect(isLegacyCache('istiqama-map-v2.4.0')).toBe(true);
    expect(isLegacyCache(CACHE_NAMES.thumbnails)).toBe(false);
    expect(isLegacyCache('workbox-precache-v2-https://map.example.org/')).toBe(false);
  });
});

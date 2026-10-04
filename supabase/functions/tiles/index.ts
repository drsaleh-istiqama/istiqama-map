/**
 * tiles — `GET /functions/v1/tiles/{z}/{x}/{y}?f=<json filters>&e=<scope epoch>`
 *
 * Calls `tile_projects` through PostgREST with the caller's token (so the tile contains only
 * what the caller may read) and adds what a raw RPC call cannot give: cache headers, ETag /
 * 304, 204 for empty tiles, gzip, and a per-user rate limit (the RPC is STABLE and cannot use
 * the database limiter). Contract: docs/contracts/geo-search-tiles.md §6.
 *
 * `e` (scope epoch) is ignored here: it only makes the URL change when the caller's roles
 * change, which invalidates browser and service-worker caches.
 */
import { identify } from '../_shared/auth.ts';
import { callerHeaders, restFetch } from '../_shared/clients.ts';
import { boolEnv, intEnv, serveIfEntryPoint } from '../_shared/env.ts';
import { createHandler, errors } from '../_shared/http.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';
import {
  MVT,
  bodyEtag,
  etagMatches,
  parseTileFilters,
  parseTilePath,
  tileCacheControl,
} from './path.ts';

// A map move requests 12–40 tiles; 1,200 / minute leaves room for fast panning.
const PER_MINUTE = intEnv('TILES_RATE_PER_MINUTE', 1200, 1);
const GZIP = boolEnv('TILES_GZIP', true);
const GZIP_MIN_BYTES = 512;

async function gzip(body: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(body as BodyInit).body!.pipeThrough(
    new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const handler = createHandler('tiles', ['GET'], async (req, { timing }) => {
  const caller = identify(req);
  enforceRateLimit('tiles', caller.userId, PER_MINUTE);

  const url = new URL(req.url);
  const coords = parseTilePath(url.pathname);
  if (!coords) throw errors.notFound('not_found', 'Use /tiles/{z}/{x}/{y}.');
  const filters = parseTileFilters(url.searchParams);

  const query = new URLSearchParams({
    z: String(coords.z),
    x: String(coords.x),
    y: String(coords.y),
  });
  if (Object.keys(filters).length > 0) query.set('p_filters', JSON.stringify(filters));

  let upstream: Response;
  try {
    upstream = await timing.measure('db', () =>
      restFetch(callerHeaders(req), `rpc/tile_projects?${query.toString()}`, {
        method: 'GET',
        headers: { accept: MVT },
      }),
    );
  } catch (e) {
    throw errors.upstream('upstream_unavailable', e instanceof Error ? e.message : String(e));
  }

  if (!upstream.ok) {
    // PostgREST error (PT422, 401, …): same status and body, never cached.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }

  const body = new Uint8Array(await upstream.arrayBuffer());
  const etag = await bodyEtag(body);
  const headers = new Headers({
    'cache-control': tileCacheControl(coords.z),
    vary: 'Authorization, Accept-Encoding',
    etag,
  });
  if (etagMatches(req.headers.get('if-none-match'), etag))
    return new Response(null, { status: 304, headers });
  if (body.byteLength === 0) return new Response(null, { status: 204, headers });

  headers.set('content-type', MVT);
  if (
    GZIP &&
    body.byteLength >= GZIP_MIN_BYTES &&
    /\bgzip\b/i.test(req.headers.get('accept-encoding') ?? '')
  ) {
    const packed = await timing.measure('gzip', () => gzip(body));
    headers.set('content-encoding', 'gzip');
    headers.set('etag', `W/${etag}`); // the validator of an encoded representation is weak
    return new Response(packed as BodyInit, { status: 200, headers });
  }
  return new Response(body as BodyInit, { status: 200, headers });
});

export default handler;
serveIfEntryPoint(import.meta, handler);

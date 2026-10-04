import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpError } from '../_shared/http.ts';
import { handler } from './index.ts';
import {
  MVT,
  bodyEtag,
  etagMatches,
  parseTileFilters,
  parseTilePath,
  tileCacheControl,
} from './path.ts';

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function userToken(sub: string): string {
  return `${b64url({ alg: 'HS256' })}.${b64url({ sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

function status(fn: () => unknown): number | null {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as HttpError).status;
  }
}

describe('parseTilePath', () => {
  it('reads z/x/y as the Edge Runtime presents the path', () => {
    expect(parseTilePath('/tiles/8/156/131')).toEqual({ z: 8, x: 156, y: 131 });
    expect(parseTilePath('/tiles/0/0/0')).toEqual({ z: 0, x: 0, y: 0 });
    expect(parseTilePath('/tiles/14/9997/8423/')).toEqual({ z: 14, x: 9997, y: 8423 });
  });

  it('accepts an extension and a /functions/v1 prefix', () => {
    expect(parseTilePath('/tiles/5/19/16.mvt')).toEqual({ z: 5, x: 19, y: 16 });
    expect(parseTilePath('/tiles/5/19/16.pbf')).toEqual({ z: 5, x: 19, y: 16 });
    expect(parseTilePath('/functions/v1/tiles/5/19/16')).toEqual({ z: 5, x: 19, y: 16 });
  });

  it('returns null for anything that is not a tile path', () => {
    for (const p of [
      '/tiles',
      '/tiles/5/19',
      '/tiles/a/b/c',
      '/tiles/5/19/16/7',
      '/tiles/5/-1/3',
      '/tiles/5/1.5/3',
      '/other/5/19/16',
      '/tiles/5/19/16.png',
    ])
      expect(parseTilePath(p), p).toBeNull();
  });

  it('refuses coordinates outside the zoom level', () => {
    expect(status(() => parseTilePath('/tiles/8/256/0'))).toBe(422);
    expect(status(() => parseTilePath('/tiles/8/0/256'))).toBe(422);
    expect(status(() => parseTilePath('/tiles/0/1/0'))).toBe(422);
    expect(status(() => parseTilePath('/tiles/23/0/0'))).toBe(422);
    expect(status(() => parseTilePath('/tiles/99/0/0'))).toBe(422);
    expect(parseTilePath('/tiles/8/255/255')).toEqual({ z: 8, x: 255, y: 255 });
    expect(parseTilePath('/tiles/22/4194303/4194303')).toEqual({ z: 22, x: 4194303, y: 4194303 });
  });
});

describe('parseTileFilters', () => {
  const q = (filters: unknown, key = 'f'): URLSearchParams =>
    new URLSearchParams({ [key]: JSON.stringify(filters) });

  it('no filter → {}', () => {
    expect(parseTileFilters(new URLSearchParams())).toEqual({});
    expect(parseTileFilters(new URLSearchParams({ f: '' }))).toEqual({});
    expect(parseTileFilters(new URLSearchParams({ e: 'epoch-only' }))).toEqual({});
  });

  it('keeps the documented keys in a fixed order and drops the rest', () => {
    const filters = parseTileFilters(
      q({
        status: ['active', 'maintenance'],
        type: 'mosque',
        layers: ['clusters', 'clusters'],
        admin_area_id: 'x',
        q: 'search',
        country_id: 'e2a6484f-39a5-3135-816a-03ad934d99fd',
      }),
    );
    expect(filters).toEqual({
      country_id: 'e2a6484f-39a5-3135-816a-03ad934d99fd',
      type: 'mosque',
      status: ['active', 'maintenance'],
      layers: ['clusters'],
    });
    expect(Object.keys(filters)).toEqual(['country_id', 'type', 'status', 'layers']);
  });

  it('accepts p_filters as an alias', () => {
    expect(parseTileFilters(q({ type: 'school' }, 'p_filters'))).toEqual({ type: 'school' });
  });

  it('refuses malformed filters with 422', () => {
    const bad = [
      new URLSearchParams({ f: '{not json' }),
      new URLSearchParams({ f: '[1,2]' }),
      q({ type: 5 }),
      q({ type: [] }),
      q({ type: ["x'; drop table projects;--"] }),
      q({ layers: ['clusters', 'everything'] }),
      q({ layers: 'clusters' }),
      new URLSearchParams({ f: JSON.stringify({ type: 'x'.repeat(3000) }) }),
    ];
    for (const params of bad)
      expect(
        status(() => parseTileFilters(params)),
        params.toString(),
      ).toBe(422);
  });
});

describe('cache policy helpers', () => {
  it('private caching only; short for live zooms', () => {
    expect(tileCacheControl(5)).toBe('private, max-age=300, stale-while-revalidate=600');
    expect(tileCacheControl(13)).toBe('private, max-age=300, stale-while-revalidate=600');
    expect(tileCacheControl(14)).toBe('private, max-age=30');
    expect(tileCacheControl(5)).not.toContain('public');
  });

  it('bodyEtag is a strong, content-derived validator', async () => {
    const a = await bodyEtag(new Uint8Array([1, 2, 3]));
    const b = await bodyEtag(new Uint8Array([1, 2, 3]));
    const c = await bodyEtag(new Uint8Array([1, 2, 4]));
    expect(a).toMatch(/^"[0-9a-f]{32}"$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(await bodyEtag(new Uint8Array(0))).toBe('"empty"');
  });

  it('etagMatches implements If-None-Match', () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"x", "abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches('*', '"abc"')).toBe(true);
    expect(etagMatches('"abd"', '"abc"')).toBe(false);
    expect(etagMatches(null, '"abc"')).toBe(false);
  });
});

describe('tiles handler', () => {
  const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();
  let userSeq = 0;
  let auth = '';

  beforeEach(() => {
    vi.stubEnv('SUPABASE_URL', 'http://api.test');
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    // a fresh user per test keeps the per-user rate limiter out of the way
    auth = `Bearer ${userToken(`00000000-0000-4000-8000-${String(++userSeq).padStart(12, '0')}`)}`;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const get = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
    handler(
      new Request(`http://fn.test${path}`, {
        headers: { authorization: auth, 'x-device-id': 'dev-1', ...headers },
      }),
    );

  const tile = (bytes: number): Response =>
    new Response(new Uint8Array(bytes).fill(7), { status: 200, headers: { 'content-type': MVT } });

  it('calls tile_projects with the caller token and the MVT media type', async () => {
    fetchMock.mockResolvedValueOnce(tile(100));
    const res = await get('/tiles/8/156/131?f=%7B%22type%22%3A%22mosque%22%7D&e=epoch1');
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'http://api.test/rest/v1/rpc/tile_projects?z=8&x=156&y=131&p_filters=%7B%22type%22%3A%22mosque%22%7D',
    );
    const sent = new Headers(init!.headers);
    expect(init!.method).toBe('GET');
    expect(sent.get('accept')).toBe(MVT);
    expect(sent.get('authorization')).toBe(auth);
    expect(sent.get('x-device-id')).toBe('dev-1');
    expect(sent.get('apikey')).toBe('anon-key');
  });

  it('answers 200 with the contract headers', async () => {
    fetchMock.mockResolvedValueOnce(tile(100));
    const res = await get('/tiles/8/156/131');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(MVT);
    expect(res.headers.get('cache-control')).toBe(
      'private, max-age=300, stale-while-revalidate=600',
    );
    expect(res.headers.get('vary')).toContain('Authorization');
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
    expect(res.headers.get('server-timing')).toMatch(/db;dur=/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(100).fill(7));
  });

  it('answers 204 for an empty tile, with the same cache headers', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 200, headers: { 'content-type': MVT } }),
    );
    const res = await get('/tiles/14/9997/8423');
    expect(res.status).toBe(204);
    expect(res.headers.get('cache-control')).toBe('private, max-age=30');
    expect(res.headers.get('etag')).toBe('"empty"');
    expect(await res.text()).toBe('');
  });

  it('answers 304 to a matching If-None-Match', async () => {
    fetchMock.mockResolvedValue(tile(64));
    const first = await get('/tiles/8/156/131');
    const etag = first.headers.get('etag')!;
    fetchMock.mockResolvedValue(tile(64));
    const second = await get('/tiles/8/156/131', { 'if-none-match': etag });
    expect(second.status).toBe(304);
    expect(second.headers.get('etag')).toBe(etag);
    expect(second.headers.get('cache-control')).toContain('private');
  });

  it('gzips larger tiles for clients that accept it', async () => {
    fetchMock.mockResolvedValueOnce(tile(5000));
    const res = await get('/tiles/8/156/131', { 'accept-encoding': 'gzip, deflate, br' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('etag')).toMatch(/^W\/"[0-9a-f]{32}"$/);
    const packed = new Uint8Array(await res.arrayBuffer());
    expect(packed.byteLength).toBeLessThan(500);
    const plain = await new Response(
      new Response(packed).body!.pipeThrough(
        new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
      ),
    ).arrayBuffer();
    expect(new Uint8Array(plain)).toEqual(new Uint8Array(5000).fill(7));
  });

  it('passes PostgREST errors through, uncached', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ code: 'PT422', message: 'invalid_tile', details: null, hint: null }),
        {
          status: 422,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        },
      ),
    );
    const res = await get('/tiles/8/156/131');
    expect(res.status).toBe(422);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ code: 'PT422', message: 'invalid_tile' });
  });

  it('validates before calling the database', async () => {
    expect((await get('/tiles/8/999/0')).status).toBe(422);
    expect((await get('/tiles/8/1/1?f=nope')).status).toBe(422);
    expect((await get('/tiles/nothing')).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a signed-in user and GET', async () => {
    const anonymous = await handler(new Request('http://fn.test/tiles/8/156/131'));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('cache-control')).toBe('no-store');
    const post = await handler(
      new Request('http://fn.test/tiles/8/156/131', {
        method: 'POST',
        headers: { authorization: auth },
      }),
    );
    expect(post.status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries once when the gateway could not reach PostgREST', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"code":"GATEWAY_UPSTREAM"}', { status: 502 }));
    fetchMock.mockResolvedValueOnce(tile(10));
    const res = await get('/tiles/8/156/131');
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

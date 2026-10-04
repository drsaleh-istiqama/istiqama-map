import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowedOrigin, corsHeaders, parseOrigins, preflight } from './cors.ts';
import {
  HttpError,
  Timing,
  createHandler,
  errors,
  fromDbError,
  fromStorageError,
  isUuid,
  json,
  readBytes,
  readJson,
  statusForDbError,
  toHttpError,
  unwrap,
} from './http.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('database error mapping', () => {
  it('maps project SQLSTATEs PTxxx to HTTP xxx, like PostgREST does', () => {
    expect(statusForDbError({ code: 'PT401' })).toBe(401);
    expect(statusForDbError({ code: 'PT403' })).toBe(403);
    expect(statusForDbError({ code: 'PT404' })).toBe(404);
    expect(statusForDbError({ code: 'PT409' })).toBe(409);
    expect(statusForDbError({ code: 'PT422' })).toBe(422);
    expect(statusForDbError({ code: 'PT429' })).toBe(429);
  });

  it('maps well-known PostgreSQL / PostgREST codes', () => {
    expect(statusForDbError({ code: '42501' })).toBe(403);
    expect(statusForDbError({ code: '23505' })).toBe(409);
    expect(statusForDbError({ code: '22P02' })).toBe(422);
    expect(statusForDbError({ code: '57014' })).toBe(504);
    expect(statusForDbError({ code: '40001' })).toBe(503);
    expect(statusForDbError({ code: 'PGRST301' })).toBe(401);
    expect(statusForDbError({ code: 'PGRST202' })).toBe(404);
  });

  it('falls back to the HTTP status of the response, else 500', () => {
    expect(statusForDbError({ code: 'XX000' }, 400)).toBe(400);
    expect(statusForDbError({ code: undefined }, 502)).toBe(502);
    expect(statusForDbError({}, 200)).toBe(500);
    expect(statusForDbError({ code: 'PT999' }, 0)).toBe(500);
  });

  it('fromDbError keeps code, message, details and hint — the shape the web app expects', () => {
    const e = fromDbError({
      code: 'PT403',
      message: 'forbidden',
      details: 'Only hq_admin may do this.',
      hint: null,
    });
    expect(e.status).toBe(403);
    expect(e.body()).toEqual({
      code: 'PT403',
      message: 'forbidden',
      details: 'Only hq_admin may do this.',
      hint: null,
    });
  });

  it('adds Retry-After from the rate-limit hint', () => {
    const e = fromDbError({ code: 'PT429', message: 'rate_limited', hint: 'Retry in 17 seconds.' });
    expect(e.status).toBe(429);
    expect(e.headers['retry-after']).toBe('17');
    expect(fromDbError({ code: 'PT429', message: 'rate_limited' }).headers['retry-after']).toBe(
      '60',
    );
  });

  it('unwrap returns data or throws the mapped error', () => {
    expect(unwrap({ data: { a: 1 }, error: null })).toEqual({ a: 1 });
    expect(() =>
      unwrap({ data: null, error: { code: 'PT404', message: 'user_not_found' }, status: 404 }),
    ).toThrowError(HttpError);
    try {
      unwrap({ data: null, error: { message: 'fetch failed' }, status: 0 });
    } catch (e) {
      expect((e as HttpError).status).toBe(500);
      expect((e as HttpError).body().message).toBe('fetch failed');
    }
  });

  it('storage errors carry the semantic status in statusCode', () => {
    expect(
      fromStorageError({ message: 'Object not found', statusCode: '404', status: 400 }).status,
    ).toBe(404);
    expect(
      fromStorageError({ message: 'new row violates row-level security policy', statusCode: '403' })
        .status,
    ).toBe(403);
    expect(fromStorageError({ message: 'boom' }).status).toBe(500);
  });

  it('toHttpError hides nothing and never leaks a stack', () => {
    const e = toHttpError(new Error('kaboom'));
    expect(e.status).toBe(500);
    expect(e.body()).toEqual({
      code: 'PT500',
      message: 'internal_error',
      details: 'kaboom',
      hint: null,
    });
    expect(toHttpError(errors.notFound())).toMatchObject({ status: 404 });
  });
});

describe('request helpers', () => {
  it('json() sets the content type and no-store', async () => {
    const res = json({ ok: true, نص: 'عربي' }, 201);
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true, نص: 'عربي' });
  });

  it('readBytes enforces the limit with and without Content-Length', async () => {
    const big = new Uint8Array(2048);
    const declared = new Request('http://x/', {
      method: 'POST',
      body: big,
      headers: { 'content-length': '2048' },
    });
    await expect(readBytes(declared, 1024)).rejects.toMatchObject({ status: 413 });
    const streamed = new Request('http://x/', {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(big.subarray(0, 800));
          c.enqueue(big.subarray(0, 800));
          c.close();
        },
      }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    await expect(readBytes(streamed, 1024)).rejects.toMatchObject({ status: 413 });
    const ok = new Request('http://x/', { method: 'POST', body: big.subarray(0, 100) });
    expect((await readBytes(ok, 1024)).byteLength).toBe(100);
  });

  it('readJson: empty body is {}, invalid JSON is a 400', async () => {
    expect(await readJson(new Request('http://x/', { method: 'POST' }), 100)).toEqual({});
    await expect(
      readJson(new Request('http://x/', { method: 'POST', body: '{nope' }), 100),
    ).rejects.toMatchObject({
      status: 400,
      message: 'invalid_json',
    });
  });

  it('isUuid', () => {
    expect(isUuid('01a1027f-fc21-7a83-8e7f-64628ffed1be')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(42)).toBe(false);
  });

  it('Timing produces a Server-Timing header value', async () => {
    const t = new Timing();
    await t.measure('db', async () => 1);
    expect(t.header()).toMatch(/^db;dur=\d+\.\d, total;dur=\d+\.\d$/);
  });
});

describe('CORS', () => {
  it('parses APP_ORIGINS and defaults to the local development origins', () => {
    expect(parseOrigins('https://map.example.org, https://staging.example.org/')).toEqual([
      'https://map.example.org',
      'https://staging.example.org',
    ]);
    expect(parseOrigins(undefined)).toContain('http://localhost:5173');
    expect(parseOrigins('')).toEqual([]);
  });

  it('echoes only allowed origins', () => {
    const allowed = ['https://map.example.org'];
    expect(allowedOrigin('https://map.example.org', allowed)).toBe('https://map.example.org');
    expect(allowedOrigin('https://evil.example', allowed)).toBeNull();
    expect(allowedOrigin(null, allowed)).toBeNull();
    expect(allowedOrigin('https://anything.example', ['*'])).toBe('*');
  });

  it('corsHeaders / preflight', () => {
    vi.stubEnv('APP_ORIGINS', 'https://map.example.org');
    const good = new Request('http://x/fn', {
      method: 'OPTIONS',
      headers: { origin: 'https://map.example.org' },
    });
    const bad = new Request('http://x/fn', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    });
    expect(corsHeaders(good).get('access-control-allow-origin')).toBe('https://map.example.org');
    expect(corsHeaders(good).get('vary')).toBe('Origin');
    expect(corsHeaders(bad).has('access-control-allow-origin')).toBe(false);
    const pre = preflight(good, ['GET', 'POST']);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    expect(pre.headers.get('access-control-allow-headers')).toContain('x-device-id');
    expect(preflight(bad, ['POST']).headers.has('access-control-allow-methods')).toBe(false);
  });
});

describe('createHandler', () => {
  it('answers preflights, refuses other methods, maps thrown errors and adds CORS + Server-Timing', async () => {
    vi.stubEnv('APP_ORIGINS', 'https://map.example.org');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = createHandler('demo', ['POST'], async (req) => {
      const body = (await req.json()) as { mode: string };
      if (body.mode === 'forbidden') throw fromDbError({ code: 'PT403', message: 'forbidden' });
      if (body.mode === 'crash') throw new Error('unexpected');
      return json({ ok: true }, 200, { vary: 'Authorization' });
    });
    const call = (method: string, mode?: string): Promise<Response> =>
      handler(
        new Request('http://x/demo', {
          method,
          headers: { origin: 'https://map.example.org', 'content-type': 'application/json' },
          body: mode ? JSON.stringify({ mode }) : undefined,
        }),
      );

    const pre = await call('OPTIONS');
    expect(pre.status).toBe(204);

    const wrong = await call('GET');
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('POST, OPTIONS');
    expect(await wrong.json()).toMatchObject({ code: 'PT405', message: 'method_not_allowed' });

    const ok = await call('POST', 'ok');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://map.example.org');
    expect(ok.headers.get('vary')).toBe('Authorization, Origin');
    expect(ok.headers.get('server-timing')).toMatch(/total;dur=/);

    const forbidden = await call('POST', 'forbidden');
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      code: 'PT403',
      message: 'forbidden',
      details: null,
      hint: null,
    });
    expect(forbidden.headers.get('access-control-allow-origin')).toBe('https://map.example.org');

    const crash = await call('POST', 'crash');
    expect(crash.status).toBe(500);
    expect(await crash.json()).toMatchObject({ code: 'PT500', message: 'internal_error' });
  });
});

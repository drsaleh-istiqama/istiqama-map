import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler as syncPull } from '../sync_pull/index.ts';
import { handler as syncPush } from '../sync_push/index.ts';
import { createRpcProxy } from './rpc-proxy.ts';

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function userToken(sub: string): string {
  return `${b64url({ alg: 'HS256' })}.${b64url({ sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();
let userSeq = 0;
let auth = '';

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'http://api.test/');
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  auth = `Bearer ${userToken(`00000000-0000-4000-9000-${String(++userSeq).padStart(12, '0')}`)}`;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function post(
  handler: (r: Request) => Promise<Response>,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handler(
    new Request('http://fn.test/sync', {
      method: 'POST',
      headers: {
        authorization: auth,
        'content-type': 'application/json',
        'x-device-id': 'device-1',
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

const okJson = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

describe('sync_push wrapper', () => {
  it('forwards the RPC arguments untouched, with the caller credentials and device id', async () => {
    const result = { results: [{ op_id: 'a', status: 'applied', version: 1 }], server_time: 'now' };
    fetchMock.mockResolvedValueOnce(okJson(result));
    const raw = JSON.stringify({
      p_ops: [{ op_id: 'a', table: 'projects', name_ar: 'مسجد النور' }],
      p_device_id: 'device-1',
    });
    const res = await post(syncPush, raw, { apikey: 'client-anon-key' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api.test/rest/v1/rpc/sync_push');
    expect(init!.method).toBe('POST');
    expect(init!.body).toBe(raw); // byte-for-byte: no re-serialisation
    const sent = new Headers(init!.headers);
    expect(sent.get('authorization')).toBe(auth);
    expect(sent.get('x-device-id')).toBe('device-1');
    expect(sent.get('apikey')).toBe('client-anon-key');
    expect(sent.get('content-type')).toBe('application/json');
  });

  it('accepts the aliases ops / device_id and falls back to the x-device-id header', async () => {
    fetchMock.mockResolvedValue(okJson({ results: [] }));
    await post(syncPush, { ops: [{ op_id: 'b' }], device_id: 'device-9' });
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      p_ops: [{ op_id: 'b' }],
      p_device_id: 'device-9',
    });
    await post(syncPush, { p_ops: [] });
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({
      p_ops: [],
      p_device_id: 'device-1',
    });
  });

  it('passes database errors through with their status and body', async () => {
    const error = { code: 'PT403', message: 'session_revoked', details: null, hint: null };
    fetchMock.mockResolvedValueOnce(okJson(error, 403));
    const res = await post(syncPush, { p_ops: [], p_device_id: 'device-1' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(error);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('adds Retry-After to a database 429', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson(
        { code: 'PT429', message: 'rate_limited', details: '…', hint: 'Retry in 23 seconds.' },
        429,
      ),
    );
    const res = await post(syncPush, { p_ops: [], p_device_id: 'device-1' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('23');
    expect(await res.json()).toMatchObject({ code: 'PT429', message: 'rate_limited' });
  });

  it('adds Server-Timing and rate-limit headers', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ results: [] }));
    const res = await post(syncPush, { p_ops: [], p_device_id: 'device-1' });
    expect(res.headers.get('server-timing')).toMatch(/^rpc;dur=\d+\.\d, total;dur=\d+\.\d$/);
    expect(res.headers.get('x-ratelimit-limit')).toBe('120');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('119');
  });

  it('refuses bad requests before touching the database', async () => {
    expect((await post(syncPush, '{broken')).status).toBe(400);
    expect((await post(syncPush, '[1,2,3]')).status).toBe(422);
    const anonymous = await syncPush(
      new Request('http://fn.test/sync_push', { method: 'POST', body: '{}' }),
    );
    expect(anonymous.status).toBe(401);
    const get = await syncPush(
      new Request('http://fn.test/sync_push', { headers: { authorization: auth } }),
    );
    expect(get.status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an unreachable database as 502 after one retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const res = await post(syncPush, { p_ops: [], p_device_id: 'device-1' });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'PT502', message: 'upstream_unavailable' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('sync_pull wrapper', () => {
  it('maps cursor / limit and passes the page through', async () => {
    const page = { changes: [], cursor: { lo: 1 }, done: true, reset: false };
    fetchMock.mockResolvedValue(okJson(page));
    const res = await post(syncPull, { cursor: { lo: 1 }, limit: 200 });
    expect(await res.json()).toEqual(page);
    expect(fetchMock.mock.calls[0]![0]).toBe('http://api.test/rest/v1/rpc/sync_pull');
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      p_cursor: { lo: 1 },
      p_limit: 200,
    });
    await post(syncPull, {});
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({ p_cursor: null });
    await post(syncPull, { p_cursor: null, p_limit: 500 });
    expect(JSON.parse(fetchMock.mock.calls[2]![1]!.body as string)).toEqual({
      p_cursor: null,
      p_limit: 500,
    });
  });
});

describe('rate limiting of a wrapper', () => {
  it('answers 429 in the common error shape once the per-user budget is used', async () => {
    const limited = createRpcProxy({
      name: `limited-${Math.random()}`,
      rpc: 'x',
      perMinute: 2,
      maxBodyBytes: 1000,
    });
    fetchMock.mockImplementation(async () => okJson({ ok: true }));
    expect((await post(limited, {})).status).toBe(200);
    expect((await post(limited, {})).status).toBe(200);
    const third = await post(limited, {});
    expect(third.status).toBe(429);
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await third.json()).toMatchObject({ code: 'PT429', message: 'rate_limited' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses oversized bodies', async () => {
    const small = createRpcProxy({
      name: `small-${Math.random()}`,
      rpc: 'x',
      perMinute: 10,
      maxBodyBytes: 100,
    });
    const res = await post(small, { blob: 'x'.repeat(500) });
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

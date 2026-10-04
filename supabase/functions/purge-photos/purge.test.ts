import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeApi, jsonResponse, pgError, userToken } from '../_shared/fake-api.ts';
import { handler } from './index.ts';

const SERVICE_KEY = 'service-role-key-for-tests';

let api: FakeApi;

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'http://api.test');
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
  api = new FakeApi();
  vi.stubGlobal('fetch', api.fetch);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function run(body: unknown = {}, bearer: string | null = SERVICE_KEY): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
  return handler(
    new Request('http://fn.test/purge-photos', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
}

const PHOTO_A = {
  id: '0198a8b0-0000-7000-8000-00000000000a',
  project_id: '0198a8b0-0000-7000-8000-0000000000f1',
  bucket: 'photos',
  storage_path_full: 'p1/a.webp',
  storage_path_thumb: 'p1/a_thumb.webp',
  deleted_at: '2026-01-01T00:00:00Z',
};
const PHOTO_B = {
  ...PHOTO_A,
  id: '0198a8b0-0000-7000-8000-00000000000b',
  storage_path_full: 'p1/b.webp',
  storage_path_thumb: null,
};

/** No expired export files (the second phase of the job). */
function noExpiredExports(): void {
  api.on('GET', '/rest/v1/export_jobs', jsonResponse([]));
}

describe('purge-photos', () => {
  it('refuses everybody but the service role, before touching anything', async () => {
    const asUser = await run({}, userToken('0198a8b0-0000-7000-8000-0000000000c1'));
    expect(asUser.status).toBe(403);
    expect(((await asUser.json()) as { code: string }).code).toBe('PT403');
    // a forged token that only CLAIMS the service role is still refused
    const forged = await run({}, userToken('x', { role: 'service_role' }));
    expect(forged.status).toBe(403);
    expect((await run({}, 'anon-key')).status).toBe(403);
    expect((await run({}, null)).status).toBe(401);
    expect(api.calls).toHaveLength(0);
  });

  it('removes both objects of every photo, then marks the photos, until nothing is left', async () => {
    api
      .on('POST', '/rest/v1/rpc/photos_to_purge', jsonResponse([]))
      .on('POST', '/rest/v1/rpc/photos_to_purge', jsonResponse([PHOTO_A, PHOTO_B]), 1)
      .on('DELETE', '/storage/v1/object/photos', (req) =>
        jsonResponse(req.json<{ prefixes: string[] }>().prefixes.map((name) => ({ name }))),
      )
      .on('POST', '/rest/v1/rpc/mark_photos_purged', (req) =>
        jsonResponse(req.json<{ p_ids: string[] }>().p_ids.length),
      );
    noExpiredExports();

    const res = await run({ limit: 50 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      photos: { marked: 2, objects_removed: 3, batches: 1, more: false },
      exports: { files_removed: 0, jobs_cleared: 0 },
    });

    expect(api.rpcCalls('photos_to_purge').map((c) => c.json())).toEqual([
      { p_limit: 50 },
      { p_limit: 50 },
    ]);
    expect(api.callsTo('DELETE', '/storage/v1/object/photos')[0]!.json()).toEqual({
      prefixes: ['p1/a.webp', 'p1/a_thumb.webp', 'p1/b.webp'],
    });
    expect(api.rpcCalls('mark_photos_purged')[0]!.json()).toEqual({
      p_ids: [PHOTO_A.id, PHOTO_B.id],
    });
    // objects first, then the rows: a crash in between leaves the rows eligible (idempotent)
    const order = api.calls.map((c) => c.path);
    expect(order.indexOf('/storage/v1/object/photos')).toBeLessThan(
      order.indexOf('/rest/v1/rpc/mark_photos_purged'),
    );
    expect(api.calls.every((c) => c.bearer() === SERVICE_KEY)).toBe(true);
  });

  it('does not mark photos whose objects could not be removed', async () => {
    api
      .on('POST', '/rest/v1/rpc/photos_to_purge', jsonResponse([PHOTO_A]))
      .on(
        'DELETE',
        '/storage/v1/object/photos',
        jsonResponse({ statusCode: '500', error: 'internal', message: 'disk on fire' }, 500),
      );
    noExpiredExports();
    const res = await run();
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(api.rpcCalls('mark_photos_purged')).toHaveLength(0);
  });

  it('stops when marking makes no progress (the same batch comes back) and reports "more"', async () => {
    api
      .on('POST', '/rest/v1/rpc/photos_to_purge', jsonResponse([PHOTO_A]))
      .on('DELETE', '/storage/v1/object/photos', jsonResponse([]))
      .on('POST', '/rest/v1/rpc/mark_photos_purged', jsonResponse(0));
    noExpiredExports();
    const res = await run();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      photos: { marked: 0, batches: 1, more: true },
    });
    expect(api.rpcCalls('photos_to_purge')).toHaveLength(2);
  });

  it('honours max_batches', async () => {
    let n = 0;
    api
      .on('POST', '/rest/v1/rpc/photos_to_purge', () =>
        jsonResponse([
          { ...PHOTO_A, id: `0198a8b0-0000-7000-8000-${String(++n).padStart(12, '0')}` },
        ]),
      )
      .on('DELETE', '/storage/v1/object/photos', jsonResponse([]))
      .on('POST', '/rest/v1/rpc/mark_photos_purged', jsonResponse(1));
    noExpiredExports();
    const res = await run({ max_batches: 3 });
    expect(await res.json()).toMatchObject({ photos: { marked: 3, batches: 3, more: true } });
  });

  it('deletes the files of expired export jobs and clears their storage path', async () => {
    api.on('POST', '/rest/v1/rpc/photos_to_purge', jsonResponse([]));
    api
      .on('GET', '/rest/v1/export_jobs', (req) => {
        expect(req.url.searchParams.get('state')).toBe('eq.expired');
        expect(req.url.searchParams.get('storage_path')).toBe('not.is.null');
        return jsonResponse([
          { id: 'job-1', storage_path: 'u1/job-1.csv' },
          { id: 'job-2', storage_path: 'u2/job-2.xlsx' },
        ]);
      })
      .on('DELETE', '/storage/v1/object/exports', jsonResponse([{ name: 'u1/job-1.csv' }]))
      .on('PATCH', '/rest/v1/export_jobs', (req) => {
        expect(req.json()).toEqual({ storage_path: null });
        expect(req.url.searchParams.get('state')).toBe('eq.expired');
        return jsonResponse([{ id: 'job-1' }, { id: 'job-2' }]);
      });
    const res = await run();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ exports: { files_removed: 1, jobs_cleared: 2 } });
    expect(api.callsTo('DELETE', '/storage/v1/object/exports')[0]!.json()).toEqual({
      prefixes: ['u1/job-1.csv', 'u2/job-2.xlsx'],
    });
  });

  it('a database error of the photo query is reported, nothing is removed', async () => {
    api.on('POST', '/rest/v1/rpc/photos_to_purge', pgError(403, 'PT403', 'forbidden'));
    const res = await run();
    expect(res.status).toBe(403);
    expect(api.callsTo('DELETE', /^\/storage\//)).toHaveLength(0);
  });
});

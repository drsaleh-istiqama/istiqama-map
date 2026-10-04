import { describe, expect, it, vi } from 'vitest';
import { SyncError } from './errors';
import {
  type RpcClient,
  type RpcResponse,
  createTransport,
  mapRpcError,
  supabaseRpcClient,
} from './transport';
import type { PushOp } from './types';

function clientReturning(
  ...responses: Array<RpcResponse | Error>
): RpcClient & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    rpc(fn, args) {
      calls.push([fn, args]);
      const next = responses.shift();
      if (!next) throw new Error('no scripted response left');
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
}

const op = (n: number): PushOp => ({
  op_id: `op-${n}`,
  table: 'projects',
  id: `row-${n}`,
  kind: 'upsert',
  base_version: 0,
  fields: { name_ar: 'x' },
  client_ts: '2026-10-03T10:00:00Z',
});

const pgError = (
  status: number,
  code: string,
  message: string,
  hint: string | null = null,
): RpcResponse => ({
  data: null,
  status,
  error: { code, message, details: null, hint },
});

async function kindOf(promise: Promise<unknown>): Promise<SyncError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(SyncError);
    return e as SyncError;
  }
  throw new Error('expected a rejection');
}

describe('transport.push', () => {
  it('sends p_ops and p_device_id and returns the results in order', async () => {
    const client = clientReturning({
      status: 200,
      error: null,
      data: {
        results: [
          { op_id: 'op-1', status: 'applied', version: 1 },
          { op_id: 'op-2', status: 'rejected', error: { code: 'out_of_scope' } },
        ],
        server_time: 'now',
      },
    });
    const results = await createTransport(client).push([op(1), op(2)], 'device-a');
    expect(client.calls).toEqual([
      ['sync_push', { p_ops: [op(1), op(2)], p_device_id: 'device-a' }],
    ]);
    expect(results.map((r) => r.status)).toEqual(['applied', 'rejected']);
  });

  it('does not call the server for an empty batch', async () => {
    const client = clientReturning();
    expect(await createTransport(client).push([], 'device-a')).toEqual([]);
    expect(client.calls).toHaveLength(0);
  });

  it.each([
    ['a result is missing', { results: [{ op_id: 'op-1', status: 'applied' }] }],
    [
      'the order differs',
      {
        results: [
          { op_id: 'op-2', status: 'applied' },
          { op_id: 'op-1', status: 'applied' },
        ],
      },
    ],
    [
      'a status is unknown',
      {
        results: [
          { op_id: 'op-1', status: 'weird' },
          { op_id: 'op-2', status: 'applied' },
        ],
      },
    ],
    ['the body is not an object', 'ok'],
  ])('treats a malformed answer as retryable (%s)', async (_name, data) => {
    const err = await kindOf(
      createTransport(clientReturning({ status: 200, error: null, data })).push(
        [op(1), op(2)],
        'd',
      ),
    );
    expect(err.kind).toBe('bad_response');
    expect(err.retryable).toBe(true);
  });
});

describe('transport error mapping', () => {
  const cases: Array<[string, RpcResponse, SyncError['kind'], boolean]> = [
    ['PT401', pgError(401, 'PT401', 'not_authenticated'), 'unauthenticated', false],
    ['expired JWT (PostgREST)', pgError(401, 'PGRST301', 'JWT expired'), 'unauthenticated', false],
    ['PT403 session_revoked', pgError(403, 'PT403', 'session_revoked'), 'session_revoked', false],
    ['PT403 other', pgError(403, 'PT403', 'out_of_scope'), 'forbidden', false],
    ['PT404', pgError(404, 'PT404', 'conflict_not_found'), 'not_found', false],
    ['PT409', pgError(409, 'PT409', 'conflict_already_resolved'), 'conflict', false],
    ['PT422', pgError(422, 'PT422', 'too_many_ops'), 'invalid', false],
    ['PT429', pgError(429, 'PT429', 'rate_limited', 'Retry in 17 seconds.'), 'rate_limited', true],
    ['serialization failure', pgError(500, '40001', 'could not serialize access'), 'server', true],
    ['deadlock', pgError(500, '40P01', 'deadlock detected'), 'server', true],
    ['lock timeout', pgError(500, '55P03', 'lock not available'), 'server', true],
    ['statement timeout', pgError(500, '57014', 'canceling statement'), 'server', true],
    ['gateway 502', pgError(502, 'GATEWAY_UPSTREAM', 'upstream'), 'server', true],
    [
      'network failure',
      { data: null, status: 0, error: { message: 'TypeError: fetch failed' } },
      'network',
      true,
    ],
    ['plain 400', pgError(400, 'P0001', 'boom'), 'invalid', false],
  ];

  it.each(cases)('%s', async (_name, response, kind, retryable) => {
    const err = await kindOf(createTransport(clientReturning(response)).rpc('anything'));
    expect(err.kind).toBe(kind);
    expect(err.retryable).toBe(retryable);
    expect(err.status).toBe(response.status);
  });

  it('reads the wait from the rate limiter hint', () => {
    const err = mapRpcError(
      'sync_push',
      pgError(429, 'PT429', 'rate_limited', 'Retry in 17 seconds.'),
      false,
    );
    expect(err.retryAfterMs).toBe(17_000);
  });

  it('maps a rejected fetch to a network error', async () => {
    const err = await kindOf(
      createTransport(clientReturning(new TypeError('fetch failed'))).pull(null, 500),
    );
    expect(err.kind).toBe('network');
  });

  it('times out a hanging request and reports it as retryable', async () => {
    const hanging: RpcClient = {
      rpc: (_fn, _args, { signal }) =>
        new Promise<RpcResponse>((resolve) => {
          signal.addEventListener('abort', () =>
            resolve({
              data: null,
              status: 0,
              error: {
                message: 'AbortError: This operation was aborted',
                hint: 'Request was aborted',
              },
            }),
          );
        }),
    };
    const err = await kindOf(createTransport(hanging, { pullTimeoutMs: 20 }).pull(null, 500));
    expect(err.kind).toBe('timeout');
    expect(err.retryable).toBe(true);
  });
});

describe('transport.pull', () => {
  it('passes the cursor back unchanged and validates the page', async () => {
    const cursor = { lo: 1, hi: 9, e: 'x' };
    const page = {
      changes: [{ table: 'projects', rows: [{ id: 'a' }] }],
      cursor,
      done: true,
      reset: false,
    };
    const client = clientReturning(
      { status: 200, error: null, data: page },
      { status: 200, error: null, data: {} },
    );
    const transport = createTransport(client);
    expect(await transport.pull(cursor, 250)).toEqual(page);
    expect(client.calls[0]).toEqual(['sync_pull', { p_cursor: cursor, p_limit: 250 }]);
    expect((await kindOf(transport.pull(null, 500))).kind).toBe('bad_response');
  });
});

describe('supabaseRpcClient', () => {
  it('posts through supabase.rpc and forwards the abort signal', async () => {
    const abortSignal = vi.fn().mockResolvedValue({ data: 1, error: null, status: 200 });
    const rpc = vi.fn().mockReturnValue({ abortSignal });
    const client = supabaseRpcClient({ rpc } as never);
    const signal = new AbortController().signal;
    await client.rpc('my_context', {}, { signal });
    expect(rpc).toHaveBeenCalledWith('my_context', {});
    expect(abortSignal).toHaveBeenCalledWith(signal);
  });
});

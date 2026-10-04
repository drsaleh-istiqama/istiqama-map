/**
 * Transport over supabase-js (PostgREST RPC). The only file of the sync engine that knows
 * about HTTP statuses and PostgREST error bodies; everything above works with `SyncError`.
 *
 * The transport itself never retries: `sync_push` is idempotent by `op_id`, so the caller
 * (push.ts) re-sends the SAME batch; `sync_pull` may be repeated with the same cursor.
 * Generic RPCs are never repeated blindly.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { SyncError, type SyncErrorKind } from './errors';
import type {
  PullPage,
  PushOp,
  PushResult,
  PushStatus,
  Transport,
  TransportCallOptions,
} from './types';

/** What a PostgREST call resolves to in supabase-js (`status` 0 = the request never completed). */
export interface RpcResponse {
  data: unknown;
  error: { message?: string; code?: string; details?: string | null; hint?: string | null } | null;
  status: number;
}

/** Minimal RPC surface the transport needs; trivially faked in tests. */
export interface RpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
    opts: { signal: AbortSignal },
  ): PromiseLike<RpcResponse>;
}

export interface TransportOptions {
  /** Abort a push after this long (the same op ids are sent again later). */
  pushTimeoutMs?: number;
  pullTimeoutMs?: number;
  rpcTimeoutMs?: number;
}

const DEFAULTS: Required<TransportOptions> = {
  pushTimeoutMs: 90_000,
  pullTimeoutMs: 60_000,
  rpcTimeoutMs: 30_000,
};

/** SQLSTATEs that mean "nothing was applied, the same call can be repeated". */
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
  '57014', // query_canceled (statement timeout)
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '08000',
  '08003',
  '08006',
]);

const PUSH_STATUSES: ReadonlySet<string> = new Set<PushStatus>([
  'applied',
  'merged',
  'conflict',
  'rejected',
  'duplicate',
]);

function retryAfterFromHint(hint: string | null | undefined): number | undefined {
  if (!hint) return undefined;
  const m = /(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i.exec(hint);
  if (!m) return undefined;
  const seconds = Number(m[1]);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : undefined;
}

function kindForStatus(status: number): SyncErrorKind {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  if (status >= 400) return 'invalid';
  return 'unknown';
}

/** Map a failed PostgREST response to a typed error (exported for tests). */
export function mapRpcError(fn: string, res: RpcResponse, timedOut: boolean): SyncError {
  const err = res.error ?? {};
  const code = err.code ?? '';
  const message = err.message ?? '';
  const text = `${fn}: ${message || `HTTP ${res.status}`}`;
  const init = { status: res.status, code };

  // The request never produced an HTTP answer.
  if (res.status === 0) {
    if (timedOut) return new SyncError('timeout', `${fn}: timed out`, init);
    if (/abort/i.test(message) || /abort/i.test(err.hint ?? '')) {
      return new SyncError('aborted', `${fn}: aborted`, init);
    }
    return new SyncError('network', text, init);
  }

  // Application errors raised with `errcode = 'PTxxx'` (PostgREST turns xxx into the HTTP status).
  if (code === 'PT401') return new SyncError('unauthenticated', text, init);
  if (code === 'PT403') {
    return new SyncError(
      message === 'session_revoked' ? 'session_revoked' : 'forbidden',
      text,
      init,
    );
  }
  if (code === 'PT404') return new SyncError('not_found', text, init);
  if (code === 'PT409') return new SyncError('conflict', text, init);
  if (code === 'PT422') return new SyncError('invalid', text, init);
  if (code === 'PT429' || res.status === 429) {
    return new SyncError('rate_limited', text, {
      ...init,
      retryAfterMs: retryAfterFromHint(err.hint),
    });
  }
  if (RETRYABLE_SQLSTATES.has(code)) return new SyncError('server', text, init);
  // PostgREST's own JWT errors (expired / invalid token).
  if (/^PGRST30[0-3]$/.test(code) || res.status === 401)
    return new SyncError('unauthenticated', text, init);
  // A revoked session can also surface as a plain 403 with this message.
  if (res.status === 403 && message === 'session_revoked')
    return new SyncError('session_revoked', text, init);
  return new SyncError(kindForStatus(res.status), text, init);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate the answer of `sync_push`: one result per op, same order. */
export function parsePushResults(data: unknown, ops: readonly PushOp[]): PushResult[] {
  const results = isRecord(data) ? data.results : undefined;
  if (!Array.isArray(results) || results.length !== ops.length) {
    throw new SyncError('bad_response', 'sync_push: unexpected response shape');
  }
  return results.map((r, i) => {
    const op = ops[i] as PushOp;
    if (
      !isRecord(r) ||
      r.op_id !== op.op_id ||
      typeof r.status !== 'string' ||
      !PUSH_STATUSES.has(r.status)
    ) {
      throw new SyncError(
        'bad_response',
        `sync_push: result ${i} does not match the operation sent`,
      );
    }
    return r as unknown as PushResult;
  });
}

export function parsePullPage(data: unknown): PullPage {
  if (
    !isRecord(data) ||
    !Array.isArray(data.changes) ||
    typeof data.done !== 'boolean' ||
    !('cursor' in data)
  ) {
    throw new SyncError('bad_response', 'sync_pull: unexpected response shape');
  }
  for (const c of data.changes) {
    if (!isRecord(c) || typeof c.table !== 'string') {
      throw new SyncError('bad_response', 'sync_pull: malformed change set');
    }
  }
  return data as unknown as PullPage;
}

/** Adapter from a real supabase-js client to the minimal `RpcClient`. */
export function supabaseRpcClient(supabase: Pick<SupabaseClient, 'rpc'>): RpcClient {
  return {
    rpc: (fn, args, opts) =>
      // POST (never `get: true`): every sync RPC writes (rate limiter, heartbeat, access log).
      supabase.rpc(fn, args).abortSignal(opts.signal) as unknown as PromiseLike<RpcResponse>,
  };
}

export function createTransport(client: RpcClient, options: TransportOptions = {}): Transport {
  const opt = { ...DEFAULTS, ...options };

  async function call(
    fn: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    external: AbortSignal | undefined,
  ): Promise<unknown> {
    if (external?.aborted) throw new SyncError('aborted', `${fn}: aborted`);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const forward = (): void => controller.abort();
    external?.addEventListener('abort', forward, { once: true });
    let res: RpcResponse;
    try {
      res = await client.rpc(fn, args, { signal: controller.signal });
    } catch (e) {
      // supabase-js resolves with `error`; a rejection means the fetch layer itself threw.
      if (timedOut) throw new SyncError('timeout', `${fn}: timed out`, { cause: e });
      const name = (e as { name?: string } | null)?.name;
      if (name === 'AbortError' || external?.aborted)
        throw new SyncError('aborted', `${fn}: aborted`, { cause: e });
      throw new SyncError('network', `${fn}: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
      });
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', forward);
    }
    if (res.error || res.status === 0 || res.status >= 400) {
      // Cancelled by the caller while on the wire: for a push the outcome is unknown, the
      // same op ids are sent again later.
      if (res.status === 0 && external?.aborted && !timedOut)
        throw new SyncError('aborted', `${fn}: aborted`);
      throw mapRpcError(fn, res, timedOut);
    }
    return res.data;
  }

  return {
    async push(ops, deviceId, options) {
      if (ops.length === 0) return [];
      const args = { p_ops: ops, p_device_id: deviceId };
      const data = await call('sync_push', args, opt.pushTimeoutMs, options?.signal);
      return parsePushResults(data, ops);
    },
    async pull(cursor, limit, options) {
      const args = { p_cursor: cursor ?? null, p_limit: limit };
      const data = await call('sync_pull', args, opt.pullTimeoutMs, options?.signal);
      return parsePullPage(data);
    },
    async rpc<T>(
      fn: string,
      args: Record<string, unknown> = {},
      options?: TransportCallOptions,
    ): Promise<T> {
      return (await call(fn, args, opt.rpcTimeoutMs, options?.signal)) as T;
    },
  };
}

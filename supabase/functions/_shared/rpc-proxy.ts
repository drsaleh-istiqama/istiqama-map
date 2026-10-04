/**
 * Thin, rate-limited wrapper around one RPC (used by `sync_push` and `sync_pull`).
 *
 * The request body is the RPC's own argument object, so the web transport can switch between
 * `POST /rest/v1/rpc/<name>` and `POST /functions/v1/<name>` by configuration only. The
 * caller's `Authorization`, `apikey` and `x-device-id` are forwarded; status code and body of
 * PostgREST are passed through unchanged (same error shape either way).
 */
import { identify } from './auth.ts';
import { callerHeaders, restFetch } from './clients.ts';
import { createHandler, errors, isRecord, readText, type Handler } from './http.ts';
import { enforceRateLimit } from './ratelimit.ts';

export interface RpcProxyOptions {
  /** Function name (also the rate-limit bucket). */
  name: string;
  /** RPC to call. */
  rpc: string;
  /** Calls per minute and user. */
  perMinute: number;
  maxBodyBytes: number;
  /**
   * Maps friendly aliases to the RPC argument names. Returns the argument object to send, or
   * `null` to forward the body exactly as received.
   */
  normalise?: (body: Record<string, unknown>, req: Request) => Record<string, unknown> | null;
}

export function createRpcProxy(opts: RpcProxyOptions): Handler {
  return createHandler(opts.name, ['POST'], async (req, { timing }) => {
    const caller = identify(req);
    const limit = enforceRateLimit(opts.name, caller.userId, opts.perMinute);

    const text = await readText(req, opts.maxBodyBytes);
    let payload = text;
    if (opts.normalise) {
      let parsed: unknown;
      try {
        parsed = text.trim() === '' ? {} : JSON.parse(text);
      } catch {
        throw errors.badRequest('invalid_json', 'The request body is not valid JSON.');
      }
      if (!isRecord(parsed))
        throw errors.validation('invalid_body', 'The request body must be a JSON object.');
      const mapped = opts.normalise(parsed, req);
      if (mapped) payload = JSON.stringify(mapped);
    }

    let upstream: Response;
    try {
      upstream = await timing.measure('rpc', () =>
        restFetch(callerHeaders(req), `rpc/${opts.rpc}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: payload === '' ? '{}' : payload,
        }),
      );
    } catch (e) {
      throw errors.upstream('upstream_unavailable', e instanceof Error ? e.message : String(e));
    }

    const headers = new Headers({
      'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-ratelimit-limit': String(limit.limit),
      'x-ratelimit-remaining': String(limit.remaining),
    });
    if (upstream.status === 429) {
      // PostgREST carries the wait in the hint ("Retry in N seconds."); surface it as a header.
      const body = await upstream.text();
      const seconds = /Retry in (\d+) seconds?/i.exec(body)?.[1];
      headers.set('retry-after', upstream.headers.get('retry-after') ?? seconds ?? '60');
      return new Response(body, { status: 429, headers });
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  });
}

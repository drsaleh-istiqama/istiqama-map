/**
 * Supabase clients for the functions.
 *
 * - `userClient(req)`: acts AS THE CALLER. The caller's `Authorization` and `x-device-id`
 *   headers are forwarded on every PostgREST / Storage request, so RLS, the permission checks
 *   inside the SECURITY DEFINER RPCs, `private.session_ok()` and the device revocation apply
 *   exactly as for a direct call from the browser.
 * - `serviceClient()`: service-role key, bypasses RLS. Use it ONLY where a contract says so
 *   (export upload + `export_finish`, photo purge, Auth admin API).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { anonKey, serviceKey, supabaseUrl } from './env.ts';

const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** The caller's credentials, detached from the Request so that background work can keep them. */
export interface CallerHeaders {
  authorization: string;
  deviceId: string | null;
  apikey: string | null;
}

export function callerHeaders(req: Request): CallerHeaders {
  const device = req.headers.get('x-device-id');
  return {
    authorization: req.headers.get('authorization') ?? '',
    deviceId: device !== null && DEVICE_ID_RE.test(device) ? device : null,
    apikey: req.headers.get('apikey'),
  };
}

const CLIENT_AUTH = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
} as const;

export function userClientFor(caller: CallerHeaders): SupabaseClient {
  const headers: Record<string, string> = { 'x-client-info': 'istiqama-functions' };
  if (caller.authorization) headers.Authorization = caller.authorization;
  if (caller.deviceId) headers['x-device-id'] = caller.deviceId;
  return createClient(supabaseUrl(), anonKey(), { auth: CLIENT_AUTH, global: { headers } });
}

export function userClient(req: Request): SupabaseClient {
  return userClientFor(callerHeaders(req));
}

let cachedService: { key: string; url: string; client: SupabaseClient } | null = null;

export function serviceClient(): SupabaseClient {
  const key = serviceKey();
  const url = supabaseUrl();
  if (!cachedService || cachedService.key !== key || cachedService.url !== url) {
    cachedService = {
      key,
      url,
      client: createClient(url, key, {
        auth: CLIENT_AUTH,
        global: { headers: { 'x-client-info': 'istiqama-functions-service' } },
      }),
    };
  }
  return cachedService.client;
}

/**
 * Raw request to PostgREST with the caller's credentials. Used by the thin wrappers
 * (`sync_push`, `sync_pull`, `tiles`) that must pass status and body through untouched.
 */
export async function restFetch(
  caller: CallerHeaders,
  path: string,
  init: Omit<RequestInit, 'body'> & { body?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (caller.authorization) headers.set('authorization', caller.authorization);
  headers.set('apikey', caller.apikey ?? anonKey());
  if (caller.deviceId) headers.set('x-device-id', caller.deviceId);
  if (!headers.has('x-client-info')) headers.set('x-client-info', 'istiqama-functions');
  const url = `${supabaseUrl()}/rest/v1/${path.replace(/^\/+/, '')}`;
  // One retry when the API gateway could not reach PostgREST (connection reset, restart).
  // Safe for every caller of this helper: tiles are reads, sync_pull pages are repeatable and
  // sync_push is idempotent by op_id.
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, headers });
      if (attempt === 0 && (res.status === 502 || res.status === 503)) {
        await res.body?.cancel().catch(() => undefined);
        await sleep(120);
        continue;
      }
      return res;
    } catch (e) {
      if (attempt > 0) throw e;
      await sleep(120);
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RpcResult<T> {
  data: T | null;
  error: { code?: string; message?: string; details?: string | null; hint?: string | null } | null;
  status?: number;
}

/**
 * Run a supabase-js call again when it failed for a transient reason: gateway / network
 * failure (no SQLSTATE and a 5xx or 0 status), serialization failure, deadlock, lock timeout,
 * or the rate limiter (waits for the announced delay when it is short). Only for calls that
 * are safe to repeat.
 */
export async function withRetry<T>(
  call: () => PromiseLike<RpcResult<T>>,
  opts: { attempts?: number; maxRateLimitWaitMs?: number } = {},
): Promise<RpcResult<T>> {
  const attempts = opts.attempts ?? 3;
  let result = await call();
  for (let attempt = 1; attempt < attempts && result.error; attempt++) {
    const code = result.error.code ?? '';
    const status = result.status ?? 0;
    let waitMs: number | null = null;
    if (code === '40001' || code === '40P01' || code === '55P03') waitMs = 150 * attempt;
    else if (code === 'PT429') {
      const seconds = Number(/(\d+)\s*seconds?/i.exec(result.error.hint ?? '')?.[1] ?? '5');
      const ms = seconds * 1000;
      if (ms <= (opts.maxRateLimitWaitMs ?? 15_000)) waitMs = ms;
    } else if (!/^(PT|PGRST|\d\d)/.test(code) && (status === 0 || status >= 502)) waitMs = 200 * attempt;
    if (waitMs === null) break;
    await sleep(waitMs);
    result = await call();
  }
  return result;
}

/** Headers for a direct call to the Auth admin API / Storage with the service key. */
export function serviceHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = serviceKey();
  return { apikey: key, authorization: `Bearer ${key}`, ...extra };
}

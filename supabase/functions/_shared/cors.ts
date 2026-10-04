/**
 * CORS for the Edge Functions. Neither Supabase nor the local gateway adds CORS headers to
 * function responses, and preflights are forwarded to the function.
 *
 * Allowed origins come from `APP_ORIGINS` (comma separated, e.g.
 * "https://map.example.org,https://staging.map.example.org"). `*` allows every origin (the API
 * is authenticated with bearer tokens, not cookies, so this is safe but not recommended).
 * When the variable is unset only the local development origins are allowed.
 */
import { env } from './env.ts';

const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

const ALLOWED_HEADERS = [
  'authorization',
  'apikey',
  'content-type',
  'accept',
  'x-client-info',
  'x-device-id',
  'x-supabase-api-version',
  'x-region',
  // `import` with the raw file as the body names the file in this header (README, import).
  'x-file-name',
  'if-none-match',
  'prefer',
  'cache-control',
].join(', ');

const EXPOSED_HEADERS = [
  'etag',
  'server-timing',
  'retry-after',
  'content-disposition',
  'content-range',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
].join(', ');

export function parseOrigins(raw: string | undefined): string[] {
  if (raw === undefined) return DEV_ORIGINS;
  return raw
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => o.length > 0);
}

/** The value for `Access-Control-Allow-Origin`, or null when the origin is not allowed. */
export function allowedOrigin(origin: string | null, allowed: string[]): string | null {
  if (!origin) return null;
  if (allowed.includes('*')) return '*';
  const clean = origin.replace(/\/+$/, '');
  return allowed.includes(clean) ? clean : null;
}

export function corsHeaders(req: Request, allowed = parseOrigins(env('APP_ORIGINS'))): Headers {
  const headers = new Headers();
  const origin = allowedOrigin(req.headers.get('origin'), allowed);
  if (origin) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-expose-headers', EXPOSED_HEADERS);
  }
  if (origin !== '*') headers.set('vary', 'Origin');
  return headers;
}

/** Answer for an `OPTIONS` preflight (204). Origins that are not allowed get no CORS headers. */
export function preflight(req: Request, methods: string[]): Response {
  const headers = corsHeaders(req);
  if (headers.has('access-control-allow-origin')) {
    headers.set('access-control-allow-methods', [...methods, 'OPTIONS'].join(', '));
    headers.set('access-control-allow-headers', ALLOWED_HEADERS);
    headers.set('access-control-max-age', '86400');
  }
  return new Response(null, { status: 204, headers });
}

/** Copy the CORS headers onto a response (merging `Vary`). */
export function withCors(req: Request, res: Response): Response {
  const cors = corsHeaders(req);
  const headers = new Headers(res.headers);
  cors.forEach((value, key) => {
    if (key === 'vary') {
      const current = headers.get('vary');
      const parts = new Set(
        `${current ?? ''},${value}`
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean),
      );
      headers.set('vary', [...parts].join(', '));
    } else headers.set(key, value);
  });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

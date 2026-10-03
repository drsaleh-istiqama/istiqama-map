/** Small HTTP helpers shared by the route handlers (node:http only). */
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export class PayloadTooLargeError extends HttpError {
  constructor(public limit: number) {
    super(413, 'payload too large');
  }
}

/** Buffer the request body, refusing more than `limit` bytes. */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new PayloadTooLargeError(limit));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      total += c.length;
      if (total > limit) {
        done = true;
        reject(new PayloadTooLargeError(limit));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks, total));
      }
    });
    req.on('error', (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
    req.on('aborted', () => {
      if (!done) {
        done = true;
        reject(new HttpError(400, 'request aborted'));
      }
    });
  });
}

export async function readJson(
  req: IncomingMessage,
  limit = 1024 * 1024,
): Promise<Record<string, unknown>> {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    const parsed: unknown = JSON.parse(buf.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Could not parse request body as JSON');
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | number> = {},
): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    ...headers,
  });
  res.end(payload);
}

export function sendEmpty(
  res: ServerResponse,
  status: number,
  headers: Record<string, string | number> = {},
): void {
  res.writeHead(status, headers);
  res.end();
}

export function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Split a raw request URL into path and query string (no allocation of URL objects). */
export function splitUrl(url: string): { path: string; query: string } {
  const i = url.indexOf('?');
  return i < 0 ? { path: url, query: '' } : { path: url.slice(0, i), query: url.slice(i + 1) };
}

/** Decode one path segment; malformed escapes yield null. */
export function decodeSegment(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** Request headers as a plain lower-cased map without credentials (for request.headers). */
export function safeHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'authorization' || k === 'apikey' || k === 'cookie') continue;
    if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

export function clientIp(req: IncomingMessage): string {
  const ip = req.socket.remoteAddress ?? '127.0.0.1';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

const ALLOW_HEADERS = [
  'authorization',
  'apikey',
  'content-type',
  'x-client-info',
  'x-device-id',
  'prefer',
  'range',
  'accept',
  'accept-profile',
  'content-profile',
  'tus-resumable',
  'upload-length',
  'upload-metadata',
  'upload-offset',
  'upload-defer-length',
  'upload-concat',
  'x-upsert',
  'x-metadata',
  'cache-control',
  'x-supabase-api-version',
  'x-http-method-override',
  'if-none-match',
  'if-match',
  'accept-language',
  'x-region',
  'x-requested-with',
];
const EXPOSE_HEADERS = [
  'content-range',
  'content-length',
  'content-encoding',
  'content-location',
  'location',
  'etag',
  'accept-ranges',
  'upload-offset',
  'upload-length',
  'upload-expires',
  'upload-metadata',
  'tus-resumable',
  'tus-version',
  'tus-extension',
  'tus-max-size',
  'x-total-count',
  'link',
  'x-supabase-api-version',
  'preference-applied',
  'sb-error-code',
].join(', ');

/** CORS headers for browser clients. Edge Functions answer CORS themselves (as in production). */
export function applyCors(req: IncomingMessage, res: ServerResponse, allowedOrigin: string): void {
  const origin = header(req, 'origin');
  if (!origin) return;
  if (allowedOrigin === '*') res.setHeader('access-control-allow-origin', '*');
  else if (allowedOrigin.split(',').some((o) => o.trim() === origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
  } else return;
  res.setHeader('access-control-expose-headers', EXPOSE_HEADERS);
}

export function isPreflight(req: IncomingMessage): boolean {
  return (
    req.method === 'OPTIONS' &&
    req.headers.origin !== undefined &&
    req.headers['access-control-request-method'] !== undefined
  );
}

export function answerPreflight(req: IncomingMessage, res: ServerResponse): void {
  // Like Kong/PostgREST on Supabase: requested headers are echoed back.
  const requested = (header(req, 'access-control-request-headers') ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const allow = [...new Set([...ALLOW_HEADERS, ...requested])].join(', ');
  res.writeHead(204, {
    'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': allow,
    'access-control-max-age': '3600',
    'content-length': 0,
  });
  res.end();
}

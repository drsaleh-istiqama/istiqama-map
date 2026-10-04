/**
 * HTTP helpers shared by every function: JSON responses, one error shape and the request
 * wrapper (CORS, method check, error mapping, Server-Timing).
 *
 * Error body = the PostgREST shape the web app already handles for direct RPC calls:
 *   { "code": "PT403", "message": "forbidden", "details": "…" | null, "hint": "…" | null }
 * `message` is the machine-readable identifier (switch on it), `code` the SQLSTATE-like class.
 */
import { preflight, withCors } from './cors.ts';
import { MissingEnvError } from './env.ts';

export interface ErrorBody {
  code: string;
  message: string;
  details: string | null;
  hint: string | null;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: string | null;
  readonly hint: string | null;
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    code: string,
    message: string,
    extra: { details?: string | null; hint?: string | null; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = extra.details ?? null;
    this.hint = extra.hint ?? null;
    this.headers = extra.headers ?? {};
  }

  body(): ErrorBody {
    return { code: this.code, message: this.message, details: this.details, hint: this.hint };
  }
}

export const errors = {
  badRequest: (message: string, details?: string) =>
    new HttpError(400, 'PT400', message, { details }),
  unauthorized: (message = 'not_authenticated', details?: string) =>
    new HttpError(401, 'PT401', message, { details }),
  forbidden: (message = 'forbidden', details?: string) =>
    new HttpError(403, 'PT403', message, { details }),
  notFound: (message = 'not_found', details?: string) =>
    new HttpError(404, 'PT404', message, { details }),
  methodNotAllowed: (allowed: string[]) =>
    new HttpError(405, 'PT405', 'method_not_allowed', {
      details: `Use ${allowed.join(' or ')}.`,
      headers: { allow: [...allowed, 'OPTIONS'].join(', ') },
    }),
  conflict: (message: string, details?: string) =>
    new HttpError(409, 'PT409', message, { details }),
  tooLarge: (message = 'payload_too_large', details?: string) =>
    new HttpError(413, 'PT413', message, { details }),
  unsupportedMedia: (message = 'unsupported_media_type', details?: string) =>
    new HttpError(415, 'PT415', message, { details }),
  validation: (message: string, details?: string) =>
    new HttpError(422, 'PT422', message, { details }),
  rateLimited: (retryAfterSeconds: number, details?: string) =>
    new HttpError(429, 'PT429', 'rate_limited', {
      details,
      hint: `Retry in ${retryAfterSeconds} seconds.`,
      headers: { 'retry-after': String(retryAfterSeconds) },
    }),
  upstream: (message = 'upstream_unavailable', details?: string) =>
    new HttpError(502, 'PT502', message, { details }),
};

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set('content-type', 'application/json; charset=utf-8');
  if (!h.has('cache-control')) h.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function errorResponse(error: HttpError): Response {
  return json(error.body(), error.status, error.headers);
}

/** What supabase-js hands back for a failed RPC / table call (`PostgrestError`), or similar. */
export interface DbErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

const SQLSTATE_STATUS: Record<string, number> = {
  '42501': 403, // insufficient privilege (anon, missing grant)
  '23505': 409, // unique violation
  '23503': 409, // foreign key violation
  '23502': 422, // not null violation
  '23514': 422, // check violation
  '22P02': 422, // invalid text representation (bad uuid, bad number)
  '22023': 422, // invalid parameter value
  '22003': 422, // numeric value out of range
  '22007': 422, // invalid datetime format
  '40001': 503, // serialization failure — retry
  '40P01': 503, // deadlock — retry
  '55P03': 503, // lock not available — retry
  '57014': 504, // statement timeout
  '53300': 503, // too many connections
  PGRST116: 406, // not exactly one row
  PGRST202: 404, // function not found in the schema cache
  PGRST204: 400, // column not found
  PGRST301: 401, // JWT expired / invalid
  PGRST302: 401, // anonymous access disabled
  PGRST303: 401, // JWT claims invalid
};

/**
 * HTTP status for a database / PostgREST error. Project errors use SQLSTATE `PTxxx`, which
 * PostgREST itself turns into status xxx; the same rule is applied here so that a call made
 * through a function and a direct RPC call fail identically.
 */
export function statusForDbError(error: DbErrorLike, fallback = 500): number {
  const code = error.code ?? '';
  const pt = /^PT(\d{3})$/.exec(code);
  if (pt) {
    const status = Number(pt[1]);
    if (status >= 400 && status <= 599) return status;
  }
  const mapped = SQLSTATE_STATUS[code];
  if (mapped !== undefined) return mapped;
  if (fallback >= 400 && fallback <= 599) return fallback;
  return 500;
}

/** Convert a PostgREST / RPC error into the common error (same code, message, details, hint). */
export function fromDbError(error: DbErrorLike, httpStatus?: number): HttpError {
  const status = statusForDbError(error, httpStatus ?? 500);
  const headers: Record<string, string> = {};
  if (status === 429) {
    const seconds = /(\d+)\s*seconds?/i.exec(error.hint ?? '')?.[1];
    headers['retry-after'] = seconds ?? '60';
  }
  return new HttpError(
    status,
    error.code && error.code !== '' ? error.code : `PT${status}`,
    error.message && error.message !== '' ? error.message : 'database_error',
    { details: error.details ?? null, hint: error.hint ?? null, headers },
  );
}

/** Unwrap a supabase-js `{ data, error, status }` result or throw the mapped error. */
export function unwrap<T>(result: {
  data: T | null;
  error: DbErrorLike | null;
  status?: number;
}): T {
  if (result.error) throw fromDbError(result.error, result.status);
  return result.data as T;
}

/** Storage errors (`StorageApiError`): HTTP 400 with the real status in `statusCode`. */
export function fromStorageError(error: {
  message?: string;
  statusCode?: string | number;
  status?: number;
}): HttpError {
  const semantic = Number(error.statusCode ?? error.status ?? 500);
  const status = semantic >= 400 && semantic <= 599 ? semantic : 500;
  return new HttpError(status, `PT${status}`, 'storage_error', {
    details: error.message ?? null,
  });
}

export function toHttpError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof MissingEnvError)
    return new HttpError(500, 'PT500', 'function_misconfigured', { details: e.message });
  const message = e instanceof Error ? e.message : String(e);
  return new HttpError(500, 'PT500', 'internal_error', { details: message.slice(0, 500) });
}

/** Read a JSON body with a size cap. An empty body yields `{}`. */
export async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  const text = await readText(req, maxBytes);
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw errors.badRequest('invalid_json', 'The request body is not valid JSON.');
  }
}

export async function readText(req: Request, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBytes(req, maxBytes));
}

/** Read the request body, refusing more than `maxBytes` (also without a Content-Length). */
export async function readBytes(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes)
    throw errors.tooLarge('payload_too_large', `The body exceeds ${maxBytes} bytes.`);
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw errors.tooLarge('payload_too_large', `The body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  return concatBytes(chunks, total);
}

export function concatBytes(chunks: Uint8Array[], total?: number): Uint8Array {
  const size = total ?? chunks.reduce((n, c) => n + c.byteLength, 0);
  if (chunks.length === 1 && chunks[0]!.byteLength === size) return chunks[0]!;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** Collects `Server-Timing` entries (durations in milliseconds). */
export class Timing {
  private readonly started = performance.now();
  private readonly entries: string[] = [];

  async measure<T>(name: string, work: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await work();
    } finally {
      this.add(name, performance.now() - t0);
    }
  }

  add(name: string, ms: number): void {
    this.entries.push(`${name};dur=${ms.toFixed(1)}`);
  }

  header(): string {
    return [...this.entries, `total;dur=${(performance.now() - this.started).toFixed(1)}`].join(
      ', ',
    );
  }
}

export interface HandlerContext {
  timing: Timing;
}

export type Handler = (req: Request) => Promise<Response>;

/**
 * Wraps a function implementation: answers CORS preflights, enforces the allowed methods,
 * maps thrown errors to the common error body and adds CORS + Server-Timing headers.
 */
export function createHandler(
  name: string,
  methods: string[],
  impl: (req: Request, ctx: HandlerContext) => Promise<Response>,
): Handler {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return preflight(req, methods);
    const timing = new Timing();
    let res: Response;
    try {
      if (!methods.includes(req.method)) throw errors.methodNotAllowed(methods);
      res = await impl(req, { timing });
    } catch (e) {
      const error = toHttpError(e);
      if (error.status >= 500)
        console.error(`[${name}] ${error.message}: ${error.details ?? ''}`.trim());
      res = errorResponse(error);
    }
    const out = withCors(req, res);
    out.headers.set('server-timing', timing.header());
    return out;
  };
}

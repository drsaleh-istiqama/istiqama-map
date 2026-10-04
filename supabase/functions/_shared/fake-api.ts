/**
 * TEST HELPER — not imported by any function.
 *
 * An in-memory stand-in for the Supabase API gateway behind `fetch`, for handler tests: the
 * functions keep using the real supabase-js clients, every request they make is recorded
 * (method, path, headers, body) and answered by the routes a test registers. This makes the
 * properties that matter for security visible in unit tests: WHICH credentials each request
 * carries (caller token vs. service key) and in WHICH order the calls happen.
 */

export interface RecordedRequest {
  method: string;
  url: URL;
  /** `url.pathname`, e.g. `/rest/v1/rpc/export_rows`. */
  path: string;
  headers: Headers;
  bytes: Uint8Array;
  text(): string;
  json<T = Record<string, unknown>>(): T;
  /** The body parsed as `multipart/form-data` (storage uploads of a Blob). */
  form(): Promise<FormData>;
  /** The bearer token of the request (`Authorization: Bearer …`), or null. */
  bearer(): string | null;
}

export type Reply =
  Response | ((req: RecordedRequest, match: RegExpExecArray) => Response | Promise<Response>);

interface Route {
  method: string;
  pattern: RegExp;
  reply: Reply;
  times: number; // remaining uses; Infinity = persistent
}

/**
 * A fixed Response as a reply that can be served any number of times. (`Response.clone()` is
 * not usable for that: the clones share a tee, and cancelling one clone's body never settles
 * while the original stays unread.)
 */
function replay(template: Response): (req: RecordedRequest) => Promise<Response> {
  const bytes = template.arrayBuffer();
  const init = {
    status: template.status,
    statusText: template.statusText,
    headers: new Headers(template.headers),
  };
  return async () => {
    const body = await bytes;
    return new Response(body.byteLength === 0 ? null : body.slice(0), init);
  };
}

function toPattern(path: string | RegExp): RegExp {
  if (path instanceof RegExp) return path;
  return new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

export function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(value === undefined ? null : JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** PostgREST error body (`{ code, message, details, hint }`) with the matching status. */
export function pgError(
  status: number,
  code: string,
  message: string,
  details: string | null = null,
): Response {
  return jsonResponse({ code, message, details, hint: null }, status);
}

export class FakeApi {
  readonly calls: RecordedRequest[] = [];
  private readonly routes: Route[] = [];

  /**
   * Answer `method path` with `reply`. `path` is matched against the pathname (a string must
   * match exactly). A route with `times` is used that many times; routes registered later are
   * consulted first, so a one-off reply can be stacked on a persistent one.
   */
  on(method: string, path: string | RegExp, reply: Reply, times = Infinity): this {
    this.routes.unshift({
      method: method.toUpperCase(),
      pattern: toPattern(path),
      reply: reply instanceof Response ? replay(reply) : reply,
      times,
    });
    return this;
  }

  /** Requests whose method and pathname match. */
  callsTo(method: string, path: string | RegExp): RecordedRequest[] {
    const pattern = toPattern(path);
    return this.calls.filter((c) => c.method === method.toUpperCase() && pattern.test(c.path));
  }

  /** RPC calls (`POST /rest/v1/rpc/<name>`), with their argument objects. */
  rpcCalls(name: string): RecordedRequest[] {
    return this.callsTo('POST', `/rest/v1/rpc/${name}`);
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const bytes = new Uint8Array(await request.arrayBuffer());
    const url = new URL(request.url);
    const contentType = request.headers.get('content-type') ?? '';
    const recorded: RecordedRequest = {
      method: request.method.toUpperCase(),
      url,
      path: url.pathname,
      headers: request.headers,
      bytes,
      text: () => new TextDecoder().decode(bytes),
      json: <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
      form: () =>
        new Response(bytes as BodyInit, { headers: { 'content-type': contentType } }).formData(),
      bearer: () =>
        /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? null,
    };
    this.calls.push(recorded);
    for (const route of this.routes) {
      if (route.times <= 0 || route.method !== recorded.method) continue;
      const match = route.pattern.exec(recorded.path);
      if (!match) continue;
      route.times--;
      return typeof route.reply === 'function' ? route.reply(recorded, match) : route.reply;
    }
    return jsonResponse(
      { code: 'TEST', message: `no route for ${recorded.method} ${recorded.path}` },
      501,
    );
  };
}

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** An (unsigned) access token of a signed-in user, as the platform hands it to a function. */
export function userToken(sub: string, claims: Record<string, unknown> = {}): string {
  const payload = {
    sub,
    role: 'authenticated',
    aal: 'aal1',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  };
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.signature`;
}

/** A distinct user id per call (keeps the per-user rate limiters of one test file apart). */
let seq = 0;
export function nextUserId(prefix = '00000000-0000-4000-8000'): string {
  seq++;
  return `${prefix}-${String(seq).padStart(12, '0')}`;
}

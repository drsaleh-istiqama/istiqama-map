/**
 * Caller identification.
 *
 * How the JWT is verified — the Supabase model:
 *   The platform (Edge Runtime relay; locally the gateway) verifies signature and expiry of
 *   the `Authorization` bearer BEFORE the function runs whenever `verify_jwt = true` (the
 *   default; keep it for every function except `otp-hook`). The function therefore only
 *   DECODES the token to learn who is calling. It never uses the decoded identity as an
 *   authorisation by itself: every read and write on behalf of the caller goes back to
 *   PostgREST / Storage with that same token, where it is verified again and where RLS and
 *   the RPC permission checks decide. Service-role actions use ids returned by those calls
 *   (job owner, RPC result), not claims taken from the token.
 *
 *   If a deployment ever disables `verify_jwt`, set `FUNCTIONS_VERIFY_JWT=getuser`: the token
 *   is then checked against the Auth server (`GET /auth/v1/user`) on every request, at the
 *   cost of one extra round trip.
 */
import { anonKey, env, serviceKey, supabaseUrl } from './env.ts';
import { errors, isUuid } from './http.ts';

export interface JwtClaims {
  sub?: string;
  role?: string;
  aal?: string;
  exp?: number;
  iat?: number;
  session_id?: string;
  email?: string;
  phone?: string;
  [claim: string]: unknown;
}

export interface Caller {
  token: string;
  userId: string;
  aal: 'aal1' | 'aal2';
  sessionId: string | null;
  claims: JwtClaims;
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1]! : null;
}

function base64UrlDecode(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Payload of a JWT WITHOUT verifying it (see the module comment). Null when malformed. */
export function decodeJwt(token: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]!)));
    return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as JwtClaims)
      : null;
  } catch {
    return null;
  }
}

/** Identify the caller from the (platform-verified) bearer token. Pure: no network. */
export function identify(req: Request, nowSeconds = Date.now() / 1000): Caller {
  const token = bearerToken(req);
  if (!token) throw errors.unauthorized('not_authenticated', 'Missing bearer token.');
  const claims = decodeJwt(token);
  if (!claims) throw errors.unauthorized('not_authenticated', 'Malformed JWT.');
  if (claims.role !== 'authenticated' || !isUuid(claims.sub))
    throw errors.unauthorized('not_authenticated', 'A signed-in user is required.');
  if (typeof claims.exp === 'number' && claims.exp < nowSeconds)
    throw errors.unauthorized('not_authenticated', 'JWT expired.');
  return {
    token,
    userId: claims.sub.toLowerCase(),
    aal: claims.aal === 'aal2' ? 'aal2' : 'aal1',
    sessionId: typeof claims.session_id === 'string' ? claims.session_id : null,
    claims,
  };
}

/**
 * The signed-in caller, or a 401 error. With `FUNCTIONS_VERIFY_JWT=getuser` (or
 * `verify: true`) the token is additionally validated by the Auth server.
 */
export async function requireUser(req: Request, opts: { verify?: boolean } = {}): Promise<Caller> {
  const caller = identify(req);
  const verify = opts.verify ?? env('FUNCTIONS_VERIFY_JWT')?.toLowerCase() === 'getuser';
  if (verify) {
    let res: Response;
    try {
      res = await fetch(`${supabaseUrl()}/auth/v1/user`, {
        headers: {
          apikey: req.headers.get('apikey') ?? anonKey(),
          authorization: `Bearer ${caller.token}`,
        },
      });
    } catch (e) {
      throw errors.upstream('auth_unavailable', e instanceof Error ? e.message : String(e));
    }
    if (res.status >= 500) throw errors.upstream('auth_unavailable', `Auth answered ${res.status}.`);
    const user = res.ok ? ((await res.json().catch(() => null)) as { id?: string } | null) : null;
    if (!res.ok) await res.body?.cancel().catch(() => undefined);
    if (!user || typeof user.id !== 'string' || user.id.toLowerCase() !== caller.userId)
      throw errors.unauthorized('not_authenticated', 'The token was rejected by the Auth server.');
  }
  return caller;
}

/** Length-independent comparison without early exit on the first different character. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/**
 * Service-only functions (`purge-photos`): the bearer (or `apikey`) must BE the service-role
 * key. A decoded `role` claim is deliberately not accepted — see the module comment.
 */
export function requireServiceRole(req: Request): void {
  const presented = bearerToken(req) ?? req.headers.get('apikey');
  if (!presented) throw errors.unauthorized('not_authenticated', 'Missing service credentials.');
  if (!safeEqual(presented, serviceKey()))
    throw errors.forbidden('forbidden', 'This function is restricted to the service role.');
}

export function isServiceRequest(req: Request): boolean {
  const presented = bearerToken(req) ?? req.headers.get('apikey');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  return presented !== null && key !== undefined && safeEqual(presented, key);
}

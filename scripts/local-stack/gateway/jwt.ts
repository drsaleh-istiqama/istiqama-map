/**
 * JWT helpers (HS256, the algorithm of a Supabase project's legacy JWT secret).
 * Access tokens carry the GoTrue claims of docs/ARCHITECTURE.md Appendix A.5.
 */
import jwt from 'jsonwebtoken';

export type Role = 'anon' | 'authenticated' | 'service_role';

export interface AmrEntry {
  method: string;
  timestamp: number;
}

export interface AccessClaims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  email: string;
  phone: string;
  app_metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown>;
  role: string;
  aal: 'aal1' | 'aal2';
  amr: AmrEntry[];
  session_id: string;
  is_anonymous: boolean;
}

export type Claims = Record<string, unknown>;

export function signJwt(payload: Record<string, unknown>, secret: string): string {
  // iat/exp are set explicitly by the callers (GoTrue-style integer seconds).
  return jwt.sign(payload, secret, { algorithm: 'HS256', noTimestamp: true });
}

export type VerifyResult =
  { ok: true; claims: Claims } | { ok: false; reason: 'expired' | 'invalid'; message: string };

export function verifyJwt(token: string, secret: string, nowSeconds?: number): VerifyResult {
  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      ...(nowSeconds !== undefined ? { clockTimestamp: nowSeconds } : {}),
    });
    if (typeof decoded !== 'object' || decoded === null)
      return { ok: false, reason: 'invalid', message: 'token payload is not an object' };
    return { ok: true, claims: decoded as Claims };
  } catch (e) {
    const err = e as Error;
    return {
      ok: false,
      reason: err.name === 'TokenExpiredError' ? 'expired' : 'invalid',
      message: err.message,
    };
  }
}

export function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const m = /^Bearer\s+(.+)$/i.exec(value.trim());
  return m ? m[1]!.trim() : null;
}

export function roleOf(claims: Claims): Role | null {
  const role = claims.role;
  return role === 'anon' || role === 'authenticated' || role === 'service_role' ? role : null;
}

export interface AccessTokenInput {
  issuer: string;
  userId: string;
  aud: string;
  role: string;
  email: string | null;
  phone: string | null;
  appMetadata: Record<string, unknown>;
  userMetadata: Record<string, unknown>;
  sessionId: string;
  aal: 'aal1' | 'aal2';
  amr: AmrEntry[];
  isAnonymous: boolean;
  nowSeconds: number;
  expiresIn: number;
}

export function buildAccessClaims(i: AccessTokenInput): AccessClaims {
  return {
    iss: i.issuer,
    sub: i.userId,
    aud: i.aud || 'authenticated',
    exp: i.nowSeconds + i.expiresIn,
    iat: i.nowSeconds,
    email: i.email ?? '',
    phone: i.phone ?? '',
    app_metadata: i.appMetadata,
    user_metadata: i.userMetadata,
    role: i.role || 'authenticated',
    aal: i.aal,
    // GoTrue lists the most recent authentication method first.
    amr: [...i.amr].sort((a, b) => b.timestamp - a.timestamp),
    session_id: i.sessionId,
    is_anonymous: i.isAnonymous,
  };
}

/** Token embedded in storage signed URLs: `{ url: "<bucket>/<object name>", iat, exp }`. */
export function signObjectUrl(
  objectPath: string,
  expiresIn: number,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  return signJwt({ url: objectPath, iat: nowSeconds, exp: nowSeconds + expiresIn }, secret);
}

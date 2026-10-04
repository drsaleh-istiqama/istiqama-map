import { describe, expect, it } from 'vitest';
import {
  bearerToken,
  buildAccessClaims,
  roleOf,
  signJwt,
  signObjectUrl,
  verifyJwt,
} from '../jwt.ts';

const SECRET = 'unit-test-secret-with-at-least-32-characters';

describe('jwt', () => {
  it('signs HS256 tokens that verify with the same secret', () => {
    const token = signJwt({ role: 'anon', iat: 1_700_000_000, exp: 4_000_000_000 }, SECRET);
    const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'));
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
    // regression: the iat claim must survive signing (session revocation depends on it)
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
    expect(payload.iat).toBe(1_700_000_000);
    const v = verifyJwt(token, SECRET);
    expect(v.ok).toBe(true);
    if (v.ok) expect(roleOf(v.claims)).toBe('anon');
  });

  it('rejects a wrong secret, a tampered payload and garbage', () => {
    const token = signJwt({ role: 'service_role', exp: 4_000_000_000 }, SECRET);
    expect(verifyJwt(token, SECRET + 'x')).toMatchObject({ ok: false, reason: 'invalid' });
    const [h, , s] = token.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ role: 'service_role', exp: 4_100_000_000 })).toString('base64url')}.${s}`;
    expect(verifyJwt(forged, SECRET).ok).toBe(false);
    expect(verifyJwt('not-a-jwt', SECRET).ok).toBe(false);
  });

  it('rejects unsigned (alg none) tokens', () => {
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"role":"service_role"}').toString('base64url')}.`;
    expect(verifyJwt(none, SECRET).ok).toBe(false);
  });

  it('reports expiry separately', () => {
    const token = signJwt({ role: 'authenticated', sub: 'u', iat: 1000, exp: 2000 }, SECRET);
    expect(verifyJwt(token, SECRET, 1500).ok).toBe(true);
    expect(verifyJwt(token, SECRET, 2001)).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('builds GoTrue access-token claims (Appendix A.5)', () => {
    const claims = buildAccessClaims({
      issuer: 'http://127.0.0.1:54321/auth/v1',
      userId: '11111111-1111-4111-8111-111111111111',
      aud: 'authenticated',
      role: 'authenticated',
      email: 'u@example.org',
      phone: null,
      appMetadata: { provider: 'email', providers: ['email'] },
      userMetadata: { full_name: 'U' },
      sessionId: '22222222-2222-4222-8222-222222222222',
      aal: 'aal2',
      amr: [
        { method: 'otp', timestamp: 100 },
        { method: 'totp', timestamp: 200 },
      ],
      isAnonymous: false,
      nowSeconds: 1_700_000_000,
      expiresIn: 3600,
    });
    expect(claims).toMatchObject({
      sub: '11111111-1111-4111-8111-111111111111',
      role: 'authenticated',
      aud: 'authenticated',
      email: 'u@example.org',
      phone: '',
      aal: 'aal2',
      session_id: '22222222-2222-4222-8222-222222222222',
      iat: 1_700_000_000,
      exp: 1_700_003_600,
      is_anonymous: false,
    });
    // most recent method first
    expect(claims.amr.map((a) => a.method)).toEqual(['totp', 'otp']);
    const v = verifyJwt(
      signJwt(claims as unknown as Record<string, unknown>, SECRET),
      SECRET,
      1_700_000_100,
    );
    expect(v.ok && v.claims.session_id).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('extracts bearer tokens', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer   abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  it('signs object URLs bound to one object and a lifetime', () => {
    const token = signObjectUrl('photos/projects/TZ/a/b_full.webp', 60, SECRET, 1000);
    const ok = verifyJwt(token, SECRET, 1030);
    expect(ok.ok && ok.claims.url).toBe('photos/projects/TZ/a/b_full.webp');
    expect(verifyJwt(token, SECRET, 1061)).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('only accepts the three API roles', () => {
    expect(roleOf({ role: 'authenticated' })).toBe('authenticated');
    expect(roleOf({ role: 'postgres' })).toBeNull();
    expect(roleOf({})).toBeNull();
  });
});

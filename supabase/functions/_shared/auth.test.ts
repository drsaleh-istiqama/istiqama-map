import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bearerToken,
  decodeJwt,
  identify,
  isServiceRequest,
  requireServiceRole,
  requireUser,
  safeEqual,
} from './auth.ts';
import { HttpError } from './http.ts';

function b64url(value: unknown): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(value))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** An unsigned token: these helpers never verify signatures (the platform does). */
function token(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.signature`;
}

const USER = '10819483-9a9e-3205-82f7-facf43870673';
const now = Math.floor(Date.now() / 1000);

function request(headers: Record<string, string>): Request {
  return new Request('http://x/fn', { headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('token helpers', () => {
  it('bearerToken', () => {
    expect(bearerToken(request({ authorization: 'Bearer abc.def.ghi' }))).toBe('abc.def.ghi');
    expect(bearerToken(request({ authorization: 'bearer abc' }))).toBe('abc');
    expect(bearerToken(request({ authorization: 'Basic abc' }))).toBeNull();
    expect(bearerToken(request({}))).toBeNull();
  });

  it('decodeJwt reads the payload, UTF-8 included', () => {
    const claims = decodeJwt(token({ sub: USER, role: 'authenticated', name: 'مُدخل بيمبا' }));
    expect(claims).toMatchObject({ sub: USER, role: 'authenticated', name: 'مُدخل بيمبا' });
    expect(decodeJwt('not-a-jwt')).toBeNull();
    expect(decodeJwt('a.b.c')).toBeNull();
    expect(decodeJwt(`x.${b64url([1, 2])}.y`)).toBeNull();
  });

  it('safeEqual', () => {
    expect(safeEqual('secret', 'secret')).toBe(true);
    expect(safeEqual('secret', 'secreT')).toBe(false);
    expect(safeEqual('secret', 'secret-longer')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('identify', () => {
  it('returns the caller of a signed-in user token', () => {
    const t = token({
      sub: USER,
      role: 'authenticated',
      aal: 'aal2',
      session_id: 's1',
      exp: now + 3600,
    });
    const caller = identify(request({ authorization: `Bearer ${t}` }));
    expect(caller).toMatchObject({ userId: USER, aal: 'aal2', sessionId: 's1', token: t });
  });

  it('defaults to aal1', () => {
    const t = token({ sub: USER, role: 'authenticated', exp: now + 3600 });
    expect(identify(request({ authorization: `Bearer ${t}` })).aal).toBe('aal1');
  });

  it.each([
    ['no header', {}],
    ['malformed token', { authorization: 'Bearer garbage' }],
    [
      'anon key (role anon, no sub)',
      { authorization: `Bearer ${token({ role: 'anon', exp: now + 3600 })}` },
    ],
    [
      'service key (no sub)',
      { authorization: `Bearer ${token({ role: 'service_role', exp: now + 3600 })}` },
    ],
    [
      'sub is not a uuid',
      { authorization: `Bearer ${token({ sub: 'me', role: 'authenticated', exp: now + 3600 })}` },
    ],
    [
      'expired',
      { authorization: `Bearer ${token({ sub: USER, role: 'authenticated', exp: now - 10 })}` },
    ],
  ])('refuses: %s', (_name, headers) => {
    let error: unknown;
    try {
      identify(request(headers as Record<string, string>));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(401);
    expect((error as HttpError).body()).toMatchObject({
      code: 'PT401',
      message: 'not_authenticated',
    });
  });
});

describe('requireUser with FUNCTIONS_VERIFY_JWT=getuser', () => {
  const t = token({ sub: USER, role: 'authenticated', exp: now + 3600 });

  it('does not call the Auth server by default', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const caller = await requireUser(request({ authorization: `Bearer ${t}` }));
    expect(caller.userId).toBe(USER);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks the Auth server and accepts the matching user', async () => {
    vi.stubEnv('FUNCTIONS_VERIFY_JWT', 'getuser');
    vi.stubEnv('SUPABASE_URL', 'http://auth.test');
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon');
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: USER }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(requireUser(request({ authorization: `Bearer ${t}` }))).resolves.toMatchObject({
      userId: USER,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://auth.test/auth/v1/user');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${t}`);
  });

  it('refuses a token the Auth server does not know', async () => {
    vi.stubEnv('FUNCTIONS_VERIFY_JWT', 'getuser');
    vi.stubEnv('SUPABASE_URL', 'http://auth.test');
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"code":"bad_jwt"}', { status: 403 })),
    );
    await expect(requireUser(request({ authorization: `Bearer ${t}` }))).rejects.toMatchObject({
      status: 401,
    });
  });

  it('reports an unreachable Auth server as 502, not as "unauthenticated"', async () => {
    vi.stubEnv('FUNCTIONS_VERIFY_JWT', 'getuser');
    vi.stubEnv('SUPABASE_URL', 'http://auth.test');
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 })),
    );
    await expect(requireUser(request({ authorization: `Bearer ${t}` }))).rejects.toMatchObject({
      status: 502,
    });
  });
});

describe('service-only functions', () => {
  it('accepts exactly the service-role key, as bearer or apikey', () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key-value');
    expect(() =>
      requireServiceRole(request({ authorization: 'Bearer service-key-value' })),
    ).not.toThrow();
    expect(() => requireServiceRole(request({ apikey: 'service-key-value' }))).not.toThrow();
    expect(isServiceRequest(request({ authorization: 'Bearer service-key-value' }))).toBe(true);
  });

  it('refuses users, even with a forged service_role claim', () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key-value');
    const user = token({ sub: USER, role: 'authenticated', exp: now + 3600 });
    const forged = token({ role: 'service_role', exp: now + 3600 });
    const statusOf = (req: Request): number | null => {
      try {
        requireServiceRole(req);
        return null;
      } catch (e) {
        return (e as HttpError).status;
      }
    };
    for (const t of [user, forged]) {
      expect(statusOf(request({ authorization: `Bearer ${t}` }))).toBe(403);
      expect(isServiceRequest(request({ authorization: `Bearer ${t}` }))).toBe(false);
    }
    expect(statusOf(request({}))).toBe(401);
  });
});

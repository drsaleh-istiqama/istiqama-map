/**
 * The REAL supabase-js client of `supabase.ts`, wired to the PIN vault, with only the network
 * replaced by a stub. Proves what the other tests take for granted: supabase-js itself keeps its
 * session in the vault (nothing token-like in localStorage, sessionStorage or cookies, only
 * ciphertext in IndexedDB), every request carries `x-device-id`, and a locked app sends no user
 * token at all.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { collectorPemba, fakeAccessToken } from './__fixtures__/myContext';
import type * as StoreModule from './store';
import type * as SupabaseModule from './supabase';

const EMAIL = 'collector.pemba@example.org';
const PIN = '4071';
const ACCESS = fakeAccessToken({
  sub: collectorPemba.user_id,
  aal: 'aal1',
  role: 'authenticated',
  exp: Math.floor(Date.now() / 1000) + 3600,
});
const REFRESH = 'refresh-unit-0u20m998iaz5';

interface Seen {
  method: string;
  path: string;
  headers: Headers;
}

const seen: Seen[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A tiny GoTrue + PostgREST: just what this test calls. */
async function fakeServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  seen.push({ method: request.method, path: url.pathname, headers: request.headers });
  if (url.pathname === '/auth/v1/otp') return json({});
  if (url.pathname === '/auth/v1/verify') {
    return json({
      access_token: ACCESS,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: REFRESH,
      user: {
        id: collectorPemba.user_id,
        aud: 'authenticated',
        role: 'authenticated',
        email: EMAIL,
        app_metadata: { provider: 'email' },
        user_metadata: {},
        created_at: '2026-10-03T00:00:00Z',
      },
    });
  }
  if (url.pathname === '/rest/v1/rpc/my_context') return json(collectorPemba);
  return json({ code: 404, error_code: 'not_found', msg: 'not emulated' }, 404);
}

/** Everything the browser keeps outside IndexedDB, as one searchable text. */
function browserStorageText(): string {
  const chunks: string[] = [document.cookie];
  for (const store of [localStorage, sessionStorage]) {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i) ?? '';
      chunks.push(key, store.getItem(key) ?? '');
    }
  }
  return chunks.join('\n');
}

/** Everything the vault wrote to IndexedDB (keys, strings, raw bytes) as one searchable text. */
async function vaultText(dump: Array<{ key: string; value: unknown }>): Promise<string> {
  const chunks: string[] = [];
  const visit = (value: unknown): void => {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      chunks.push(new TextDecoder('latin1').decode(value));
    } else if (typeof value === 'object' && value !== null) Object.values(value).forEach(visit);
    else chunks.push(String(value));
  };
  for (const entry of dump) {
    chunks.push(entry.key);
    visit(entry.value);
  }
  return chunks.join('\n');
}

function expectNoToken(text: string): void {
  expect(text).not.toContain(ACCESS);
  expect(text).not.toContain(REFRESH);
  expect(text).not.toContain('access_token');
  expect(text).not.toContain('refresh_token');
  expect(text).not.toContain(EMAIL);
}

let mod: {
  supabase: typeof SupabaseModule.supabase;
  vault: typeof StoreModule.vault;
  key: string;
  deviceId: string;
  anonKey: string;
};

beforeAll(async () => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(fakeServer));
  const { supabase } = await import('./supabase');
  const { vault, STORAGE_KEY } = await import('./store');
  const { deviceId } = await import('./device');
  const { env } = await import('../env');
  await supabase.auth.initialize();
  mod = {
    supabase,
    vault,
    key: STORAGE_KEY,
    deviceId: deviceId(),
    anonKey: env.supabaseAnonKey || 'anon-key-for-unit-tests',
  };
});

afterAll(async () => {
  await mod.supabase.auth.stopAutoRefresh();
  vi.unstubAllGlobals();
});

describe('real supabase-js client on top of the PIN vault', () => {
  it('signs in with an e-mail code; until a PIN exists the session lives in memory only', async () => {
    const { supabase, vault, key } = mod;
    const sent = await supabase.auth.signInWithOtp({
      email: EMAIL,
      options: { shouldCreateUser: false },
    });
    expect(sent.error).toBeNull();
    vault.expectFreshSignIn();
    const verified = await supabase.auth.verifyOtp({
      email: EMAIL,
      token: '123456',
      type: 'email',
    });
    expect(verified.error).toBeNull();

    expect(vault.storage.getItem(key)).toContain(ACCESS);
    expect((await supabase.auth.getSession()).data.session?.access_token).toBe(ACCESS);
    expect(await vault.dump()).toEqual([]);
    expectNoToken(browserStorageText());
  });

  it('after the PIN is chosen, only ciphertext reaches IndexedDB — and nothing else is written', async () => {
    const { vault } = mod;
    await vault.setPin(PIN);
    await vault.flush();
    const dump = await vault.dump();
    expect(dump.map((entry) => entry.key)).toEqual(['vault']);
    expectNoToken(await vaultText(dump));
    expectNoToken(browserStorageText());
  });

  it('sends the device id with every request, and the user token to the REST API', async () => {
    const { supabase, deviceId } = mod;
    const { data, error } = await supabase.rpc('my_context');
    expect(error).toBeNull();
    expect((data as { user_id: string }).user_id).toBe(collectorPemba.user_id);

    const paths = seen.map((request) => request.path);
    expect(paths).toEqual(
      expect.arrayContaining(['/auth/v1/otp', '/auth/v1/verify', '/rest/v1/rpc/my_context']),
    );
    for (const request of seen) {
      expect(request.headers.get('x-device-id'), request.path).toBe(deviceId);
      expect(request.headers.get('apikey'), request.path).toBeTruthy();
    }
    expect(seen.at(-1)?.headers.get('authorization')).toBe(`Bearer ${ACCESS}`);
  });

  it('while locked supabase-js has no session and no request carries the user token', async () => {
    const { supabase, vault, anonKey } = mod;
    vault.lock();
    expect((await supabase.auth.getSession()).data.session).toBeNull();
    await supabase.rpc('my_context');
    const last = seen.at(-1)!;
    expect(last.path).toBe('/rest/v1/rpc/my_context');
    expect(last.headers.get('authorization')).toBe(`Bearer ${anonKey}`);
    expect(seen.some((request) => request.path === '/auth/v1/token')).toBe(false);
  });

  it('unlocking hands the stored session back to supabase-js without any request', async () => {
    const { supabase, vault } = mod;
    const before = seen.length;
    expect(await vault.unlock(PIN)).toBe('ok');
    expect((await supabase.auth.getSession()).data.session?.refresh_token).toBe(REFRESH);
    expect(seen.length).toBe(before);
    expectNoToken(browserStorageText());
  });
});

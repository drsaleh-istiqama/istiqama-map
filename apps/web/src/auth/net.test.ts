import { describe, expect, it, vi } from 'vitest';
import { createGuardedFetch, urlHasAuthCallback } from './net';

const API = 'http://127.0.0.1:54321';

function respond(body: string, init: ResponseInit): () => Promise<Response> {
  return () => Promise.resolve(new Response(body, init));
}

describe('guarded fetch (captive portals must not sign the user out)', () => {
  it('passes JSON answers of the auth API through, including errors', async () => {
    const ok = createGuardedFetch(
      API,
      respond('{"access_token":"x"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect((await ok(`${API}/auth/v1/token?grant_type=refresh_token`)).status).toBe(200);

    const refused = createGuardedFetch(
      API,
      respond('{"code":"refresh_token_not_found"}', {
        status: 400,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    );
    expect((await refused(`${API}/auth/v1/token?grant_type=refresh_token`)).status).toBe(400);
  });

  it('turns a non-JSON answer to an auth request into a network failure', async () => {
    const portal = createGuardedFetch(
      API,
      respond('<html>Please log in to the hotspot</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    await expect(portal(`${API}/auth/v1/token?grant_type=refresh_token`)).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(portal(new URL(`${API}/auth/v1/user`))).rejects.toBeInstanceOf(TypeError);
    await expect(
      portal(new Request(`${API}/auth/v1/logout`, { method: 'POST' })),
    ).rejects.toBeInstanceOf(TypeError);

    const blocked = createGuardedFetch(
      API,
      respond('Forbidden', { status: 403, headers: { 'content-type': 'text/plain' } }),
    );
    await expect(blocked(`${API}/auth/v1/token?grant_type=refresh_token`)).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it('accepts empty answers (204 from logout)', async () => {
    const logout = createGuardedFetch(API, () =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    expect((await logout(`${API}/auth/v1/logout?scope=local`)).status).toBe(204);
  });

  it('leaves every other endpoint alone', async () => {
    const html = respond('<html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    const guarded = createGuardedFetch(`${API}/`, html);
    expect((await guarded(`${API}/rest/v1/rpc/my_context`)).status).toBe(200);
    expect((await guarded(`${API}/storage/v1/object/photos/x.webp`)).status).toBe(200);
    expect((await guarded('https://tiles.example.org/eafrica.pmtiles')).status).toBe(200);
  });

  it('forwards the request unchanged and propagates real network errors', async () => {
    const base = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() =>
      Promise.reject(new TypeError('Failed to fetch')),
    );
    const guarded = createGuardedFetch(API, base);
    const init = { method: 'POST', body: '{}' };
    await expect(guarded(`${API}/auth/v1/otp`, init)).rejects.toThrow('Failed to fetch');
    expect(base).toHaveBeenCalledWith(`${API}/auth/v1/otp`, init);
  });
});

describe('magic-link detection', () => {
  it('recognises an implicit-flow callback', () => {
    expect(
      urlHasAuthCallback(
        'https://app.example.org/#access_token=a.b.c&refresh_token=r&type=magiclink',
      ),
    ).toBe(true);
    expect(
      urlHasAuthCallback(
        'https://app.example.org/#error=access_denied&error_code=otp_expired&error_description=expired',
      ),
    ).toBe(true);
    expect(urlHasAuthCallback('https://app.example.org/?error_description=x')).toBe(true);
  });

  it('ignores ordinary addresses', () => {
    expect(urlHasAuthCallback('https://app.example.org/projects/123')).toBe(false);
    expect(urlHasAuthCallback('https://app.example.org/#section')).toBe(false);
    expect(urlHasAuthCallback('https://app.example.org/?q=access_token')).toBe(false);
    expect(urlHasAuthCallback('not a url')).toBe(false);
  });
});

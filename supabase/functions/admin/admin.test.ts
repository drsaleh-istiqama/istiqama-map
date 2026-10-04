import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeApi, jsonResponse, nextUserId, pgError, userToken } from '../_shared/fake-api.ts';
import { handler } from './index.ts';

const SERVICE_KEY = 'service-role-key-for-tests';
const TARGET = '0198a8b0-0000-7000-8000-00000000beef';

let api: FakeApi;
let token = '';

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'http://api.test');
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
  vi.stubEnv('AUTH_LOGOUT_RPC', '');
  api = new FakeApi();
  vi.stubGlobal('fetch', api.fetch);
  token = userToken(nextUserId(), { aal: 'aal2' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function post(body: unknown): Promise<Response> {
  return handler(
    new Request('http://fn.test/admin', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-device-id': 'admin-device',
      },
      body: JSON.stringify(body),
    }),
  );
}

/** Every request that carried the service-role key. */
function serviceCalls(): string[] {
  return api.calls.filter((c) => c.bearer() === SERVICE_KEY).map((c) => `${c.method} ${c.path}`);
}

const LOGOUT_PATH = `/auth/v1/admin/users/${TARGET}/logout`;
const END_SESSIONS_RPC = '/rest/v1/rpc/admin_end_auth_sessions';
const notInstalled = (): Response =>
  pgError(404, 'PGRST202', 'Could not find the function public.admin_end_auth_sessions');

describe('revoke_sessions', () => {
  it('the database decides with the caller token, then the Auth half runs with the service key', async () => {
    api
      .on('POST', '/rest/v1/rpc/admin_revoke_sessions', (req) => {
        expect(req.bearer()).toBe(token);
        expect(req.headers.get('x-device-id')).toBe('admin-device');
        return jsonResponse({
          user_id: TARGET,
          device_id: null,
          scope: 'user',
          revoked_at: '2026-10-04T00:00:00Z',
          auth_logout_required: true,
        });
      })
      .on('POST', END_SESSIONS_RPC, notInstalled())
      .on('POST', LOGOUT_PATH, new Response(null, { status: 204 }));

    const res = await post({ action: 'revoke_sessions', user_id: TARGET });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      user_id: TARGET,
      scope: 'user',
      auth_logout_required: true,
      auth_logout: { done: true, method: 'admin_endpoint' },
    });

    expect(api.rpcCalls('admin_revoke_sessions')[0]!.json()).toEqual({
      p_user_id: TARGET,
      p_device_id: null,
    });
    // order: authorisation by the database first, the service role only afterwards
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /rest/v1/rpc/admin_revoke_sessions',
      `POST ${END_SESSIONS_RPC}`,
      `POST ${LOGOUT_PATH}`,
    ]);
    expect(serviceCalls()).toEqual([`POST ${END_SESSIONS_RPC}`, `POST ${LOGOUT_PATH}`]);
    expect(api.callsTo('POST', LOGOUT_PATH)[0]!.headers.get('apikey')).toBe(SERVICE_KEY);
  });

  it('passes the device id and prefers the portable SQL function when it is installed', async () => {
    api
      .on('POST', '/rest/v1/rpc/admin_revoke_sessions', (req) =>
        jsonResponse({
          user_id: TARGET,
          device_id: req.json<{ p_device_id: string }>().p_device_id,
          scope: 'device',
          auth_logout_required: true,
        }),
      )
      .on('POST', END_SESSIONS_RPC, new Response(null, { status: 204 }));

    const res = await post({ action: 'revoke_sessions', user_id: TARGET, device_id: 'phone-1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      device_id: 'phone-1',
      scope: 'device',
      auth_logout: { done: true, method: 'rpc' },
    });
    expect(api.rpcCalls('admin_end_auth_sessions')[0]!.json()).toEqual({ p_user_id: TARGET });
    expect(api.callsTo('POST', LOGOUT_PATH)).toHaveLength(0); // the local-only endpoint is not needed
  });

  it('reports done:false (and still answers 200) when no way to end Auth sessions exists', async () => {
    api
      .on(
        'POST',
        '/rest/v1/rpc/admin_revoke_sessions',
        jsonResponse({ user_id: TARGET, auth_logout_required: true }),
      )
      .on('POST', END_SESSIONS_RPC, notInstalled())
      .on('POST', LOGOUT_PATH, jsonResponse({ code: 404, msg: 'Not Found' }, 404));

    const res = await post({ action: 'revoke_sessions', user_id: TARGET });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      auth_logout: { done: boolean; method: null; detail: string };
    };
    expect(body.auth_logout.done).toBe(false);
    expect(body.auth_logout.method).toBeNull();
    expect(body.auth_logout.detail).toContain('admin_end_auth_sessions is not installed');
    expect(body.auth_logout.detail).toContain('404');
  });

  it('never touches the service role when the database refuses the action', async () => {
    api.on(
      'POST',
      '/rest/v1/rpc/admin_revoke_sessions',
      pgError(403, 'PT403', 'forbidden', 'Only administrators may revoke sessions.'),
    );
    const res = await post({ action: 'revoke_sessions', user_id: TARGET });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      code: 'PT403',
      message: 'forbidden',
      details: 'Only administrators may revoke sessions.',
      hint: null,
    });
    expect(api.calls).toHaveLength(1);
    expect(serviceCalls()).toEqual([]);
  });

  it('skips the Auth half when the result does not ask for it', async () => {
    api.on(
      'POST',
      '/rest/v1/rpc/admin_revoke_sessions',
      jsonResponse({ user_id: TARGET, auth_logout_required: false }),
    );
    const res = await post({ action: 'revoke_sessions', user_id: TARGET });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).not.toHaveProperty('auth_logout');
    expect(serviceCalls()).toEqual([]);
  });
});

describe('set_user_active', () => {
  it('deactivation ends the Auth sessions and bans the account; reactivation lifts the ban', async () => {
    const bans: string[] = [];
    api
      .on('POST', '/rest/v1/rpc/admin_set_user_active', (req) => {
        const active = req.json<{ p_active: boolean }>().p_active;
        return jsonResponse({
          user_id: TARGET,
          active,
          changed: true,
          auth_logout_required: !active,
        });
      })
      .on('POST', END_SESSIONS_RPC, new Response(null, { status: 204 }))
      .on('PUT', `/auth/v1/admin/users/${TARGET}`, (req) => {
        expect(req.bearer()).toBe(SERVICE_KEY);
        bans.push(req.json<{ ban_duration: string }>().ban_duration);
        return jsonResponse({ id: TARGET, aud: 'authenticated', role: 'authenticated' });
      });

    const off = await post({ action: 'set_user_active', user_id: TARGET, active: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({
      active: false,
      auth_logout: { done: true, method: 'rpc' },
      auth_ban: { done: true, banned: true },
    });

    const on = await post({ action: 'set_user_active', user_id: TARGET, active: true });
    expect(on.status).toBe(200);
    const onBody = (await on.json()) as Record<string, unknown>;
    expect(onBody).toMatchObject({ active: true, auth_ban: { done: true, banned: false } });
    expect(onBody).not.toHaveProperty('auth_logout');

    expect(bans).toEqual(['876000h', 'none']);
    expect(api.rpcCalls('admin_end_auth_sessions')).toHaveLength(1); // only for the deactivation
  });
});

describe('other actions and validation', () => {
  it('restore_device / set_role / remove_role go to their RPC with the caller token only', async () => {
    api
      .on('POST', '/rest/v1/rpc/admin_restore_device', jsonResponse({ restored: true }))
      .on('POST', '/rest/v1/rpc/admin_set_role', jsonResponse({ created: true }))
      .on('POST', '/rest/v1/rpc/admin_remove_role', jsonResponse({ removed: true }));
    const scope = '0198a8b0-0000-7000-8000-0000000000aa';
    const role = '0198a8b0-0000-7000-8000-0000000000bb';

    expect(
      (await post({ action: 'restore_device', user_id: TARGET, device_id: 'phone-1' })).status,
    ).toBe(200);
    expect(
      (
        await post({
          action: 'set_role',
          user_id: TARGET,
          role: 'field_collector',
          scope_type: 'branch',
          scope_id: scope,
        })
      ).status,
    ).toBe(200);
    expect((await post({ action: 'remove_role', role_id: role })).status).toBe(200);

    expect(api.rpcCalls('admin_restore_device')[0]!.json()).toEqual({
      p_user_id: TARGET,
      p_device_id: 'phone-1',
    });
    expect(api.rpcCalls('admin_set_role')[0]!.json()).toEqual({
      p_user_id: TARGET,
      p_role: 'field_collector',
      p_scope_type: 'branch',
      p_scope_id: scope,
    });
    expect(api.rpcCalls('admin_remove_role')[0]!.json()).toEqual({ p_role_id: role });
    expect(api.calls.every((c) => c.bearer() === token)).toBe(true);
  });

  it('refuses malformed requests before any request is made', async () => {
    const cases: Array<[unknown, string]> = [
      [{}, 'invalid_action'],
      [{ action: 'drop_everything' }, 'invalid_action'],
      [{ action: 'revoke_sessions', user_id: 'not-a-uuid' }, 'invalid_argument'],
      [{ action: 'set_user_active', user_id: TARGET, active: 'no' }, 'invalid_argument'],
      [{ action: 'restore_device', user_id: TARGET }, 'invalid_argument'],
      [
        {
          action: 'set_role',
          user_id: TARGET,
          role: 'viewer',
          scope_type: 'branch',
          scope_id: 'x',
        },
        'invalid_argument',
      ],
    ];
    for (const [body, message] of cases) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(((await res.json()) as { message: string }).message).toBe(message);
    }
    expect(api.calls).toHaveLength(0);
  });

  it('requires a signed-in user and POST', async () => {
    const anon = await handler(
      new Request('http://fn.test/admin', { method: 'POST', body: '{"action":"remove_role"}' }),
    );
    expect(anon.status).toBe(401);
    const get = await handler(
      new Request('http://fn.test/admin', { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(get.status).toBe(405);
    expect(api.calls).toHaveLength(0);
  });
});

describe('create_user', () => {
  const NEW_ID = '0198a8b0-0000-7000-8000-00000000c0de';

  it('is reserved for hq_admin at aal2: nothing is created otherwise', async () => {
    api.on(
      'POST',
      '/rest/v1/rpc/my_context',
      jsonResponse({ capabilities: { is_hq: false }, mfa_required: true }),
    );
    const res = await post({
      action: 'create_user',
      email: 'new@example.org',
      full_name: 'New User',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toBe('mfa_required');
    expect(serviceCalls()).toEqual([]);
  });

  it('creates the Auth user (service), the profile and the grant (caller token)', async () => {
    api
      .on('POST', '/rest/v1/rpc/my_context', jsonResponse({ capabilities: { is_hq: true } }))
      .on('POST', '/auth/v1/admin/users', (req) => {
        expect(req.json()).toMatchObject({
          email: 'new@example.org',
          email_confirm: true,
          user_metadata: { full_name: 'مستخدم جديد' },
        });
        return jsonResponse({ id: NEW_ID, email: 'new@example.org', aud: 'authenticated' });
      })
      .on('POST', '/rest/v1/profiles', (req) => {
        expect(req.bearer()).toBe(token);
        // .single() asks PostgREST for one object
        return jsonResponse(
          {
            id: NEW_ID,
            full_name: 'مستخدم جديد',
            phone: null,
            preferred_language: 'sw',
            active: true,
          },
          201,
        );
      })
      .on('POST', '/rest/v1/rpc/admin_set_role', jsonResponse({ id: 'grant-1', created: true }));

    const res = await post({
      action: 'create_user',
      email: ' New@Example.org ',
      full_name: 'مستخدم جديد',
      preferred_language: 'sw',
      role: 'viewer',
      scope_type: 'global',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      user_id: NEW_ID,
      email: 'new@example.org',
      profile: { id: NEW_ID, preferred_language: 'sw' },
      role: { created: true },
      role_error: null,
    });
    expect(serviceCalls()).toEqual(['POST /auth/v1/admin/users']);
    expect(api.rpcCalls('admin_set_role')[0]!.bearer()).toBe(token);
  });

  it('takes the Auth user back when the profile cannot be written', async () => {
    api
      .on('POST', '/rest/v1/rpc/my_context', jsonResponse({ capabilities: { is_hq: true } }))
      .on('POST', '/auth/v1/admin/users', jsonResponse({ id: NEW_ID, aud: 'authenticated' }))
      .on(
        'POST',
        '/rest/v1/profiles',
        pgError(403, '42501', 'new row violates row-level security policy'),
      )
      .on('DELETE', `/auth/v1/admin/users/${NEW_ID}`, jsonResponse({ id: NEW_ID }));
    const res = await post({ action: 'create_user', phone: '+255 700 000 009', full_name: 'X' });
    expect(res.status).toBe(403);
    expect(serviceCalls()).toEqual([
      'POST /auth/v1/admin/users',
      `DELETE /auth/v1/admin/users/${NEW_ID}`,
    ]);
  });

  it('an existing e-mail is a 409 user_exists', async () => {
    api.on('POST', '/rest/v1/rpc/my_context', jsonResponse({ capabilities: { is_hq: true } })).on(
      'POST',
      '/auth/v1/admin/users',
      jsonResponse(
        {
          code: 'email_exists',
          message: 'A user with this email address has already been registered',
        },
        422,
        { 'x-supabase-api-version': '2024-01-01' },
      ),
    );
    const res = await post({ action: 'create_user', email: 'dup@example.org', full_name: 'Dup' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toBe('user_exists');
  });
});

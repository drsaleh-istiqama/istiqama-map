/**
 * Server calls of the console with a mocked transport / supabase client: RPC names and
 * arguments, the admin Edge Function bodies, optimistic updates, offline refusal and the
 * syncNow after a change of a synced reference table.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(async (_fn: string, _args?: Record<string, unknown>): Promise<unknown> => ({})),
  syncNow: vi.fn(async () => undefined),
  invoke: vi.fn(
    async (
      _name: string,
      _opts: { body: unknown },
    ): Promise<{ data: unknown; error: unknown }> => ({
      data: {},
      error: null,
    }),
  ),
  loadAppSettings: vi.fn(async () => undefined),
  refreshContext: vi.fn(async () => undefined),
  calls: [] as Array<{ table: string; op: string; args: unknown[] }>,
  result: { data: null as unknown, error: null as unknown, status: 200 },
}));

/** Chainable PostgREST builder that records every call and resolves to `mocks.result`. */
function builder(table: string): unknown {
  const record =
    (op: string) =>
    (...args: unknown[]) => {
      mocks.calls.push({ table, op, args });
      return proxy;
    };
  const target = {
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(mocks.result).then(resolve, reject),
  };
  const proxy: unknown = new Proxy(target, {
    get: (t, prop: string) => (prop === 'then' ? t.then : record(prop)),
  });
  return proxy;
}

vi.mock('../auth', () => ({
  supabase: {
    functions: { invoke: mocks.invoke },
    from: (table: string) => builder(table),
  },
  refreshContext: mocks.refreshContext,
}));

vi.mock('../sync', async () => {
  const errors = await import('../sync/errors');
  return { transport: { rpc: mocks.rpc }, syncNow: mocks.syncNow, isSyncError: errors.isSyncError };
});

vi.mock('../ui', () => ({ loadAppSettings: mocks.loadAppSettings }));

import {
  createUser,
  insertRow,
  listUsers,
  loadSyncStatus,
  removeRole,
  restoreDevice,
  revokeSessions,
  setRole,
  setUserActive,
  softDeleteRow,
  updateRow,
} from './api';
import { AdminError, adminErrorKey } from './errors';

function setOnline(online: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
}

beforeEach(() => {
  setOnline(true);
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({});
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue({ data: {}, error: null });
  mocks.syncNow.mockClear();
  mocks.loadAppSettings.mockClear();
  mocks.calls = [];
  mocks.result = { data: null, error: null, status: 200 };
});

afterEach(() => setOnline(true));

describe('admin RPCs (people-admin.md §6–7)', () => {
  it('admin_users with the largest page and no server-side search', async () => {
    mocks.rpc.mockResolvedValueOnce([{ id: 'u1' }]);
    expect(await listUsers()).toEqual([{ id: 'u1' }]);
    expect(mocks.rpc).toHaveBeenCalledWith('admin_users', { p_search: null, p_limit: 5000 });
  });

  it('admin_set_role: a global scope sends a null scope id', async () => {
    await setRole('u1', 'hq_admin', 'global', 'ignored');
    expect(mocks.rpc).toHaveBeenLastCalledWith('admin_set_role', {
      p_user_id: 'u1',
      p_role: 'hq_admin',
      p_scope_type: 'global',
      p_scope_id: null,
    });
    await setRole('u1', 'field_collector', 'branch', 'b1');
    expect(mocks.rpc).toHaveBeenLastCalledWith('admin_set_role', {
      p_user_id: 'u1',
      p_role: 'field_collector',
      p_scope_type: 'branch',
      p_scope_id: 'b1',
    });
  });

  it('admin_remove_role, admin_restore_device and sync_status', async () => {
    await removeRole('g1');
    expect(mocks.rpc).toHaveBeenLastCalledWith('admin_remove_role', { p_role_id: 'g1' });
    await restoreDevice('u1', 'dev-1');
    expect(mocks.rpc).toHaveBeenLastCalledWith('admin_restore_device', {
      p_user_id: 'u1',
      p_device_id: 'dev-1',
    });
    await loadSyncStatus();
    expect(mocks.rpc).toHaveBeenLastCalledWith('sync_status', {});
  });

  it('nothing is requested offline', async () => {
    setOnline(false);
    await expect(listUsers()).rejects.toMatchObject({ kind: 'network', code: 'offline' });
    await expect(revokeSessions('u1')).rejects.toBeInstanceOf(AdminError);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe('admin Edge Function (refresh tokens are ended too)', () => {
  it('revoke_sessions for a user and for one device', async () => {
    mocks.invoke.mockResolvedValueOnce({
      data: { scope: 'user', auth_logout: { done: true } },
      error: null,
    });
    const r = await revokeSessions('u1');
    expect(r.auth_logout?.done).toBe(true);
    expect(mocks.invoke).toHaveBeenLastCalledWith('admin', {
      body: { action: 'revoke_sessions', user_id: 'u1' },
    });
    await revokeSessions('u1', 'dev-1');
    expect(mocks.invoke).toHaveBeenLastCalledWith('admin', {
      body: { action: 'revoke_sessions', user_id: 'u1', device_id: 'dev-1' },
    });
  });

  it('set_user_active goes through the function (Auth ban)', async () => {
    await setUserActive('u1', false);
    expect(mocks.invoke).toHaveBeenLastCalledWith('admin', {
      body: { action: 'set_user_active', user_id: 'u1', active: false },
    });
  });

  it('create_user sends only what was given', async () => {
    await createUser({
      email: 'a@b.org',
      phone: null,
      full_name: 'A',
      preferred_language: 'sw',
      role: 'branch_supervisor',
      scope_type: 'branch',
      scope_id: 'b1',
    });
    expect(mocks.invoke).toHaveBeenLastCalledWith('admin', {
      body: {
        action: 'create_user',
        full_name: 'A',
        preferred_language: 'sw',
        email: 'a@b.org',
        role: 'branch_supervisor',
        scope_type: 'branch',
        scope_id: 'b1',
      },
    });
    await createUser({
      email: null,
      phone: '+255712345678',
      full_name: 'B',
      preferred_language: 'ar',
      role: null,
      scope_type: null,
      scope_id: null,
    });
    expect(mocks.invoke).toHaveBeenLastCalledWith('admin', {
      body: {
        action: 'create_user',
        full_name: 'B',
        preferred_language: 'ar',
        phone: '+255712345678',
      },
    });
  });

  it('turns an HTTP error body into a translated code', async () => {
    const response = new Response(
      JSON.stringify({ code: 'PT409', message: 'last_hq_admin', details: null }),
      { status: 409 },
    );
    mocks.invoke.mockResolvedValueOnce({
      data: null,
      error: Object.assign(new Error('x'), { name: 'FunctionsHttpError', context: response }),
    });
    const error = await setUserActive('u1', false).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'conflict', code: 'last_hq_admin', status: 409 });
    expect(adminErrorKey(error)).toBe('admin.err_last_hq_admin');
  });

  it('a relay or fetch failure is a server / network error', async () => {
    mocks.invoke.mockResolvedValueOnce({
      data: null,
      error: Object.assign(new Error('relay'), { name: 'FunctionsRelayError' }),
    });
    await expect(revokeSessions('u1')).rejects.toMatchObject({ kind: 'server' });
    mocks.invoke.mockResolvedValueOnce({
      data: null,
      error: Object.assign(new Error('fetch'), { name: 'FunctionsFetchError' }),
    });
    await expect(revokeSessions('u1')).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('reference tables (direct PostgREST, RLS decides)', () => {
  it('insert of a synced table pulls it to this device', async () => {
    mocks.result = { data: { id: 'c1' }, error: null, status: 201 };
    await insertRow('countries', { iso2: 'SS' });
    expect(mocks.calls.map((c) => `${c.table}.${c.op}`)).toEqual([
      'countries.insert',
      'countries.select',
      'countries.single',
    ]);
    expect(mocks.calls[0]!.args[0]).toEqual({ iso2: 'SS' });
    expect(mocks.syncNow).toHaveBeenCalledTimes(1);
    expect(mocks.loadAppSettings).not.toHaveBeenCalled();
  });

  it('app_settings is not synced: the settings cache is refreshed instead', async () => {
    mocks.result = { data: { id: 's1', version: 2 }, error: null, status: 200 };
    await updateRow('app_settings', { id: 's1', version: 1 }, { value: 200 });
    expect(mocks.syncNow).not.toHaveBeenCalled();
    expect(mocks.loadAppSettings).toHaveBeenCalledTimes(1);
  });

  it('an update is conditional on the version it was based on', async () => {
    mocks.result = { data: { id: 'o1', version: 4 }, error: null, status: 200 };
    await softDeleteRow('option_values', { id: 'o1', version: 3 });
    const ops = mocks.calls.map((c) => [c.op, ...c.args]);
    expect(ops[0]![0]).toBe('update');
    expect(typeof (ops[0]![1] as { deleted_at: string }).deleted_at).toBe('string');
    expect(ops).toContainEqual(['eq', 'id', 'o1']);
    expect(ops).toContainEqual(['eq', 'version', 3]);
    expect(mocks.syncNow).toHaveBeenCalled();
  });

  it('no row back means somebody changed it meanwhile', async () => {
    mocks.result = { data: null, error: null, status: 200 };
    const error = await updateRow('countries', { id: 'c1', version: 1 }, { active: false }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ kind: 'conflict', code: 'stale' });
    expect(adminErrorKey(error)).toBe('admin.err_stale');
    expect(mocks.syncNow).not.toHaveBeenCalled();
  });

  it('a duplicate key is reported as such', async () => {
    mocks.result = {
      data: null,
      error: { code: '23505', message: 'duplicate key value' },
      status: 409,
    };
    const error = await insertRow('countries', { iso2: 'TZ' }).catch((e: unknown) => e);
    expect(adminErrorKey(error)).toBe('admin.err_duplicate');
  });
});

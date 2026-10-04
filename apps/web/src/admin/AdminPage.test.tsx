/**
 * The administration console end to end inside the page, with the server replaced by the
 * replaceable ports of ./api: role gating, users (guards, revoke, roles), the reference forms
 * (validation, writes, close guard) and the sync status board (ordering, auto refresh).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
}));

vi.mock('../auth', async () => {
  const { signal, computed } = await import('@preact/signals');
  const fixtures = await import('../auth/__fixtures__/myContext');
  const caps = signal({ admin: true, manage: true });
  return {
    me: signal(fixtures.hqAdminAal2),
    can: {
      write: computed(() => true),
      review: computed(() => true),
      seePeople: computed(() => true),
      seeRestricted: computed(() => true),
      admin: computed(() => caps.value.admin),
      manage: computed(() => caps.value.manage),
    },
    supabase: {},
    refreshContext: async () => undefined,
    toE164: (raw: string) => raw.replace(/[^\d+]/g, '').replace(/^00/, '+'),
    __caps: caps,
  };
});

vi.mock('../sync', async () => {
  const errors = await import('../sync/errors');
  return {
    transport: { rpc: vi.fn() },
    syncNow: vi.fn(async () => undefined),
    isSyncError: errors.isSyncError,
  };
});

vi.mock('../ui', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, toast: mocks.toast };
});

import * as auth from '../auth';
import * as fixtures from '../auth/__fixtures__/myContext';
import { applyServerRows } from '../db';
import { freshDb, serverRow } from '../db/testing/factory';
import { t } from '../i18n';
import { navigate } from '../routes';
import AdminPage, { parseAdminPath, tabsFor } from './AdminPage';
import { resetAdminPorts, setAdminPorts, type AdminPorts } from './api';
import { AdminError } from './errors';
import type {
  AdminRole,
  AdminUser,
  CountryRec,
  FxRateRec,
  OptionRec,
  SettingRec,
  SyncStatusReport,
} from './types';

const caps = (auth as unknown as { __caps: { value: { admin: boolean; manage: boolean } } }).__caps;

const ME = fixtures.hqAdminAal2.user_id;
const TZ = 'e2a6484f-39a5-3135-816a-03ad934d99fd';
const PEMBA = '58372685-bb04-3409-b7fa-17b08890ee4a';
const U_COL = '0190c000-0000-7000-8000-000000000001';
const U_MGR = '0190c000-0000-7000-8000-000000000002';
const std = {
  version: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  deleted_at: null,
};

function grant(
  id: string,
  role: AdminRole['role'],
  scope_type: AdminRole['scope_type'],
  scope_id: string | null,
  name = '',
): AdminRole {
  return {
    id,
    role,
    scope_type,
    scope_id,
    scope_name_ar: name || null,
    scope_name_en: null,
    scope_name_sw: null,
    country_id: TZ,
    created_at: '',
  };
}

function adminUser(
  id: string,
  name: string,
  roles: AdminRole[],
  patch: Partial<AdminUser> = {},
): AdminUser {
  return {
    id,
    full_name: name,
    email: `${id.slice(-4)}@example.org`,
    phone: null,
    preferred_language: 'ar',
    active: true,
    sessions_revoked_at: null,
    created_at: '2026-01-01T00:00:00Z',
    last_sign_in_at: null,
    roles,
    devices: [],
    ...patch,
  };
}

const USERS: AdminUser[] = [
  adminUser(ME, 'المدير العام', [grant('g-hq', 'hq_admin', 'global', null)]),
  adminUser(
    U_COL,
    'جامع بيمبا',
    [grant('g-col', 'field_collector', 'branch', PEMBA, 'فرع بيمبا')],
    {
      devices: [
        {
          id: 'd1',
          device_id: 'dev-phone-1',
          label: 'Tecno',
          user_agent: null,
          app_version: '3.0.0',
          last_seen_at: '2026-10-03T08:00:00Z',
          last_push_at: null,
          last_pull_at: null,
          pending_ops: 2,
          pending_photos: 0,
          revoked_at: null,
        },
      ],
    },
  ),
  adminUser(U_MGR, 'مدير تنزانيا', [grant('g-mgr', 'country_manager', 'country', TZ, 'تنزانيا')]),
];

const COUNTRY_TZ: CountryRec = {
  ...std,
  id: TZ,
  iso2: 'TZ',
  iso3: 'TZA',
  name_ar: 'تنزانيا',
  name_en: 'Tanzania',
  name_sw: 'Tanzania',
  default_currency: 'TZS',
  active: true,
};

interface Server {
  rpc: ReturnType<typeof vi.fn>;
  invoke: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  tables: Record<string, unknown[]>;
}

let server: Server;

function installServer(users: AdminUser[] = USERS, status?: SyncStatusReport): void {
  server = {
    tables: {
      countries: [COUNTRY_TZ],
      branches: [],
      option_values: [] as OptionRec[],
      fx_rates: [] as FxRateRec[],
      app_settings: [] as SettingRec[],
      map_packs: [],
    },
    rpc: vi.fn(async (fn: string) => {
      if (fn === 'admin_users') return users;
      if (fn === 'sync_status') return status;
      if (fn === 'admin_set_role') return { id: 'g-new', created: true };
      return {};
    }),
    invoke: vi.fn(async () => ({
      auth_logout_required: true,
      auth_logout: { done: true, method: 'rpc' },
    })),
    insert: vi.fn(async (_table: string, row: Record<string, unknown>) => ({
      ...std,
      id: 'new',
      ...row,
    })),
    update: vi.fn(
      async (_table: string, id: string, version: number, patch: Record<string, unknown>) => ({
        ...std,
        id,
        version: version + 1,
        ...patch,
      }),
    ),
  };
  const ports: Partial<AdminPorts> = {
    rpc: server.rpc as AdminPorts['rpc'],
    invoke: server.invoke as AdminPorts['invoke'],
    select: (async (table: string) => server.tables[table] ?? []) as AdminPorts['select'],
    insert: server.insert as AdminPorts['insert'],
    update: server.update as AdminPorts['update'],
    syncNow: async () => undefined,
    refreshSettings: async () => undefined,
    refreshContext: async () => undefined,
    online: () => navigator.onLine !== false,
  };
  setAdminPorts(ports);
}

function setOnline(online: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
}

function open(path: string): void {
  navigate(path, { replace: true });
  render(<AdminPage />);
}

const type = (el: HTMLElement, value: string) => fireEvent.input(el, { target: { value } });
const choose = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const errorOf = (testId: string) => {
  const control = screen.getByTestId(testId);
  return control.closest('.field')?.querySelector('.field__error')?.textContent ?? null;
};

beforeEach(async () => {
  setOnline(true);
  caps.value = { admin: true, manage: true };
  auth.me.value = fixtures.hqAdminAal2;
  mocks.toast.mockClear();
  await freshDb({ canSeeRestricted: true });
  await applyServerRows('countries', [
    serverRow('countries', {
      id: TZ,
      iso2: 'TZ',
      iso3: 'TZA',
      name_ar: 'تنزانيا',
      name_en: 'Tanzania',
      active: true,
    }),
  ]);
  await applyServerRows('branches', [
    serverRow('branches', {
      id: PEMBA,
      country_id: TZ,
      code: 'PEMBA',
      name_ar: 'فرع بيمبا',
      admin_area_ids: [],
      active: true,
    }),
  ]);
  installServer();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  resetAdminPorts();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------

describe('routing helpers', () => {
  it('tabs per role and sub-paths', () => {
    expect(tabsFor({ admin: true, manage: true })).toHaveLength(8);
    expect(tabsFor({ admin: false, manage: true })).toEqual(['users', 'sync']);
    expect(tabsFor({ admin: false, manage: false })).toEqual([]);
    const all = tabsFor({ admin: true, manage: true });
    expect(parseAdminPath('', all)).toEqual({ tab: 'users', id: null });
    expect(parseAdminPath(`users/${U_COL.toUpperCase()}`, all)).toEqual({
      tab: 'users',
      id: U_COL,
    });
    expect(parseAdminPath('fx', all)).toEqual({ tab: 'fx', id: null });
    // A manager typing an HQ-only path lands on the users list.
    expect(parseAdminPath('countries', ['users', 'sync'])).toEqual({ tab: 'users', id: null });
  });
});

describe('role gating', () => {
  it('others never see the console and nothing is requested', async () => {
    caps.value = { admin: false, manage: false };
    auth.me.value = fixtures.supervisorPemba;
    open('/admin/users');
    expect(screen.getByTestId('admin-forbidden')).toBeTruthy();
    expect(screen.queryByTestId('admin-page')).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(server.rpc).not.toHaveBeenCalled();
  });

  it('head office sees every section', async () => {
    open('/admin');
    for (const tab of [
      'users',
      'countries',
      'branches',
      'options',
      'fx',
      'settings',
      'packs',
      'sync',
    ]) {
      expect(screen.getByTestId(`admin-tab-${tab}`)).toBeTruthy();
    }
    expect(screen.getByTestId('admin-tab-users').getAttribute('aria-current')).toBe('page');
    expect(await screen.findAllByTestId('admin-user-row')).toHaveLength(3);
    expect(screen.getByTestId('admin-user-create')).toBeTruthy();
  });

  it('a country manager gets users and sync status only, and may revoke but not change roles', async () => {
    caps.value = { admin: false, manage: true };
    auth.me.value = fixtures.managerTzAal2;
    open(`/admin/users/${U_COL}`);
    expect(screen.queryByTestId('admin-tab-countries')).toBeNull();
    expect(screen.getByTestId('admin-tab-sync')).toBeTruthy();
    expect(screen.getByTestId('admin-manager-note')).toBeTruthy();
    expect(screen.queryByTestId('admin-user-create')).toBeNull();
    const detail = await screen.findByTestId('admin-user-detail');
    expect(within(detail).getByTestId('admin-user-revoke')).toBeTruthy();
    expect(within(detail).getByTestId('admin-device-revoke')).toBeTruthy();
    expect(within(detail).queryByTestId('admin-user-add-role')).toBeNull();
    expect(within(detail).queryByTestId('admin-role-remove')).toBeNull();
    expect(within(detail).queryByTestId('admin-user-deactivate')).toBeNull();
  });

  it('offline: a banner and no request; loads when the connection is back', async () => {
    setOnline(false);
    open('/admin/users');
    expect(screen.getByTestId('admin-offline')).toBeTruthy();
    expect(await screen.findByTestId('admin-users-offline')).toBeTruthy();
    expect(server.rpc).not.toHaveBeenCalled();
    setOnline(true);
    window.dispatchEvent(new Event('online'));
    expect(await screen.findAllByTestId('admin-user-row')).toHaveLength(3);
  });
});

describe('users', () => {
  it('filters by text and role', async () => {
    open('/admin/users');
    await screen.findAllByTestId('admin-user-row');
    choose(screen.getByTestId('admin-users-role'), 'country_manager');
    await waitFor(() =>
      expect(screen.getAllByTestId('admin-user-row').map((r) => r.dataset.userId)).toEqual([U_MGR]),
    );
    choose(screen.getByTestId('admin-users-role'), '');
    type(screen.getByTestId('admin-users-search'), 'بيمبا');
    await waitFor(() =>
      expect(screen.getAllByTestId('admin-user-row').map((r) => r.dataset.userId)).toEqual([U_COL]),
    );
  });

  it('the last head-office administrator: role removal and deactivation are blocked with a reason', async () => {
    open(`/admin/users/${ME}`);
    const detail = await screen.findByTestId('admin-user-detail');
    expect(within(detail).getByTestId('admin-guard-last-hq').textContent).toBe(
      t('admin.guardLastHqRole'),
    );
    expect((within(detail).getByTestId('admin-role-remove') as HTMLButtonElement).disabled).toBe(
      true,
    );
    // Own account: the self rule is shown (it wins over the last-admin rule).
    expect(within(detail).getByTestId('admin-guard-self').textContent).toBe(t('admin.guardSelf'));
    expect(
      (within(detail).getByTestId('admin-user-deactivate') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('another administrator who is the only HQ cannot be deactivated', async () => {
    const other = '0190c000-0000-7000-8000-0000000000aa';
    installServer([
      adminUser(ME, 'أنا', [grant('g-v', 'viewer', 'global', null)]),
      adminUser(other, 'المسؤول الوحيد', [grant('g-hq2', 'hq_admin', 'global', null)]),
    ]);
    open(`/admin/users/${other}`);
    const detail = await screen.findByTestId('admin-user-detail');
    expect(within(detail).getByTestId('admin-guard-last-hq-user').textContent).toBe(
      t('admin.guardLastHqUser'),
    );
    expect(
      (within(detail).getByTestId('admin-user-deactivate') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('the server refusal is translated if the guard was bypassed (another admin changed meanwhile)', async () => {
    open(`/admin/users/${U_MGR}`);
    const detail = await screen.findByTestId('admin-user-detail');
    server.rpc.mockImplementation(async (fn: string) => {
      if (fn === 'admin_users') return USERS;
      throw new AdminError('conflict', 'last_hq_admin', 409);
    });
    fireEvent.click(within(detail).getByTestId('admin-role-remove'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(t('admin.err_last_hq_admin'), 'error'),
    );
  });

  it('revoking all sessions goes through the admin function after a confirmation', async () => {
    open(`/admin/users/${U_COL}`);
    const detail = await screen.findByTestId('admin-user-detail');
    fireEvent.click(within(detail).getByTestId('admin-user-revoke'));
    fireEvent.click(await screen.findByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(server.invoke).not.toHaveBeenCalled();

    fireEvent.click(within(detail).getByTestId('admin-user-revoke'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() =>
      expect(server.invoke).toHaveBeenCalledWith({ action: 'revoke_sessions', user_id: U_COL }),
    );
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(t('admin.revokedAll'), 'success'));
    // The list is reloaded after the change.
    expect(
      server.rpc.mock.calls.filter(([fn]) => fn === 'admin_users').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('warns when the refresh tokens could not be ended', async () => {
    server.invoke.mockResolvedValue({ auth_logout_required: true, auth_logout: { done: false } });
    open(`/admin/users/${U_COL}`);
    const detail = await screen.findByTestId('admin-user-detail');
    fireEvent.click(within(detail).getByTestId('admin-device-revoke'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() =>
      expect(server.invoke).toHaveBeenCalledWith({
        action: 'revoke_sessions',
        user_id: U_COL,
        device_id: 'dev-phone-1',
      }),
    );
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(t('admin.refreshNotRevoked'), 'error'),
    );
  });

  it('restores a blocked device and deactivates an account', async () => {
    const blocked = USERS.map((u) =>
      u.id === U_COL
        ? { ...u, devices: u.devices.map((d) => ({ ...d, revoked_at: '2026-10-03T09:00:00Z' })) }
        : u,
    );
    installServer(blocked);
    open(`/admin/users/${U_COL}`);
    const detail = await screen.findByTestId('admin-user-detail');
    expect(within(detail).getByTestId('admin-device-revoked')).toBeTruthy();
    fireEvent.click(within(detail).getByTestId('admin-device-restore'));
    await waitFor(() =>
      expect(server.rpc).toHaveBeenCalledWith('admin_restore_device', {
        p_user_id: U_COL,
        p_device_id: 'dev-phone-1',
      }),
    );
    fireEvent.click(within(detail).getByTestId('admin-user-deactivate'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() =>
      expect(server.invoke).toHaveBeenCalledWith({
        action: 'set_user_active',
        user_id: U_COL,
        active: false,
      }),
    );
  });

  it('assign a role: validation, scope picker, RPC', async () => {
    open(`/admin/users/${U_COL}`);
    const detail = await screen.findByTestId('admin-user-detail');
    fireEvent.click(within(detail).getByTestId('admin-user-add-role'));
    const dialog = await screen.findByTestId('admin-role-dialog');
    fireEvent.click(within(document.body).getByTestId('admin-role-save'));
    await waitFor(() => expect(errorOf('admin-role-role')).toBe(t('admin.v_required')));
    expect(server.rpc).not.toHaveBeenCalledWith('admin_set_role', expect.anything());

    // The same grant again is caught before the call.
    choose(within(dialog).getByTestId('admin-role-role'), 'field_collector');
    choose(within(dialog).getByTestId('admin-role-scope-type'), 'branch');
    await waitFor(() => expect(within(dialog).getByTestId('admin-role-scope')).toBeTruthy());
    await waitFor(() =>
      expect(
        [...(within(dialog).getByTestId('admin-role-scope') as HTMLSelectElement).options].map(
          (o) => o.value,
        ),
      ).toContain(PEMBA),
    );
    choose(within(dialog).getByTestId('admin-role-scope'), PEMBA);
    fireEvent.click(screen.getByTestId('admin-role-save'));
    await waitFor(() => expect(errorOf('admin-role-role')).toBe(t('admin.v_grant_exists')));

    // Country manager: the only scope type is chosen automatically; MFA note shown.
    choose(within(dialog).getByTestId('admin-role-role'), 'country_manager');
    expect((within(dialog).getByTestId('admin-role-scope-type') as HTMLSelectElement).value).toBe(
      'country',
    );
    expect(within(dialog).getByTestId('admin-role-mfa-note')).toBeTruthy();
    fireEvent.click(screen.getByTestId('admin-role-save'));
    await waitFor(() => expect(errorOf('admin-role-scope')).toBe(t('admin.v_required')));
    choose(within(dialog).getByTestId('admin-role-scope'), TZ);
    fireEvent.click(screen.getByTestId('admin-role-save'));
    await waitFor(() =>
      expect(server.rpc).toHaveBeenCalledWith('admin_set_role', {
        p_user_id: U_COL,
        p_role: 'country_manager',
        p_scope_type: 'country',
        p_scope_id: TZ,
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('admin-role-dialog')).toBeNull());
  });

  it('Esc never discards a started role choice without asking', async () => {
    open(`/admin/users/${U_COL}`);
    fireEvent.click(
      within(await screen.findByTestId('admin-user-detail')).getByTestId('admin-user-add-role'),
    );
    const dialog = await screen.findByTestId('admin-role-dialog');
    choose(within(dialog).getByTestId('admin-role-role'), 'viewer');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(await screen.findByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(screen.getByTestId('admin-role-dialog')).toBeTruthy();
    expect((within(dialog).getByTestId('admin-role-role') as HTMLSelectElement).value).toBe(
      'viewer',
    );
  });

  it('create an account through the admin function', async () => {
    server.invoke.mockResolvedValue({ user_id: 'new-user', role: null, role_error: null });
    open('/admin/users');
    fireEvent.click(await screen.findByTestId('admin-user-create'));
    await screen.findByTestId('admin-create-dialog');
    fireEvent.click(screen.getByTestId('admin-create-save'));
    await waitFor(() => expect(errorOf('admin-create-name')).toBe(t('admin.v_required')));
    expect(errorOf('admin-create-email')).toBe(t('admin.v_email_or_phone'));
    type(screen.getByTestId('admin-create-name'), 'أمينة سعيد');
    type(screen.getByTestId('admin-create-email'), USERS[1]!.email!);
    fireEvent.click(screen.getByTestId('admin-create-save'));
    await waitFor(() => expect(errorOf('admin-create-email')).toBe(t('admin.v_email_taken')));
    type(screen.getByTestId('admin-create-email'), 'Amina@Example.org');
    fireEvent.click(screen.getByTestId('admin-create-save'));
    await waitFor(() =>
      expect(server.invoke).toHaveBeenCalledWith({
        action: 'create_user',
        full_name: 'أمينة سعيد',
        preferred_language: 'ar',
        email: 'amina@example.org',
      }),
    );
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(t('admin.userCreated'), 'success'),
    );
  });
});

describe('reference forms (head office)', () => {
  it('add a country: validation, insert, and the close guard', async () => {
    open('/admin/countries');
    expect(await screen.findAllByTestId('admin-country-row')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('admin-country-add'));
    await screen.findByTestId('admin-country-dialog');
    fireEvent.click(screen.getByTestId('admin-country-save'));
    await waitFor(() => expect(errorOf('admin-country-iso2')).toBe(t('admin.v_required')));
    expect(server.insert).not.toHaveBeenCalled();

    type(screen.getByTestId('admin-country-iso2'), 'tz');
    type(screen.getByTestId('admin-country-iso3'), 'SSD');
    type(screen.getByTestId('admin-country-name-ar'), 'جنوب السودان');
    type(screen.getByTestId('admin-country-name-en'), 'South Sudan');
    type(screen.getByTestId('admin-country-currency'), 'ssp');
    fireEvent.click(screen.getByTestId('admin-country-save'));
    await waitFor(() =>
      expect(errorOf('admin-country-iso2')).toBe(t('admin.v_taken', { name: 'Tanzania' })),
    );

    // Esc with typed data asks first; "keep editing" keeps everything.
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(await screen.findByTestId('confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect((screen.getByTestId('admin-country-name-en') as HTMLInputElement).value).toBe(
      'South Sudan',
    );

    type(screen.getByTestId('admin-country-iso2'), 'ss');
    fireEvent.click(screen.getByTestId('admin-country-save'));
    await waitFor(() =>
      expect(server.insert).toHaveBeenCalledWith('countries', {
        iso2: 'SS',
        iso3: 'SSD',
        name_ar: 'جنوب السودان',
        name_en: 'South Sudan',
        name_sw: null,
        default_currency: 'SSP',
        active: true,
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('admin-country-dialog')).toBeNull());
  });

  it('a country with live branches is not deleted', async () => {
    server.tables.branches = [
      {
        ...std,
        id: PEMBA,
        country_id: TZ,
        code: 'PEMBA',
        name_ar: 'فرع بيمبا',
        name_en: null,
        name_sw: null,
        admin_area_ids: [],
        active: true,
      },
    ];
    open('/admin/countries');
    fireEvent.click(await screen.findByTestId('admin-country-delete'));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        t('admin.countryHasBranches', { count: 1 }),
        'error',
      ),
    );
    expect(server.update).not.toHaveBeenCalled();
  });

  it('add a branch: validation, areas from the searchable tree (a child of a chosen area is covered), insert', async () => {
    const REGION = '0190a000-0000-7000-8000-0000000000a1';
    const DISTRICT = '0190a000-0000-7000-8000-0000000000a2';
    const OTHER = '0190a000-0000-7000-8000-0000000000a3';
    server.tables.branches = [
      {
        ...std,
        id: PEMBA,
        country_id: TZ,
        code: 'PEMBA',
        name_ar: 'فرع بيمبا',
        name_en: null,
        name_sw: null,
        admin_area_ids: [],
        active: true,
      },
    ];
    server.tables.admin_areas = [
      {
        id: REGION,
        country_id: TZ,
        parent_id: null,
        level: 1,
        name_ar: 'زنجبار',
        name_en: 'Zanzibar',
        name_sw: 'Zanzibar',
        deleted_at: null,
      },
      {
        id: DISTRICT,
        country_id: TZ,
        parent_id: REGION,
        level: 2,
        name_ar: 'ويتي',
        name_en: 'Wete',
        name_sw: 'Wete',
        deleted_at: null,
      },
      {
        id: OTHER,
        country_id: TZ,
        parent_id: null,
        level: 1,
        name_ar: 'دار السلام',
        name_en: 'Dar es Salaam',
        name_sw: 'Dar es Salaam',
        deleted_at: null,
      },
    ];
    open('/admin/branches');
    expect(await screen.findAllByTestId('admin-branch-row')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('admin-branch-add'));
    await screen.findByTestId('admin-branch-dialog');
    fireEvent.click(screen.getByTestId('admin-branch-save'));
    await waitFor(() => expect(errorOf('admin-branch-country')).toBe(t('admin.v_required')));
    expect(server.insert).not.toHaveBeenCalled();

    choose(screen.getByTestId('admin-branch-country'), TZ);
    type(screen.getByTestId('admin-branch-code'), 'pemba');
    type(screen.getByTestId('admin-branch-name-ar'), 'فرع ويتي');
    // The tree comes from the server (this device has no areas of the country yet).
    const region = (await screen.findAllByTestId('admin-branch-areas-area')).find(
      (el) => el.dataset.areaId === REGION,
    )!;
    fireEvent.click(region);
    fireEvent.click(screen.getAllByTestId('admin-branch-areas-expand')[0]!);
    const district = (await screen.findAllByTestId('admin-branch-areas-area')).find(
      (el) => el.dataset.areaId === DISTRICT,
    )! as HTMLInputElement;
    expect(district.checked).toBe(true);
    expect(district.disabled).toBe(true);
    // Search finds the other region by name.
    type(screen.getByTestId('admin-branch-areas-search'), 'دار');
    const hit = (
      await screen.findAllByTestId('admin-branch-areas-hit', {}, { timeout: 2000 })
    ).find((el) => el.dataset.areaId === OTHER)!;
    fireEvent.click(hit);
    expect(screen.getAllByTestId('admin-branch-areas-chip')).toHaveLength(2);

    fireEvent.click(screen.getByTestId('admin-branch-save'));
    await waitFor(() => expect(errorOf('admin-branch-code')).not.toBeNull());
    expect(server.insert).not.toHaveBeenCalled();
    type(screen.getByTestId('admin-branch-code'), 'wete');
    fireEvent.click(screen.getByTestId('admin-branch-save'));
    await waitFor(() =>
      expect(server.insert).toHaveBeenCalledWith(
        'branches',
        expect.objectContaining({
          country_id: TZ,
          code: 'WETE',
          name_ar: 'فرع ويتي',
          admin_area_ids: [REGION, OTHER],
          active: true,
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByTestId('admin-branch-dialog')).toBeNull());
  });

  it('add an option value to a list with the next sort order', async () => {
    server.tables.option_values = [
      {
        ...std,
        id: 'o1',
        list_key: 'livelihoods',
        code: 'fishing',
        name_ar: 'صيد الأسماك',
        name_en: 'Fishing',
        name_sw: 'Uvuvi',
        sort_order: 20,
        active: true,
      },
      {
        ...std,
        id: 'o2',
        list_key: 'livelihoods',
        code: 'other',
        name_ar: 'أخرى',
        name_en: 'Other',
        name_sw: 'Nyingine',
        sort_order: 990,
        active: true,
      },
    ];
    open('/admin/options');
    await screen.findByTestId('admin-options');
    choose(screen.getByTestId('admin-options-list'), 'livelihoods');
    expect(await screen.findAllByTestId('admin-option-row')).toHaveLength(2);
    const other = screen
      .getAllByTestId('admin-option-row')
      .find((r) => r.dataset.code === 'other')!;
    expect((within(other).getByTestId('admin-option-delete') as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.click(screen.getByTestId('admin-option-add'));
    await screen.findByTestId('admin-option-dialog');
    expect((screen.getByTestId('admin-option-sort') as HTMLInputElement).value).toBe('30');
    type(screen.getByTestId('admin-option-code'), 'Fishing');
    type(screen.getByTestId('admin-option-name-ar'), 'تربية النحل');
    fireEvent.click(screen.getByTestId('admin-option-save'));
    await waitFor(() =>
      expect(errorOf('admin-option-code')).toBe(t('admin.v_taken', { name: 'صيد الأسماك' })),
    );
    type(screen.getByTestId('admin-option-code'), 'beekeeping');
    type(screen.getByTestId('admin-option-name-sw'), 'Ufugaji nyuki');
    fireEvent.click(screen.getByTestId('admin-option-save'));
    await waitFor(() =>
      expect(server.insert).toHaveBeenCalledWith(
        'option_values',
        expect.objectContaining({
          list_key: 'livelihoods',
          code: 'beekeeping',
          name_ar: 'تربية النحل',
          name_sw: 'Ufugaji nyuki',
          sort_order: 30,
        }),
      ),
    );
  });

  it('exchange rates: placeholder notice, clearing the flag, rate validation', async () => {
    server.tables.fx_rates = [
      { ...std, id: 'fx1', currency: 'TZS', usd_per_unit: 0.00038, effective_date: '2025-01-01' },
    ];
    server.tables.app_settings = [
      {
        ...std,
        id: 's-fx',
        key: 'fx.placeholder',
        value: { placeholder: true, effective_date: '2025-01-01' },
        description: null,
        is_public: true,
      },
    ];
    open('/admin/fx');
    expect(await screen.findByTestId('admin-fx-placeholder')).toBeTruthy();
    fireEvent.click(screen.getByTestId('admin-fx-clear'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() =>
      expect(server.update).toHaveBeenCalledWith('app_settings', 's-fx', 1, {
        value: expect.objectContaining({ placeholder: false, effective_date: '2025-01-01' }),
      }),
    );

    fireEvent.click(screen.getByTestId('admin-fx-add'));
    await screen.findByTestId('admin-fx-dialog');
    type(screen.getByTestId('admin-fx-currency'), 'TZS');
    type(screen.getByTestId('admin-fx-rate'), '-1');
    type(screen.getByTestId('admin-fx-date'), '2025-01-01');
    fireEvent.click(screen.getByTestId('admin-fx-save'));
    await waitFor(() => expect(errorOf('admin-fx-rate')).toBe(t('admin.v_rate')));
    expect(errorOf('admin-fx-date')).toBe(t('admin.v_rate_taken'));
    expect(server.insert).not.toHaveBeenCalled();
  });

  it('settings: range validation, then an update of the stored row', async () => {
    server.tables.app_settings = [
      {
        ...std,
        id: 's-r',
        key: 'duplicates.radius_m',
        value: 150,
        description: null,
        is_public: true,
      },
    ];
    open('/admin/settings');
    const input = await screen.findByTestId('admin-setting-duplicates-radius-m');
    type(input, '5');
    fireEvent.click(screen.getByTestId('admin-setting-duplicates-radius-m-save'));
    expect((await screen.findByTestId('admin-setting-duplicates-radius-m-error')).textContent).toBe(
      t('admin.v_range', { min: 10, max: 2000 }),
    );
    expect(server.update).not.toHaveBeenCalled();
    type(input, '200');
    fireEvent.click(screen.getByTestId('admin-setting-duplicates-radius-m-save'));
    await waitFor(() =>
      expect(server.update).toHaveBeenCalledWith('app_settings', 's-r', 1, { value: 200 }),
    );
    // A setting without a row is inserted as public.
    type(screen.getByTestId('admin-setting-gps-accuracy-warn-m'), '40');
    fireEvent.click(screen.getByTestId('admin-setting-gps-accuracy-warn-m-save'));
    await waitFor(() =>
      expect(server.insert).toHaveBeenCalledWith('app_settings', {
        key: 'gps.accuracy_warn_m',
        value: 40,
        is_public: true,
      }),
    );
  });

  it('map packs: the build command is shown, never run', async () => {
    open('/admin/packs');
    expect((await screen.findAllByTestId('admin-packs-command'))[0]!.textContent).toContain(
      'npm run pmtiles:build',
    );
    expect(await screen.findByTestId('admin-packs-empty')).toBeTruthy();
  });
});

describe('sync status board', () => {
  const device = (patch: Record<string, unknown>) => ({
    id: String(patch.device_id),
    device_id: 'd',
    label: null,
    user_agent: null,
    app_version: '3.0.0',
    last_seen_at: '2026-10-04T08:00:00Z',
    last_push_at: null,
    last_pull_at: null,
    pending_ops: 0,
    pending_photos: 0,
    open_conflicts: 0,
    rejected_7d: 0,
    stale: false,
    revoked_at: null,
    ...patch,
  });
  const user = (id: string, name: string, totals: Record<string, number>, devices: unknown[]) => ({
    user_id: id,
    full_name: name,
    active: true,
    roles: [{ role: 'field_collector', scope_type: 'branch', scope_id: PEMBA }],
    device_count: devices.length,
    pending_ops: 0,
    pending_photos: 0,
    open_conflicts: 0,
    rejected_7d: 0,
    last_seen_at: null,
    last_push_at: null,
    last_pull_at: null,
    devices,
    ...totals,
  });
  const report = {
    generated_at: '2026-10-04T09:00:00Z',
    scope: 'all',
    country_ids: null,
    window_days: 7,
    summary: {
      users: 3,
      users_without_device: 1,
      devices: 2,
      stale_devices: 0,
      pending_ops: 4,
      pending_photos: 0,
      open_conflicts: 1,
      rejected_7d: 0,
    },
    users: [
      user('u-none', 'Amina', {}, []),
      user('u-pending', 'Baraka', { pending_ops: 4 }, [device({ device_id: 'p', pending_ops: 4 })]),
      user('u-conflict', 'Zuhura', { open_conflicts: 1 }, [
        device({ device_id: 'c', open_conflicts: 1 }),
      ]),
    ],
  } as unknown as SyncStatusReport;

  it('attention first, filter, device details', async () => {
    installServer(USERS, report);
    open('/admin/sync');
    await screen.findAllByTestId('admin-sync-user');
    expect(screen.getAllByTestId('admin-sync-user').map((r) => r.dataset.userId)).toEqual([
      'u-conflict',
      'u-pending',
      'u-none',
    ]);
    expect(screen.getByTestId('admin-sync-tile-open_conflicts').className).toContain(
      'adm-tile--danger',
    );
    fireEvent.click(screen.getByTestId('admin-sync-attention-only'));
    await waitFor(() => expect(screen.getAllByTestId('admin-sync-user')).toHaveLength(2));
    fireEvent.click(within(screen.getAllByTestId('admin-sync-user')[0]!).getByRole('button'));
    expect((await screen.findAllByTestId('admin-sync-device'))[0]!.dataset.attention).toBe(
      'problems',
    );
  });

  it('refreshes every 60 s while visible', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installServer(USERS, report);
    open('/admin/sync');
    await screen.findAllByTestId('admin-sync-user');
    const calls = () => server.rpc.mock.calls.filter(([fn]) => fn === 'sync_status').length;
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => expect(calls()).toBe(2));
    // Hidden tab: no refresh.
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls()).toBe(2);
    // Visible again after a long pause: refreshed at once.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(calls()).toBe(3));
  });
});

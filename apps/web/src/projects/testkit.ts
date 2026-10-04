/**
 * Test doubles for the projects module (not imported by application code):
 *
 *   vi.mock('../auth', async () => (await import('./testkit')).authModule());
 *   vi.mock('../sync', async () => (await import('./testkit')).syncModule());
 *
 * `useRole()` switches the signed-in user's capabilities; `syncMocks` are the spies of the
 * sync module (`syncNow`, `transport.rpc`).
 */
import { computed, signal } from '@preact/signals';
import { vi } from 'vitest';
import { USER_A } from '../db/testing/factory';

export type TestRole =
  'viewer' | 'field_collector' | 'branch_supervisor' | 'country_manager' | 'hq_admin';

const CAPS: Record<
  TestRole,
  { write: boolean; review: boolean; seePeople: boolean; seeRestricted: boolean; admin: boolean }
> = {
  viewer: { write: false, review: false, seePeople: false, seeRestricted: false, admin: false },
  field_collector: {
    write: true,
    review: false,
    seePeople: true,
    seeRestricted: false,
    admin: false,
  },
  branch_supervisor: {
    write: true,
    review: true,
    seePeople: true,
    seeRestricted: false,
    admin: false,
  },
  country_manager: {
    write: true,
    review: true,
    seePeople: true,
    seeRestricted: true,
    admin: false,
  },
  hq_admin: { write: true, review: true, seePeople: true, seeRestricted: true, admin: true },
};

const role = signal<TestRole>('field_collector');
const userId = signal<string>(USER_A);

export function useRole(next: TestRole, user: string = USER_A): void {
  role.value = next;
  userId.value = user;
}

let auth: Record<string, unknown> | null = null;

export function authModule(): Record<string, unknown> {
  if (auth) return auth;
  const me = computed(() => ({
    user_id: userId.value,
    profile: {
      id: userId.value,
      full_name: 'Amina Juma',
      phone: null,
      preferred_language: 'ar',
      active: true,
    },
    roles: [{ role: role.value, scope_type: 'global', scope_id: null }],
  }));
  const flag = (k: keyof (typeof CAPS)['viewer']) => computed(() => CAPS[role.value][k]);
  auth = {
    me,
    session: computed(() => ({ user: { id: userId.value } })),
    can: {
      write: flag('write'),
      review: flag('review'),
      seePeople: flag('seePeople'),
      seeRestricted: flag('seeRestricted'),
      admin: flag('admin'),
      manage: flag('admin'),
    },
    supabase: {},
    deviceId: () => 'device-test-0001',
    pin: {
      isSet: async () => true,
      set: async () => undefined,
      unlock: async () => true,
      lock: () => undefined,
      locked: signal(false),
    },
    lockMinutes: signal(15),
    signOut: async () => undefined,
  };
  return auth;
}

export const syncMocks = {
  syncNow: vi.fn(async () => undefined),
  rpc: vi.fn(async (_fn: string, _args?: Record<string, unknown>): Promise<unknown> => []),
};

let sync: Record<string, unknown> | null = null;

export function syncModule(): Record<string, unknown> {
  if (sync) return sync;
  sync = {
    syncStatus: signal({
      online: true,
      state: 'idle',
      pendingOps: 0,
      pendingPhotos: 0,
      failedOps: 0,
      lastSyncAt: null,
      lastError: null,
    }),
    syncNow: (...args: unknown[]) =>
      (syncMocks.syncNow as (...a: unknown[]) => Promise<undefined>)(...args),
    transport: {
      rpc: (fn: string, args?: Record<string, unknown>) => syncMocks.rpc(fn, args),
      push: async () => [],
      pull: async () => ({ changes: [], cursor: null, done: true }),
    },
    isSyncError: (e: unknown) => e instanceof Error && e.name === 'SyncError',
    startSync: () => undefined,
    stopSync: () => undefined,
    enqueuePhotoUpload: async () => undefined,
    resetLocalData: async () => undefined,
    WIFI_ONLY_PREF_KEY: 'sync.wifiOnly',
  };
  return sync;
}

/** Sets the online flag of the mocked sync status (and of `navigator.onLine`). */
export function setOnline(online: boolean): void {
  const status = syncModule().syncStatus as { value: Record<string, unknown> };
  status.value = { ...status.value, online };
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
}

export function resetSyncMocks(): void {
  syncMocks.syncNow.mockReset();
  syncMocks.syncNow.mockImplementation(async () => undefined);
  syncMocks.rpc.mockReset();
  syncMocks.rpc.mockImplementation(async () => []);
  setOnline(true);
}

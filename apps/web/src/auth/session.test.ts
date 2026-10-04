/**
 * Session state machine, sign-out, revocation and the MFA gate — with the real vault
 * (fake IndexedDB) and a scripted stand-in for the supabase client.
 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectorMombasa,
  collectorPemba,
  fakeAccessToken,
  hqAdminAal1,
  hqAdminAal2,
  managerTzAal1,
  managerTzAal2,
} from './__fixtures__/myContext';
import type { MyContext } from './context';
// Types only: the modules themselves are loaded freshly for every test (see `load`).
import type * as SessionNs from './session';
import type * as StoreNs from './store';

interface RpcAnswer {
  data: unknown;
  error: { code?: string; message: string } | null;
  status: number;
}

interface FakeControl {
  /** Session that the next successful verifyOtp stores. */
  nextSession: Record<string, unknown> | null;
  /** Scripted answer of rpc('my_context'). */
  rpc: () => RpcAnswer;
  /** Value of app_settings['security.pin_lock_minutes'] (undefined = no row). */
  pinLockMinutes: unknown;
  otpError: unknown;
  verifyError: unknown;
  refreshResult: () => Promise<{ data: { session: unknown }; error: unknown }>;
  emit(event: string, session: unknown): void;
  calls: {
    signInWithOtp: unknown[];
    verifyOtp: unknown[];
    adminSignOut: unknown[];
    signOut: unknown[];
    rpc: string[];
    refreshSession: number;
  };
}

vi.mock('../i18n', () => ({
  t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key} ${JSON.stringify(params)}` : key,
}));

vi.mock('./supabase', () => {
  // The mock module outlives vi.resetModules(): `attach` points it at the vault of the freshly
  // loaded module graph and clears everything a previous test left behind.
  let storage: {
    getItem(k: string): string | null;
    setItem(k: string, v: string): Promise<void>;
    removeItem(k: string): Promise<void>;
  };
  let storageKey = '';
  const listeners = new Set<(event: string, session: unknown) => void>();
  const control = {
    emit: (event: string, session: unknown) =>
      listeners.forEach((listener) => listener(event, session)),
    attach(nextStorage: typeof storage, key: string) {
      storage = nextStorage;
      storageKey = key;
      listeners.clear();
      Object.assign(control, {
        nextSession: null,
        rpc: () => ({ data: null, error: { message: 'not scripted' }, status: 500 }),
        pinLockMinutes: undefined,
        otpError: null,
        verifyError: null,
        refreshResult: async () => ({ data: { session: null }, error: null }),
        calls: {
          signInWithOtp: [],
          verifyOtp: [],
          adminSignOut: [],
          signOut: [],
          rpc: [],
          refreshSession: 0,
        },
      });
    },
  } as unknown as FakeControl & { attach(nextStorage: typeof storage, key: string): void };
  const readSession = (): unknown => {
    const raw = storage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  };
  const settingsQuery = {
    select: () => settingsQuery,
    eq: () => settingsQuery,
    maybeSingle: async () => ({
      data: control.pinLockMinutes === undefined ? null : { value: control.pinLockMinutes },
      error: null,
    }),
  };
  const supabase = {
    auth: {
      initialize: async () => ({ error: null }),
      onAuthStateChange: (listener: (event: string, session: unknown) => void) => {
        listeners.add(listener);
        return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
      },
      signInWithOtp: async (params: unknown) => {
        control.calls.signInWithOtp.push(params);
        return { data: {}, error: control.otpError };
      },
      verifyOtp: async (params: unknown) => {
        control.calls.verifyOtp.push(params);
        if (control.verifyError) return { data: {}, error: control.verifyError };
        await storage.setItem(storageKey, JSON.stringify(control.nextSession));
        control.emit('SIGNED_IN', control.nextSession);
        return { data: { session: control.nextSession }, error: null };
      },
      getSession: async () => ({ data: { session: readSession() }, error: null }),
      refreshSession: async () => {
        control.calls.refreshSession += 1;
        return control.refreshResult();
      },
      signOut: async (options: unknown) => {
        control.calls.signOut.push(options);
        await storage.removeItem(storageKey);
        control.emit('SIGNED_OUT', null);
        return { error: null };
      },
      admin: {
        signOut: async (jwt: string, scope: string) => {
          control.calls.adminSignOut.push([jwt, scope]);
          return { data: null, error: null };
        },
      },
    },
    rpc: async (fn: string) => {
      control.calls.rpc.push(fn);
      return control.rpc();
    },
    from: () => settingsQuery,
  };
  return { supabase, fakeControl: control };
});

type SessionModule = typeof SessionNs;
type StoreModule = typeof StoreNs;

interface Harness {
  s: SessionModule;
  control: FakeControl;
  vault: StoreModule['vault'];
  key: string;
  resets: string[];
  ports: {
    pendingWork: ReturnType<typeof vi.fn<() => Promise<{ ops: number; photos: number }>>>;
    confirm: ReturnType<
      typeof vi.fn<
        (options: {
          title: string;
          message: string;
          confirmLabel: string;
          danger: boolean;
        }) => Promise<boolean>
      >
    >;
  };
}

const PIN = '4071';

function sessionFor(
  ctx: MyContext,
  aal: 'aal1' | 'aal2' = 'aal1',
  refresh = 'refresh-1',
): Record<string, unknown> {
  return {
    access_token: fakeAccessToken({
      sub: ctx.user_id,
      aal,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    refresh_token: refresh,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: ctx.user_id, email: 'someone@example.org' },
  };
}

const ok = (ctx: MyContext) => (): RpcAnswer => ({ data: ctx, error: null, status: 200 });
const offline = (): RpcAnswer => ({
  data: null,
  error: { message: 'TypeError: Failed to fetch' },
  status: 0,
});

async function load(): Promise<Harness> {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  const { fakeControl } = (await import('./supabase')) as unknown as {
    fakeControl: FakeControl & { attach(storage: unknown, key: string): void };
  };
  const { vault, STORAGE_KEY } = await import('./store');
  fakeControl.attach(vault.storage, STORAGE_KEY);
  const s = await import('./session');
  const resets: string[] = [];
  const ports = {
    pendingWork: vi.fn(async () => ({ ops: 0, photos: 0 })),
    confirm: vi.fn(async () => true),
  };
  s.setAuthPorts({
    resetLocalData: async (reason) => {
      resets.push(reason);
    },
    pendingWork: ports.pendingWork,
    confirm: ports.confirm,
  });
  await s.initAuth();
  return { s, control: fakeControl, vault, key: STORAGE_KEY, resets, ports };
}

/** Sign in as the owner of `ctx` and wait for the context. */
async function signIn(h: Harness, ctx: MyContext, aal: 'aal1' | 'aal2' = 'aal1'): Promise<void> {
  h.control.rpc = ok(ctx);
  h.control.nextSession = sessionFor(ctx, aal);
  await h.s.verifyOtp('someone@example.org', '123456', 'email');
  await h.s.refreshContext();
}

async function signInWithPin(
  h: Harness,
  ctx: MyContext,
  aal: 'aal1' | 'aal2' = 'aal1',
): Promise<void> {
  await signIn(h, ctx, aal);
  await h.s.pin.set(PIN);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('auth state machine', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await load();
  });

  it('starts signed out and unlocked on a fresh device', () => {
    expect(h.s.authState.value).toBe('signed_out');
    expect(h.s.pin.locked.value).toBe(false);
    expect(h.s.session.value).toBeNull();
    expect(h.s.me.value).toBeNull();
  });

  it('sign-in → PIN setup → ready, with capabilities from my_context()', async () => {
    await signIn(h, collectorPemba);
    expect(h.s.session.value?.user.id).toBe(collectorPemba.user_id);
    expect(h.s.authState.value).toBe('pin_setup');
    expect(h.s.me.value).toEqual(collectorPemba);
    expect(await h.s.pin.isSet()).toBe(false);

    await h.s.pin.set(PIN);
    expect(h.s.authState.value).toBe('ready');
    expect(h.s.can.write.value).toBe(true);
    expect(h.s.can.seePeople.value).toBe(true);
    expect(h.s.can.review.value).toBe(false);
    expect(h.s.can.seeRestricted.value).toBe(false);
    expect(h.s.can.admin.value).toBe(false);
  });

  it('shows the pending screen while the context has never been loaded (offline right after sign-in)', async () => {
    h.control.rpc = offline;
    h.control.nextSession = sessionFor(collectorPemba);
    await h.s.verifyOtp('someone@example.org', '123456', 'email');
    await h.s.refreshContext();
    await h.s.pin.set(PIN);
    expect(h.s.authState.value).toBe('context');
    expect(h.s.contextError.value).toBe('offline');
    expect(h.s.can.write.value).toBe(false);

    h.control.rpc = ok(collectorPemba);
    await h.s.refreshContext();
    expect(h.s.authState.value).toBe('ready');
    expect(h.s.contextError.value).toBeNull();
  });

  it('holds a country manager at the MFA gate until the session is aal2', async () => {
    await signInWithPin(h, managerTzAal1);
    expect(h.s.authState.value).toBe('mfa');
    expect(h.s.can.write.value).toBe(false);
    expect(h.s.can.manage.value).toBe(false);

    // mfa.verify makes supabase-js store a new aal2 session; the context is then re-read.
    h.control.rpc = ok(managerTzAal2);
    await h.vault.storage.setItem(
      h.key,
      JSON.stringify(sessionFor(managerTzAal2, 'aal2', 'refresh-aal2')),
    );
    await h.s.refreshContext();
    expect(h.s.me.value?.aal).toBe('aal2');
    expect(h.s.authState.value).toBe('ready');
    expect(h.s.can.seeRestricted.value).toBe(true);
    expect(h.s.can.review.value).toBe(true);
    expect(h.s.can.manage.value).toBe(true);
    expect(h.s.can.admin.value).toBe(false);
  });

  it('holds an HQ administrator likewise and grants admin only at aal2', async () => {
    await signInWithPin(h, hqAdminAal1);
    expect(h.s.authState.value).toBe('mfa');
    expect(h.s.can.admin.value).toBe(false);
    h.control.rpc = ok(hqAdminAal2);
    await h.vault.storage.setItem(
      h.key,
      JSON.stringify(sessionFor(hqAdminAal2, 'aal2', 'refresh-aal2')),
    );
    await h.s.refreshContext();
    expect(h.s.authState.value).toBe('ready');
    expect(h.s.can.admin.value).toBe(true);
  });

  it('a context request that was already running when the session became aal2 is repeated', async () => {
    await signInWithPin(h, hqAdminAal1);
    let release: (answer: RpcAnswer) => void = () => undefined;
    h.control.rpc = () =>
      new Promise<RpcAnswer>((resolve) => (release = resolve)) as unknown as RpcAnswer;
    const slow = h.s.refreshContext(); // aal1 request in flight
    await Promise.resolve();
    await h.vault.storage.setItem(
      h.key,
      JSON.stringify(sessionFor(hqAdminAal2, 'aal2', 'refresh-aal2')),
    );
    h.control.rpc = ok(hqAdminAal2);
    release({ data: hqAdminAal1, error: null, status: 200 });
    await slow;
    expect(h.s.me.value?.aal).toBe('aal2');
    expect(h.s.authState.value).toBe('ready');
  });
});

describe('PIN lock', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await load();
    await signInWithPin(h, collectorPemba);
  });

  it('locking drops session, context and capabilities; nothing is rendered behind the lock', () => {
    h.s.pin.lock();
    expect(h.s.pin.locked.value).toBe(true);
    expect(h.s.authState.value).toBe('locked');
    expect(h.s.session.value).toBeNull();
    expect(h.s.me.value).toBeNull();
    expect(h.s.can.write.value).toBe(false);
    expect(h.s.authNotice.value).toBeNull();
  });

  it('unlocks offline with the cached context', async () => {
    h.s.pin.lock();
    h.control.rpc = offline;
    expect(await h.s.pin.unlock(PIN)).toBe(true);
    expect(h.s.session.value?.refresh_token).toBe('refresh-1');
    expect(h.s.me.value).toEqual(collectorPemba);
    expect(h.s.authState.value).toBe('ready');
    expect(h.s.can.write.value).toBe(true);
  });

  it('an unlock without a connection makes no my_context() request; back online refreshes it', async () => {
    h.s.pin.lock();
    vi.stubGlobal('navigator', { onLine: false });
    const before = h.control.calls.rpc.length;
    expect(await h.s.pin.unlock(PIN)).toBe(true);
    await h.s.refreshContext();
    expect(h.control.calls.rpc.length).toBe(before);
    expect(h.s.contextError.value).toBe('offline');
    expect(h.s.me.value).toEqual(collectorPemba);
    expect(h.s.authState.value).toBe('ready');

    vi.stubGlobal('navigator', { onLine: true });
    h.control.rpc = () => ({ data: collectorPemba, error: null, status: 200 });
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(h.s.contextError.value).toBeNull());
    expect(h.control.calls.rpc).toContain('my_context');
    expect(h.control.calls.rpc.length).toBeGreaterThan(before);
  });

  it('a wrong PIN keeps the app locked', async () => {
    h.s.pin.lock();
    expect(await h.s.pin.unlock('9999')).toBe(false);
    expect(h.s.authState.value).toBe('locked');
    expect(h.s.pin.attempts.value.failures).toBe(1);
  });

  it('ten wrong PINs wipe the stored session but never the local data', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    h.s.pin.lock();
    for (let attempt = 1; attempt < h.s.pin.maxFailures; attempt += 1) {
      expect(await h.s.pin.tryUnlock('9999')).toBe('wrong');
      vi.setSystemTime(h.s.pin.attempts.value.retryAt);
    }
    expect(await h.s.pin.tryUnlock('9999')).toBe('wiped');
    expect(h.s.authState.value).toBe('signed_out');
    expect(h.s.authNotice.value).toBe('pin_wiped');
    expect(await h.s.pin.isSet()).toBe(false);
    expect(h.resets).toEqual([]); // unsent work must survive
  }, 30_000);

  it('"forgot PIN" requires a new sign-in and keeps local data', async () => {
    h.s.pin.lock();
    await h.s.pin.forget();
    expect(h.s.authState.value).toBe('signed_out');
    expect(await h.s.pin.isSet()).toBe(false);
    expect(h.resets).toEqual([]);
    // The same user signs in again: no reset either.
    await signInWithPin(h, collectorPemba);
    expect(h.s.authState.value).toBe('ready');
    expect(h.resets).toEqual([]);
  });

  it('locks after the idle limit (default 15 minutes) and on demand', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    window.dispatchEvent(new Event('pointerdown')); // activity now
    vi.advanceTimersByTime(15 * 60_000 - 1);
    expect(h.s.pin.locked.value).toBe(false);
    vi.advanceTimersByTime(1);
    expect(h.s.pin.locked.value).toBe(true);
    expect(h.s.authState.value).toBe('locked');
  });

  it('uses security.pin_lock_minutes from app_settings when available, also after unlock', async () => {
    h = await load();
    h.control.pinLockMinutes = 5;
    await signInWithPin(h, collectorPemba);
    await vi.waitFor(() => expect(h.s.lockMinutes.value).toBe(5));
    await h.vault.flush();
    h.s.pin.lock();
    h.control.rpc = offline;
    expect(await h.s.pin.unlock(PIN)).toBe(true);
    expect(h.s.lockMinutes.value).toBe(5);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    window.dispatchEvent(new Event('keydown'));
    vi.advanceTimersByTime(5 * 60_000);
    expect(h.s.pin.locked.value).toBe(true);
  });
});

describe('idle before a PIN exists', () => {
  it('forgets the in-memory session and ends it on the server', async () => {
    const h = await load();
    await signIn(h, collectorPemba);
    const token = h.s.session.value!.access_token;
    h.s.pin.lock();
    expect(h.s.session.value).toBeNull();
    expect(h.s.authState.value).toBe('signed_out');
    expect(h.s.authNotice.value).toBe('session_ended');
    expect(h.control.calls.adminSignOut).toEqual([[token, 'local']]);
  });
});

describe('signOut', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await load();
    await signInWithPin(h, collectorPemba);
  });

  it('signs out on the server (this device only), wipes the session and resets local data', async () => {
    const token = h.s.session.value!.access_token;
    await h.s.signOut();
    expect(h.ports.confirm).not.toHaveBeenCalled();
    expect(h.control.calls.adminSignOut).toEqual([[token, 'local']]);
    expect(h.s.session.value).toBeNull();
    expect(h.s.me.value).toBeNull();
    expect(h.s.authState.value).toBe('signed_out');
    expect(h.s.authNotice.value).toBeNull();
    expect(await h.s.pin.isSet()).toBe(false);
    expect(await h.vault.dump()).toEqual([]);
    expect(h.resets).toEqual(['sign_out']);
  });

  it('asks before signing out when unsent work exists — and does nothing when declined', async () => {
    h.ports.pendingWork.mockResolvedValue({ ops: 3, photos: 2 });
    h.ports.confirm.mockResolvedValue(false);
    await h.s.signOut();
    expect(h.ports.confirm).toHaveBeenCalledTimes(1);
    expect(h.ports.confirm.mock.calls[0]![0]).toEqual({
      title: 'auth.signout_unsent_title',
      message: 'auth.signout_unsent_message {"ops":3,"photos":2}',
      confirmLabel: 'auth.signout_unsent_confirm',
      danger: true,
    });
    expect(h.s.session.value).not.toBeNull();
    expect(h.s.authState.value).toBe('ready');
    expect(h.control.calls.adminSignOut).toEqual([]);
    expect(h.resets).toEqual([]);
  });

  it('signs out after the user confirmed', async () => {
    h.ports.pendingWork.mockResolvedValue({ ops: 0, photos: 1 });
    h.ports.confirm.mockResolvedValue(true);
    await h.s.signOut();
    expect(h.ports.confirm).toHaveBeenCalledTimes(1);
    expect(h.s.authState.value).toBe('signed_out');
    expect(h.resets).toEqual(['sign_out']);
  });

  it('force skips the question', async () => {
    h.ports.pendingWork.mockResolvedValue({ ops: 9, photos: 9 });
    await h.s.signOut({ force: true });
    expect(h.ports.confirm).not.toHaveBeenCalled();
    expect(h.s.authState.value).toBe('signed_out');
  });

  it('works offline: no server call, the local session is wiped all the same', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    await h.s.signOut();
    expect(h.control.calls.adminSignOut).toEqual([]);
    expect(h.s.session.value).toBeNull();
    expect(await h.vault.dump()).toEqual([]);
    expect(h.resets).toEqual(['sign_out']);
  });

  it('works from the lock screen (no token in memory)', async () => {
    h.s.pin.lock();
    await h.s.signOut();
    expect(h.control.calls.adminSignOut).toEqual([]);
    expect(h.s.authState.value).toBe('signed_out');
    expect(await h.s.pin.isSet()).toBe(false);
    expect(h.resets).toEqual(['sign_out']);
  });
});

describe('server-side revocation', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await load();
    await signInWithPin(h, collectorPemba);
  });

  it('my_context() answering session_ok=false ends the session and requires sign-in', async () => {
    h.control.rpc = ok({ ...collectorPemba, session_ok: false });
    await h.s.refreshContext();
    expect(h.s.session.value).toBeNull();
    expect(h.s.authState.value).toBe('signed_out');
    expect(h.s.authNotice.value).toBe('revoked');
    expect(await h.s.pin.isSet()).toBe(false);
    expect(h.resets).toEqual(['revoked']);
  });

  it('PT403 session_revoked from the RPC does the same', async () => {
    h.control.rpc = () => ({
      data: null,
      error: { code: 'PT403', message: 'session_revoked' },
      status: 403,
    });
    await h.s.refreshContext();
    expect(h.s.authState.value).toBe('signed_out');
    expect(h.s.authNotice.value).toBe('revoked');
    expect(h.resets).toEqual(['revoked']);
  });

  it('an ordinary 403 or a server error does not sign anybody out', async () => {
    h.control.rpc = () => ({
      data: null,
      error: { code: 'PT403', message: 'forbidden' },
      status: 403,
    });
    await h.s.refreshContext();
    h.control.rpc = () => ({ data: null, error: { message: 'boom' }, status: 500 });
    await h.s.refreshContext();
    expect(h.s.authState.value).toBe('ready');
    expect(h.s.me.value).toEqual(collectorPemba);
  });

  it('the sync engine reports a revoked device it already wiped: no second wipe', async () => {
    await h.s.handleSessionProblem({ reason: 'device_revoked', wiped: true });
    expect(h.s.authState.value).toBe('signed_out');
    expect(h.s.authNotice.value).toBe('revoked');
    expect(h.resets).toEqual([]);
  });

  it('the window event is an equivalent entry point', async () => {
    window.dispatchEvent(new Event('istiqama:session-revoked'));
    await vi.waitFor(() => expect(h.s.authState.value).toBe('signed_out'));
    await vi.waitFor(() => expect(h.resets).toEqual(['revoked']));
  });

  it('"not authenticated": one refresh; a network failure keeps the session', async () => {
    h.control.refreshResult = async () => ({
      data: { session: null },
      error: Object.assign(new Error('Failed to fetch'), {
        name: 'AuthRetryableFetchError',
        status: 0,
      }),
    });
    await h.s.handleSessionProblem({ reason: 'not_authenticated', wiped: false });
    expect(h.control.calls.refreshSession).toBe(1);
    expect(h.s.authState.value).toBe('ready');
    expect(h.resets).toEqual([]);
  });

  it('"not authenticated": a definitive refusal requires sign-in but keeps local data', async () => {
    h.control.refreshResult = async () => ({
      data: { session: null },
      error: Object.assign(new Error('Invalid Refresh Token'), {
        name: 'AuthApiError',
        status: 400,
        code: 'refresh_token_not_found',
      }),
    });
    await h.s.handleSessionProblem({ reason: 'not_authenticated', wiped: false });
    expect(h.s.authState.value).toBe('signed_out');
    expect(h.s.authNotice.value).toBe('session_ended');
    expect(h.resets).toEqual([]);
  });

  it('a gateway error (502) on my_context() is retried before an error is shown', async () => {
    let calls = 0;
    h.control.rpc = () => {
      calls += 1;
      return calls < 3
        ? { data: null, error: { message: 'Bad Gateway' }, status: 502 }
        : { data: collectorPemba, error: null, status: 200 };
    };
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const pending = h.s.refreshContext();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual(collectorPemba);
    expect(calls).toBe(3);
    expect(h.s.contextError.value).toBeNull();
  });

  it('a gateway error that persists ends on the error screen state, not in a loop', async () => {
    let calls = 0;
    h.control.rpc = () => {
      calls += 1;
      return { data: null, error: { message: 'Service Unavailable' }, status: 503 };
    };
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const pending = h.s.refreshContext();
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(calls).toBe(3);
    expect(h.s.contextError.value).toBe('failed');
  });

  it('a 401 on my_context() triggers one refresh and one retry', async () => {
    let calls = 0;
    h.control.rpc = () => {
      calls += 1;
      return calls === 1
        ? { data: null, error: { code: 'PGRST301', message: 'JWT expired' }, status: 401 }
        : { data: collectorPemba, error: null, status: 200 };
    };
    const ctx = await h.s.refreshContext();
    expect(h.control.calls.refreshSession).toBe(1);
    expect(calls).toBe(2);
    expect(ctx).toEqual(collectorPemba);
    expect(h.s.authState.value).toBe('ready');
  });

  it('supabase-js dropping the session (refresh token refused) shows the login with a notice', async () => {
    await h.vault.storage.removeItem(h.key);
    expect(h.s.authState.value).toBe('signed_out');
    expect(h.s.authNotice.value).toBe('session_ended');
    expect(h.resets).toEqual([]);
  });
});

describe('several users on one device', () => {
  it('hands the previous user’s local data to the sync module before the new context is visible', async () => {
    const h = await load();
    await signInWithPin(h, collectorPemba);
    h.s.pin.lock();
    await h.s.pin.forget(); // PIN forgotten: local data of the first user is still on the device

    const seenDuringReset: Array<MyContext | null> = [];
    h.s.setAuthPorts({
      resetLocalData: async (reason) => {
        seenDuringReset.push(h.s.me.value);
        h.resets.push(reason);
      },
    });
    await signIn(h, collectorMombasa);
    expect(h.resets).toEqual(['user_changed']);
    expect(seenDuringReset).toEqual([null]);
    expect(h.s.me.value).toEqual(collectorMombasa);
  });

  it('does not reset for the first user of a device, nor when the same user signs in again', async () => {
    const h = await load();
    await signInWithPin(h, collectorPemba);
    expect(h.resets).toEqual([]);
    await h.s.signOut({ force: true }); // unsent work stays for its owner (sync module rule)
    expect(h.resets).toEqual(['sign_out']);
    await signIn(h, collectorPemba);
    expect(h.resets).toEqual(['sign_out']);
    expect(h.s.me.value).toEqual(collectorPemba);
  });

  it('after a sign-out, another user gets the device only once the leftovers are handed over', async () => {
    const h = await load();
    await signInWithPin(h, collectorPemba);
    await h.s.signOut({ force: true });
    const seenDuringReset: Array<MyContext | null> = [];
    h.s.setAuthPorts({
      resetLocalData: async (reason) => {
        seenDuringReset.push(h.s.me.value);
        h.resets.push(reason);
      },
    });
    await signIn(h, collectorMombasa);
    expect(h.resets).toEqual(['sign_out', 'user_changed']);
    expect(seenDuringReset).toEqual([null]);
    expect(h.s.me.value).toEqual(collectorMombasa);
  });
});

describe('other tabs', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await load();
    await signInWithPin(h, collectorPemba);
  });

  it('adopts a token rotated by another tab', () => {
    const rotated = sessionFor(collectorPemba, 'aal1', 'refresh-rotated-elsewhere');
    h.control.emit('TOKEN_REFRESHED', rotated);
    expect(h.s.session.value?.refresh_token).toBe('refresh-rotated-elsewhere');
    expect(h.vault.storage.getItem(h.key)).toContain('refresh-rotated-elsewhere');
  });

  it('ignores sessions of other users and anything that arrives while locked', () => {
    h.control.emit('SIGNED_IN', sessionFor(collectorMombasa, 'aal1', 'refresh-other-user'));
    expect(h.s.session.value?.refresh_token).toBe('refresh-1');
    h.s.pin.lock();
    h.control.emit('TOKEN_REFRESHED', sessionFor(collectorPemba, 'aal1', 'refresh-while-locked'));
    expect(h.s.session.value).toBeNull();
    expect(h.vault.storage.getItem(h.key)).toBeNull();
  });

  it('follows a sign-out made in another tab', async () => {
    h.control.emit('SIGNED_OUT', null);
    await vi.waitFor(() => expect(h.s.authState.value).toBe('signed_out'));
  });
});

describe('sign-in requests', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await load();
  });

  it('e-mail: existing users only, normalised address, redirect to the app', async () => {
    await h.s.signInWithEmailOtp('  Collector.Pemba@Example.org ');
    expect(h.control.calls.signInWithOtp).toHaveLength(1);
    expect(h.control.calls.signInWithOtp[0]).toMatchObject({
      email: 'collector.pemba@example.org',
      options: { shouldCreateUser: false },
    });
    const sent = h.control.calls.signInWithOtp[0] as { options: { emailRedirectTo: string } };
    expect(sent.options.emailRedirectTo).toBe(new URL('/', window.location.origin).href);
  });

  it('phone: E.164 only, SMS channel, existing users only', async () => {
    await expect(h.s.signInWithPhoneOtp('0700000001')).rejects.toMatchObject({
      kind: 'invalid_phone',
    });
    expect(h.control.calls.signInWithOtp).toHaveLength(0);
    await h.s.signInWithPhoneOtp('+255700000001');
    expect(h.control.calls.signInWithOtp[0]).toEqual({
      phone: '+255700000001',
      options: { shouldCreateUser: false, channel: 'sms' },
    });
  });

  it('rejects bad input before any request', async () => {
    await expect(h.s.signInWithEmailOtp('not-an-address')).rejects.toMatchObject({
      kind: 'invalid_email',
    });
    await expect(h.s.verifyOtp('a@example.org', 'abc', 'email')).rejects.toMatchObject({
      kind: 'code_invalid',
    });
    expect(h.control.calls.signInWithOtp).toHaveLength(0);
    expect(h.control.calls.verifyOtp).toHaveLength(0);
  });

  it('reports "offline" without a request when the browser has no connection', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    await expect(h.s.signInWithEmailOtp('a@example.org')).rejects.toMatchObject({
      kind: 'offline',
    });
    await expect(h.s.verifyOtp('a@example.org', '123456', 'email')).rejects.toMatchObject({
      kind: 'offline',
    });
    expect(h.control.calls.signInWithOtp).toHaveLength(0);
  });

  it('maps server refusals to friendly errors', async () => {
    h.control.otpError = Object.assign(new Error('rate'), {
      name: 'AuthApiError',
      status: 429,
      code: 'over_email_send_rate_limit',
    });
    await expect(h.s.signInWithEmailOtp('a@example.org')).rejects.toMatchObject({
      kind: 'rate_limited',
      key: 'auth.error_rate_limited',
    });
    h.control.otpError = Object.assign(new Error('no user'), {
      name: 'AuthApiError',
      status: 422,
      code: 'otp_disabled',
    });
    await expect(h.s.signInWithEmailOtp('a@example.org')).rejects.toMatchObject({
      kind: 'unknown_user',
    });
    h.control.verifyError = Object.assign(new Error('expired'), {
      name: 'AuthApiError',
      status: 403,
      code: 'otp_expired',
    });
    await expect(h.s.verifyOtp('a@example.org', '123456', 'email')).rejects.toMatchObject({
      kind: 'code_invalid',
    });
    expect(h.s.session.value).toBeNull();
  });

  it('verifies e-mail and SMS codes with the right type and clears an old notice', async () => {
    h.control.rpc = ok(collectorPemba);
    h.control.nextSession = sessionFor(collectorPemba);
    h.s.authNotice.value = 'session_ended';
    await h.s.verifyOtp(' A@Example.org ', '12 34 56', 'email');
    expect(h.control.calls.verifyOtp[0]).toEqual({
      email: 'a@example.org',
      token: '123456',
      type: 'email',
    });
    expect(h.s.authNotice.value).toBeNull();
    await h.s.signOut({ force: true });

    h.control.nextSession = sessionFor(collectorPemba);
    await h.s.verifyOtp('+255700000001', '654321', 'sms');
    expect(h.control.calls.verifyOtp[1]).toEqual({
      phone: '+255700000001',
      token: '654321',
      type: 'sms',
    });
  });

  it('a new sign-in while a locked vault exists replaces it (new PIN needed)', async () => {
    await signInWithPin(h, collectorPemba);
    h.s.pin.lock();
    h.control.nextSession = sessionFor(collectorPemba, 'aal1', 'refresh-fresh');
    await h.s.verifyOtp('someone@example.org', '123456', 'email');
    expect(h.s.pin.locked.value).toBe(false);
    expect(h.s.authState.value).toBe('pin_setup');
    expect(h.s.session.value?.refresh_token).toBe('refresh-fresh');
  });
});

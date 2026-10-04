/**
 * Session state of the app: who is signed in (`session`), what they may do (`me`, `can`),
 * which screen the AuthGate must show (`authState`), and the operations that change it
 * (sign-in flows, PIN, sign-out, revocation).
 *
 * Single source of truth: the PIN vault. supabase-js stores its session through
 * `vault.storage`; every change is mirrored into the `session` signal by the vault listener
 * below, so the app also works offline with an expired access token (supabase-js would report
 * "no session" until it can refresh).
 */
import { batch, computed, effect, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { t } from '../i18n';
import { getPref, setPref } from '../lib/prefs';
import {
  deriveCapabilities,
  isMyContext,
  needsMfa,
  tokenAal,
  type Capabilities,
  type MyContext,
} from './context';
import { AuthFlowError, isNetworkError, isSessionRevokedError, toFlowError } from './errors';
import { DEFAULT_IDLE_MINUTES, createIdleTracker, idleMinutesFromSetting } from './idle';
import { isE164, isValidEmail } from './phone';
import { STORAGE_KEY, vault } from './store';
import { supabase } from './supabase';
import { MAX_PIN_FAILURES, type PinAttempts, type UnlockResult } from './vault';

// ----------------------------------------------------------------------------- state

export type AuthState =
  | 'loading' // reading the vault / processing a magic link
  | 'signed_out' // LoginView
  | 'pin_setup' // signed in, no PIN chosen yet
  | 'locked' // PinLock
  | 'context' // signed in, my_context() not available yet (first load / offline)
  | 'mfa' // manager / HQ at aal1
  | 'ready'; // children

/** Why the user is looking at the login screen again (shown once, cleared by the next sign-in). */
export type AuthNotice = 'revoked' | 'session_ended' | 'pin_wiped' | 'link_invalid';

export const session: Signal<Session | null> = signal(null);
export const me: Signal<MyContext | null> = signal(null);
export const authNotice: Signal<AuthNotice | null> = signal(null);
/** Outcome of the last `my_context()` attempt while no context is available. */
export const contextError: Signal<'offline' | 'failed' | null> = signal(null);
/** Idle limit before the PIN lock, in minutes (`security.pin_lock_minutes`, default 15). */
export const lockMinutes: Signal<number> = signal(DEFAULT_IDLE_MINUTES);

const initialized = signal(false);

export const authState: ReadonlySignal<AuthState> = computed(() => {
  if (!initialized.value) return 'loading';
  if (vault.locked.value) return 'locked';
  const current = session.value;
  if (!current) return 'signed_out';
  if (vault.pinSet.value !== true) return 'pin_setup';
  const ctx = me.value;
  if (!ctx) return 'context';
  if (needsMfa(ctx, tokenAal(current.access_token))) return 'mfa';
  return 'ready';
});

const capabilities: ReadonlySignal<Capabilities> = computed(() =>
  deriveCapabilities(me.value, tokenAal(session.value?.access_token)),
);

function flag(name: keyof Capabilities): ReadonlySignal<boolean> {
  return computed(() => capabilities.value[name]);
}

/** Resolves to `true` only when `T` is assignable to `Contract` (compile error otherwise). */
type AssertExtends<T extends Contract, Contract> = T extends Contract ? true : never;

/** Shape of `can` in docs/contracts/web.md §3.6 (the object below may only add to it). */
interface CanContract {
  review: ReadonlySignal<boolean>;
  seeRestricted: ReadonlySignal<boolean>;
  seePeople: ReadonlySignal<boolean>;
  write: ReadonlySignal<boolean>;
  admin: ReadonlySignal<boolean>;
}

/** UI capability flags. They hide or show; the server (RLS, RPC checks) is what enforces. */
export const can = {
  review: flag('review'),
  seeRestricted: flag('seeRestricted'),
  seePeople: flag('seePeople'),
  write: flag('write'),
  admin: flag('admin'),
  /** Extension to the contract: HQ, or a country manager (users/devices of the own country). */
  manage: flag('manage'),
} as const;

/** Compile-time proof that `can` offers (at least) the contract shape; extensions are allowed. */
export type _CanMeetsContract = AssertExtends<typeof can, CanContract>;

// ----------------------------------------------------------------------------- ports

export type ResetReason = 'sign_out' | 'revoked' | 'user_changed';

/** What the auth module needs from its neighbours. The shell may replace any of them. */
export interface AuthPorts {
  /** Sync module: drop local data as that module defines for the given reason. */
  resetLocalData(reason: ResetReason): Promise<void>;
  /** Sync module: work that exists only on this device. */
  pendingWork(): Promise<{ ops: number; photos: number }>;
  confirm(options: {
    title: string;
    message: string;
    confirmLabel: string;
    danger: boolean;
  }): Promise<boolean>;
}

// The neighbours are imported lazily: `sync` itself imports this module (for `supabase`), and
// the dialog is not needed until somebody signs out.
const defaultPorts: AuthPorts = {
  async resetLocalData(reason) {
    const sync = await import('../sync');
    await (sync.resetLocalData as (reason?: ResetReason) => Promise<void>)(reason);
  },
  async pendingWork() {
    const sync = await import('../sync');
    const status = sync.syncStatus.value;
    return { ops: status.pendingOps + status.failedOps, photos: status.pendingPhotos };
  },
  async confirm(options) {
    try {
      const ui = await import('../ui/ConfirmDialog');
      return await ui.confirm(options);
    } catch {
      return (
        typeof window !== 'undefined' && window.confirm(`${options.title}\n\n${options.message}`)
      );
    }
  },
};

let ports: AuthPorts = defaultPorts;

export function setAuthPorts(overrides: Partial<AuthPorts>): void {
  ports = { ...ports, ...overrides };
}

/** Confirmation dialog through the UI port (used by the auth views). */
export function askConfirm(options: Parameters<AuthPorts['confirm']>[0]): Promise<boolean> {
  return ports.confirm(options);
}

async function resetLocalData(reason: ResetReason): Promise<void> {
  try {
    await ports.resetLocalData(reason);
  } catch (error) {
    console.error('auth: resetLocalData failed', error);
  }
}

// ----------------------------------------------------------------------------- wiring

const LAST_USER_PREF = 'auth.last_user_id';
const IDLE_EXTRA = 'pin_lock_minutes';
const CONTEXT_EXTRA = 'me';

/** Set while this module itself ends the session, so the loss is not reported as a surprise. */
let endingSession = false;
let settingsLoadedFor: string | null = null;

const idle = createIdleTracker({
  timeoutMs: DEFAULT_IDLE_MINUTES * 60_000,
  onIdle: () => lockNow(),
});

function applyLockMinutes(setting: unknown): number {
  const minutes = idleMinutesFromSetting(setting);
  lockMinutes.value = minutes;
  idle.setTimeoutMs(minutes * 60_000);
  return minutes;
}

function parseSession(value: string | null): Session | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Partial<Session>;
    return typeof candidate.access_token === 'string' && candidate.user
      ? (candidate as Session)
      : null;
  } catch {
    return null;
  }
}

function applySession(next: Session | null): void {
  const previous = session.peek();
  const previousUser = previous?.user.id ?? null;
  const nextUser = next?.user.id ?? null;
  batch(() => {
    session.value = next;
    if (!next) {
      me.value = null;
      contextError.value = null;
      if (previous && !endingSession && !vault.locked.peek()) authNotice.value = 'session_ended';
      return;
    }
    if (previousUser !== nextUser) {
      const cached = vault.getExtra<unknown>(CONTEXT_EXTRA);
      me.value = isMyContext(cached) && cached.user_id === nextUser ? cached : null;
      applyLockMinutes(vault.getExtra(IDLE_EXTRA));
    }
  });
  if (!next) return;
  const aalChanged = tokenAal(previous?.access_token) !== tokenAal(next.access_token);
  if (previousUser !== nextUser || aalChanged || !me.peek()) void refreshContext();
}

vault.subscribe((key, value) => {
  if (key === STORAGE_KEY) applySession(parseSession(value));
});

supabase.auth.onAuthStateChange((event: AuthChangeEvent, incoming: Session | null) => {
  const current = session.peek();
  if (event === 'SIGNED_OUT') {
    // Local removals already went through the vault; this is a sign-out made in another tab.
    if (current) void vault.wipe();
    return;
  }
  // Token rotated by another tab: adopt it, or this tab would later replay a stale refresh token.
  if (
    incoming &&
    current &&
    incoming.user?.id === current.user.id &&
    incoming.refresh_token !== current.refresh_token
  ) {
    const expiresAt = incoming.expires_at ?? Math.round(Date.now() / 1000) + incoming.expires_in;
    vault.adoptExternal(STORAGE_KEY, JSON.stringify({ ...incoming, expires_at: expiresAt }));
  }
});

effect(() => {
  if (session.value) idle.start();
  else idle.stop();
});

let initPromise: Promise<void> | null = null;

/** Reads the vault and lets supabase-js finish its start-up (magic-link detection). Idempotent. */
export function initAuth(): Promise<void> {
  initPromise ??= (async () => {
    await vault.init();
    try {
      const { error } = await supabase.auth.initialize();
      // Only a sign-in link can fail here (expired, already used, opened twice).
      if (error && !session.peek()) authNotice.value = 'link_invalid';
    } catch (error) {
      console.warn('auth: client initialisation failed', error);
    }
    initialized.value = true;
  })();
  return initPromise;
}

// ----------------------------------------------------------------------------- context

/** Gateway answers worth a retry of `my_context()`, and the waits before each retry. */
const TRANSIENT_STATUS: ReadonlySet<number> = new Set([502, 503, 504]);
const CONTEXT_RETRY_MS: readonly number[] = [1000, 3000];

let contextInFlight: Promise<MyContext | null> | null = null;
let contextRerun = false;

/**
 * Calls `my_context()` and caches the answer (encrypted, next to the session) for offline
 * starts. Safe to call often: concurrent calls share one request, and a call made while one is
 * in flight (for example right after MFA) triggers exactly one more.
 */
export function refreshContext(): Promise<MyContext | null> {
  if (contextInFlight) {
    contextRerun = true;
    return contextInFlight;
  }
  contextInFlight = (async () => {
    try {
      let ctx = await loadContext();
      while (contextRerun) {
        contextRerun = false;
        ctx = await loadContext();
      }
      return ctx;
    } finally {
      contextInFlight = null;
      contextRerun = false;
    }
  })();
  return contextInFlight;
}

async function loadContext(): Promise<MyContext | null> {
  const started = session.peek();
  if (!started) return null;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    // No request without a connection (an unlock offline must not hit the network): the cached
    // context stays in use and the 'online' listener at the end of this file refreshes it.
    contextError.value = 'offline';
    return me.peek();
  }
  if (!me.peek()) contextError.value = null; // back to "loading" on the pending screen
  let result = await supabase.rpc('my_context');
  // A proxy between the phone and the API answered for it (502/503/504: restart, idle
  // connection dropped, mobile carrier gateway): try again a little later before showing an
  // error — on the first sign-in that error blocks the whole app.
  for (const wait of CONTEXT_RETRY_MS) {
    if (!result.error || !TRANSIENT_STATUS.has(result.status)) break;
    await new Promise((resolve) => setTimeout(resolve, wait));
    if (session.peek()?.user.id !== started.user.id) return null;
    result = await supabase.rpc('my_context');
  }
  if (result.error && result.status === 401) {
    // The access token was refused (expired while the phone slept, wrong device clock): one
    // forced refresh, then one more try.
    if (!(await refreshOrEnd())) return null;
    result = await supabase.rpc('my_context');
  }
  const current = session.peek();
  if (!current || current.user.id !== started.user.id) return null; // locked / signed out meanwhile

  if (result.error) {
    if (isSessionRevokedError(result.error)) {
      await handleSessionRevoked();
      return null;
    }
    const offline =
      result.status === 0 || (typeof navigator !== 'undefined' && navigator.onLine === false);
    contextError.value = offline ? 'offline' : 'failed';
    return me.peek();
  }
  const ctx: unknown = result.data;
  if (!isMyContext(ctx) || ctx.user_id !== current.user.id) {
    contextError.value = 'failed';
    return me.peek();
  }
  if (!ctx.session_ok) {
    await handleSessionRevoked();
    return null;
  }
  await noteUser(ctx.user_id);
  if (session.peek()?.user.id !== ctx.user_id) return null;
  batch(() => {
    contextError.value = null;
    me.value = ctx;
  });
  await vault.setExtra(CONTEXT_EXTRA, ctx);
  void loadSecuritySettings(ctx.user_id);
  return ctx;
}

/**
 * A different account on a device that still holds another user's local data (after a PIN wipe
 * or "forgot PIN", which keep that data on purpose, and after a sign-out, which keeps the unsent
 * work so that its owner can push it after signing in again): hand over to the sync module
 * BEFORE the new context becomes visible, so nothing of the previous user is shown to or pushed
 * under the new one. The same user signing in again keeps everything.
 */
async function noteUser(userId: string): Promise<void> {
  const last = getPref<string>(LAST_USER_PREF, '');
  if (last === userId) return;
  if (last) await resetLocalData('user_changed');
  setPref(LAST_USER_PREF, userId);
}

/** `security.pin_lock_minutes` (public app setting, default 15). Cached inside the vault. */
async function loadSecuritySettings(userId: string): Promise<void> {
  if (settingsLoadedFor === userId) return;
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'security.pin_lock_minutes')
      .maybeSingle();
    if (error || session.peek()?.user.id !== userId) return;
    settingsLoadedFor = userId;
    if (!data) return;
    const minutes = applyLockMinutes((data as { value: unknown }).value);
    await vault.setExtra(IDLE_EXTRA, minutes);
  } catch {
    // offline: keep the cached or default value
  }
}

// ----------------------------------------------------------------------------- sign-in

function assertOnline(): void {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new AuthFlowError('offline');
  }
}

function redirectUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return new URL(import.meta.env.BASE_URL ?? '/', window.location.origin).href;
}

/**
 * Sends a sign-in e-mail to an existing user. The same message carries a 6-digit code (typed
 * into the app → `verifyOtp`) and a magic link (opened on this device → picked up at start-up).
 */
export async function signInWithEmailOtp(email: string): Promise<void> {
  const address = email.trim().toLowerCase();
  if (!isValidEmail(address)) throw new AuthFlowError('invalid_email');
  assertOnline();
  let error: unknown;
  try {
    ({ error } = await supabase.auth.signInWithOtp({
      email: address,
      options: { shouldCreateUser: false, emailRedirectTo: redirectUrl() },
    }));
  } catch (thrown) {
    error = thrown;
  }
  if (error) throw toFlowError(error);
}

/** Sends an SMS code to an existing user. `phone` must be E.164 (see `toE164`). */
export async function signInWithPhoneOtp(phone: string): Promise<void> {
  if (!isE164(phone)) throw new AuthFlowError('invalid_phone');
  assertOnline();
  let error: unknown;
  try {
    ({ error } = await supabase.auth.signInWithOtp({
      phone,
      options: { shouldCreateUser: false, channel: 'sms' },
    }));
  } catch (thrown) {
    error = thrown;
  }
  if (error) throw toFlowError(error);
}

export async function verifyOtp(
  identifier: string,
  code: string,
  kind: 'email' | 'sms',
): Promise<void> {
  const token = code.replace(/\s+/g, '');
  if (!/^[0-9]{4,10}$/.test(token)) throw new AuthFlowError('code_invalid');
  assertOnline();
  // The user is proving their identity again: this may replace a locked vault.
  vault.expectFreshSignIn();
  let error: unknown;
  try {
    ({ error } = await supabase.auth.verifyOtp(
      kind === 'email'
        ? { email: identifier.trim().toLowerCase(), token, type: 'email' }
        : { phone: identifier, token, type: 'sms' },
    ));
  } catch (thrown) {
    error = thrown;
  }
  if (error) throw toFlowError(error);
  authNotice.value = null;
}

// ----------------------------------------------------------------------------- PIN

function lockNow(): void {
  const current = session.peek();
  const hadPin = vault.pinSet.peek() === true;
  endingSession = true;
  try {
    vault.lock();
  } finally {
    endingSession = false;
  }
  if (current && !hadPin) {
    // No PIN yet means nothing on disk to come back to: end the server session too.
    authNotice.value = 'session_ended';
    void supabase.auth.admin.signOut(current.access_token, 'local').catch(() => undefined);
  }
}

async function tryUnlock(pinCode: string): Promise<UnlockResult> {
  const result = await vault.unlock(pinCode);
  if (result === 'wiped') authNotice.value = 'pin_wiped';
  if (result === 'ok') authNotice.value = null;
  return result;
}

/**
 * Forgotten PIN: destroys the stored session so that a full sign-in (and a new PIN) is needed.
 * Local records and unsent work stay on the device.
 */
async function forgetPin(): Promise<void> {
  endingSession = true;
  try {
    await vault.wipe();
  } finally {
    endingSession = false;
  }
}

/** Shape of `pin` in docs/contracts/web.md §3.6 (the object below may only add to it). */
interface PinContract {
  isSet(): Promise<boolean>;
  set(pin: string): Promise<void>;
  unlock(pin: string): Promise<boolean>;
  lock(): void;
  locked: Signal<boolean>;
}

export const pin = {
  isSet: (): Promise<boolean> => vault.isSet(),
  set: (pinCode: string): Promise<void> => vault.setPin(pinCode),
  unlock: async (pinCode: string): Promise<boolean> => (await tryUnlock(pinCode)) === 'ok',
  lock: (): void => lockNow(),
  locked: vault.locked,
  // Extensions used by the auth views and the settings screen:
  /** Like `unlock` but tells wrong / throttled / wiped apart. */
  tryUnlock,
  /** Consecutive failures and the time before which the next attempt is refused. */
  attempts: vault.attempts as ReadonlySignal<PinAttempts>,
  maxFailures: MAX_PIN_FAILURES,
  forget: forgetPin,
} as const;

/** Compile-time proof that `pin` offers (at least) the contract shape. */
export type _PinMeetsContract = AssertExtends<typeof pin, PinContract>;

// ----------------------------------------------------------------------------- sign-out

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

async function endLocalSession(): Promise<void> {
  endingSession = true;
  try {
    await vault.wipe();
  } finally {
    endingSession = false;
  }
  settingsLoadedFor = null;
}

/**
 * Signs out of this device. When unsent work exists the user must confirm first (the sync
 * module decides what happens to it in `resetLocalData`). Resolves without doing anything when
 * the user declines. `force` skips the question.
 */
export async function signOut(options: { force?: boolean } = {}): Promise<void> {
  if (!options.force) {
    let pending = { ops: 0, photos: 0 };
    try {
      pending = await ports.pendingWork();
    } catch (error) {
      console.warn('auth: could not read pending work', error);
    }
    if (pending.ops > 0 || pending.photos > 0) {
      const confirmed = await ports.confirm({
        title: t('auth.signout_unsent_title'),
        message: t('auth.signout_unsent_message', { ops: pending.ops, photos: pending.photos }),
        confirmLabel: t('auth.signout_unsent_confirm'),
        danger: true,
      });
      if (!confirmed) return;
    }
  }
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  if (session.peek() && online) {
    // Best effort: revoke the refresh token of this device only (other devices stay signed in).
    // Plain HTTP calls on purpose — a slow answer that arrives after the user has signed in
    // again must not be able to touch the new session.
    const fresh = await withTimeout(supabase.auth.getSession(), 8000);
    const token = fresh?.data.session?.access_token;
    if (token) await withTimeout(supabase.auth.admin.signOut(token, 'local'), 8000);
  }
  await endLocalSession();
  // Nothing is stored any more, so this makes no request: it only tells listeners and other tabs.
  await withTimeout(supabase.auth.signOut({ scope: 'local' }), 3000);
  authNotice.value = null;
  // The sync module keeps unsent work on a sign-out. `auth.last_user_id` is deliberately kept
  // too: if somebody else signs in next, `noteUser` hands that work over ('user_changed')
  // before anything of it can be shown to or pushed as the new user.
  await resetLocalData('sign_out');
}

/**
 * Forces a token refresh after the server refused the access token. Returns true when a
 * session is still held afterwards. A network failure keeps the session (nothing was decided);
 * a definitive refusal of the refresh token ends it — supabase-js keeps a refused session
 * while its access token looks unexpired by the local clock, which would leave the app
 * "signed in" but unable to talk to the server.
 */
async function refreshOrEnd(): Promise<boolean> {
  let error: unknown;
  try {
    ({ error } = await supabase.auth.refreshSession());
  } catch (thrown) {
    error = thrown;
  }
  if (!session.peek()) return false; // supabase-js already removed it (→ notice set by the listener)
  if (!error) return true;
  const name = (error as { name?: unknown }).name;
  if (name === 'AuthRefreshDiscardedError' || isNetworkError(error)) return true;
  await endLocalSession();
  authNotice.value = 'session_ended';
  return false;
}

/** Same shape as the sync engine's `SessionProblem` (src/sync/ports.ts). */
export interface SessionProblem {
  reason: 'not_authenticated' | 'session_revoked' | 'device_revoked';
  /** true: the reporter already removed the local stores. */
  wiped: boolean;
}

let revoking: Promise<void> | null = null;

/**
 * Entry point for the sync engine (`AuthPort.onSessionProblem`) and anybody else who learns
 * from the server that this session can no longer be used.
 *  - `not_authenticated`: try one refresh; only a definitive refusal ends the session. Local
 *    data is kept, the user signs in again.
 *  - `session_revoked` / `device_revoked` (account deactivated, sessions or device revoked by
 *    an administrator): the stored session is destroyed, a full sign-in is required, and the
 *    local stores are removed unless the reporter already did that.
 */
export async function handleSessionProblem(problem: SessionProblem): Promise<void> {
  if (problem.reason === 'not_authenticated') {
    if (session.peek()) await refreshOrEnd();
    return;
  }
  revoking ??= (async () => {
    try {
      await endLocalSession();
      authNotice.value = 'revoked';
      if (!problem.wiped) await resetLocalData('revoked');
    } finally {
      revoking = null;
    }
  })();
  return revoking;
}

/** Shorthand: `my_context().session_ok === false` or `PT403 session_revoked` was observed. */
export function handleSessionRevoked(): Promise<void> {
  return handleSessionProblem({ reason: 'session_revoked', wiped: false });
}

/** A currently valid access token (refreshed when needed), or null when locked / signed out. */
export async function accessToken(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

if (typeof window !== 'undefined') {
  // Decoupled entry point for modules that must not import auth (service worker bridge, …).
  window.addEventListener('istiqama:session-revoked', () => void handleSessionRevoked());
  // Back online: confirm that the account, the roles and the device are still valid.
  window.addEventListener('online', () => {
    if (session.peek()) void refreshContext();
  });
}

// TEMPORARY STUB of src/auth (docs/contracts/web.md §3.6) — see ../README.md.
import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';

export interface MyContext {
  user_id: string;
  profile: {
    id: string;
    full_name: string | null;
    phone: string | null;
    preferred_language: string;
    active: boolean;
  };
  roles: Array<{ role: string; scope_type: string; scope_id: string | null }>;
  assigned_roles: Array<{ role: string; scope_type: string; scope_id: string | null }>;
  capabilities: {
    can_write: boolean;
    can_review: boolean;
    can_see_restricted: boolean;
    can_see_people: boolean;
    is_hq: boolean;
  };
  mfa_required: boolean;
  session_ok: boolean;
  scope_epoch: string;
}

export const session: Signal<unknown | null> = signal(null);
export const me: Signal<MyContext | null> = signal(null);

const cap = (pick: (c: MyContext['capabilities']) => boolean): ReadonlySignal<boolean> =>
  computed(() => (me.value ? pick(me.value.capabilities) : false));

export const can = {
  review: cap((c) => c.can_review),
  seeRestricted: cap((c) => c.can_see_restricted),
  seePeople: cap((c) => c.can_see_people),
  write: cap((c) => c.can_write),
  admin: cap((c) => c.is_hq),
};

interface StubQuery extends PromiseLike<{
  data: Array<Record<string, unknown>> | null;
  error: { message: string } | null;
}> {
  select(columns?: string): StubQuery;
  update(values: Record<string, unknown>): StubQuery;
  eq(column: string, value: unknown): StubQuery;
}

function query(): StubQuery {
  const q: StubQuery = {
    select: () => q,
    update: () => q,
    eq: () => q,
    then: (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject),
  };
  return q;
}

export const supabase = { from: (_table: string): StubQuery => query() };

export async function signInWithEmailOtp(_email: string): Promise<void> {}
export async function signInWithPhoneOtp(_phone: string): Promise<void> {}
export async function verifyOtp(
  _identifier: string,
  _code: string,
  _kind: 'email' | 'sms',
): Promise<void> {}
export async function signOut(): Promise<void> {
  me.value = null;
}

const locked = signal(false);
export const pin = {
  isSet: async (): Promise<boolean> => false,
  set: async (_pin: string): Promise<void> => {},
  unlock: async (_pin: string): Promise<boolean> => true,
  lock: (): void => {},
  locked,
};

export function deviceId(): string {
  return 'stub-device';
}

/** Extension of the real module: idle minutes before the PIN lock. */
export const lockMinutes: Signal<number> = signal(15);

/** Lets a stub build show the complete navigation: open the app with `?stub=all`. */
function demoContext(): MyContext | null {
  if (typeof location === 'undefined' || !new URLSearchParams(location.search).has('stub'))
    return null;
  const role = { role: 'hq_admin', scope_type: 'global', scope_id: null };
  return {
    user_id: 'stub-user',
    profile: {
      id: 'stub-user',
      full_name: 'Stub build',
      phone: null,
      preferred_language: 'ar',
      active: true,
    },
    roles: [role],
    assigned_roles: [role],
    capabilities: {
      can_write: true,
      can_review: true,
      can_see_restricted: true,
      can_see_people: true,
      is_hq: true,
    },
    mfa_required: false,
    session_ok: true,
    scope_epoch: 'stub',
  };
}

export function AuthGate({ children }: { children: ComponentChildren }) {
  if (!me.peek()) me.value = demoContext();
  return <>{children}</>;
}

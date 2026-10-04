/**
 * `my_context()` payload (docs/contracts/sync.md §2) and the pure rules derived from it:
 * capability flags and the MFA gate. No I/O here — everything is unit-testable with fixtures.
 */
export type RoleName =
  'field_collector' | 'branch_supervisor' | 'country_manager' | 'hq_admin' | 'viewer';

export type Aal = 'aal1' | 'aal2';

export interface RoleGrant {
  role: RoleName;
  scope_type: 'global' | 'country' | 'branch';
  scope_id: string | null;
}

export interface ScopeTriple {
  all: boolean;
  countries: string[];
  branches: string[];
}

export interface MyContext {
  user_id: string;
  profile: {
    id: string;
    full_name: string | null;
    phone: string | null;
    preferred_language: 'ar' | 'sw' | 'en' | null;
    active: boolean;
  } | null;
  /** Grants that are effective right now (manager / HQ grants only at aal2). */
  roles: RoleGrant[];
  /** Grants as assigned by an administrator (may still need MFA). */
  assigned_roles: RoleGrant[];
  scopes: {
    read: ScopeTriple;
    people: ScopeTriple;
    write: ScopeTriple;
    review: ScopeTriple;
    restricted: { all: boolean; countries: string[] };
  };
  aal: Aal;
  mfa_required: boolean;
  /** false: account inactive, sessions revoked or device revoked → the client must sign out. */
  session_ok: boolean;
  capabilities: {
    can_write: boolean;
    can_review: boolean;
    can_see_restricted: boolean;
    can_see_people: boolean;
    is_hq: boolean;
  };
  device_id: string | null;
  scope_epoch: string;
  server_time: string;
}

export interface Capabilities {
  review: boolean;
  seeRestricted: boolean;
  seePeople: boolean;
  write: boolean;
  admin: boolean;
  /** Extension: user administration of the own country (country manager) or everything (HQ). */
  manage: boolean;
}

export const NO_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  review: false,
  seeRestricted: false,
  seePeople: false,
  write: false,
  admin: false,
  manage: false,
});

/** Roles for which the brief (§3) makes two-factor authentication mandatory. */
const MFA_ROLES: ReadonlySet<string> = new Set<RoleName>(['country_manager', 'hq_admin']);

function grants(list: unknown): RoleGrant[] {
  return Array.isArray(list) ? (list as RoleGrant[]) : [];
}

/**
 * Must this session pass TOTP before the app becomes usable?
 *
 * `tokenAal` is the `aal` claim of the access token currently held (the freshest fact: right
 * after `mfa.verify` the cached context still says aal1). The context decides who is privileged:
 * `mfa_required` from the server, or — defensively, e.g. with a context cached by an older
 * server — any assigned manager/HQ grant.
 */
export function needsMfa(ctx: MyContext | null, tokenAal: Aal | null): boolean {
  if (!ctx) return false;
  const aal = tokenAal ?? ctx.aal;
  if (aal === 'aal2') return false;
  if (ctx.mfa_required === true) return true;
  return grants(ctx.assigned_roles).some((grant) => MFA_ROLES.has(grant.role));
}

/**
 * Capability flags for the UI. They only hide or show things — the server enforces the real
 * rules (RLS + RPC checks). Fail closed: no context, a revoked session or a pending MFA step
 * means no capability at all.
 */
export function deriveCapabilities(ctx: MyContext | null, tokenAal: Aal | null): Capabilities {
  if (!ctx || ctx.session_ok !== true || needsMfa(ctx, tokenAal)) return NO_CAPABILITIES;
  const caps = ctx.capabilities ?? {};
  const isHq = caps.is_hq === true;
  const effectiveManager = grants(ctx.roles).some((grant) => grant.role === 'country_manager');
  return {
    review: caps.can_review === true,
    seeRestricted: caps.can_see_restricted === true,
    seePeople: caps.can_see_people === true,
    write: caps.can_write === true,
    admin: isHq,
    manage: isHq || effectiveManager,
  };
}

/** Structural check of a payload read from the encrypted cache or the network. */
export function isMyContext(value: unknown): value is MyContext {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<MyContext>;
  return (
    typeof v.user_id === 'string' &&
    typeof v.session_ok === 'boolean' &&
    Array.isArray(v.roles) &&
    typeof v.capabilities === 'object' &&
    v.capabilities !== null
  );
}

export interface AccessTokenClaims {
  sub?: string;
  aal?: string;
  exp?: number;
  iat?: number;
  session_id?: string;
}

/**
 * Reads the (unverified) claims of a JWT. Only used for UI gating — the signature is checked by
 * the server on every request, never in the browser.
 */
export function decodeAccessToken(token: string | null | undefined): AccessTokenClaims | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof claims === 'object' && claims !== null ? (claims as AccessTokenClaims) : null;
  } catch {
    return null;
  }
}

export function tokenAal(token: string | null | undefined): Aal | null {
  const aal = decodeAccessToken(token)?.aal;
  return aal === 'aal1' || aal === 'aal2' ? aal : null;
}

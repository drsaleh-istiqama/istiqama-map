/**
 * Pure rules of the user administration screens: which scope a role may have
 * (people-admin.md §6 `admin_set_role`) and the guard rails the UI shows before the server
 * refuses (last head-office administrator, no self-deactivation).
 * The server enforces all of them again; these only explain and prevent useless calls.
 */
import type { RoleName } from '../auth';
import type { AdminRole, AdminUser, ScopeType } from './types';

/** Allowed scope types per role, in the order the dialog offers them. */
export const ROLE_SCOPES: Readonly<Record<RoleName, readonly ScopeType[]>> = {
  hq_admin: ['global'],
  country_manager: ['country'],
  branch_supervisor: ['branch'],
  field_collector: ['branch', 'country'],
  viewer: ['global', 'country', 'branch'],
};

/** Highest role first (list badges, sorting). */
export const ROLE_RANK: readonly RoleName[] = [
  'hq_admin',
  'country_manager',
  'branch_supervisor',
  'field_collector',
  'viewer',
];

export function scopesFor(role: RoleName | '' | null | undefined): readonly ScopeType[] {
  return role ? (ROLE_SCOPES[role] ?? []) : [];
}

export function isValidRoleScope(role: RoleName, scopeType: ScopeType): boolean {
  return scopesFor(role).includes(scopeType);
}

/** Roles that only work after the user enrolled a second factor (brief §3). */
export function roleNeedsMfa(role: RoleName): boolean {
  return role === 'hq_admin' || role === 'country_manager';
}

function isLiveGlobalHq(grant: Pick<AdminRole, 'role' | 'scope_type'>): boolean {
  return grant.role === 'hq_admin' && grant.scope_type === 'global';
}

/** An "effective" head-office administrator: active profile + a live global hq_admin grant. */
export function isEffectiveHq(user: Pick<AdminUser, 'active' | 'roles'>): boolean {
  return user.active && user.roles.some(isLiveGlobalHq);
}

/** Number of effective head-office administrators in a complete user list. */
export function countEffectiveHq(users: readonly Pick<AdminUser, 'active' | 'roles'>[]): number {
  let n = 0;
  for (const user of users) if (isEffectiveHq(user)) n++;
  return n;
}

/**
 * Removing this grant would leave no head-office administrator (people-admin.md §6,
 * authz.md §4.1). Only meaningful with the complete user list (`allUsers`).
 */
export function isLastHqGrant(
  user: Pick<AdminUser, 'active' | 'roles'>,
  grant: Pick<AdminRole, 'role' | 'scope_type'>,
  allUsers: readonly Pick<AdminUser, 'active' | 'roles'>[],
): boolean {
  if (!isLiveGlobalHq(grant) || !user.active) return false;
  // Another global hq grant of the same user keeps them an administrator.
  const own = user.roles.filter(isLiveGlobalHq).length;
  if (own > 1) return false;
  return countEffectiveHq(allUsers) <= 1;
}

/** Deactivating this user would leave no head-office administrator. */
export function isLastHqUser(
  user: Pick<AdminUser, 'active' | 'roles'>,
  allUsers: readonly Pick<AdminUser, 'active' | 'roles'>[],
): boolean {
  return isEffectiveHq(user) && countEffectiveHq(allUsers) <= 1;
}

export type DeactivateBlock = 'self' | 'last_hq' | null;

/** Why the "deactivate" action is not offered for this user (null = allowed). */
export function deactivateBlock(
  user: Pick<AdminUser, 'id' | 'active' | 'roles'>,
  myUserId: string | null,
  allUsers: readonly Pick<AdminUser, 'active' | 'roles'>[],
): DeactivateBlock {
  if (myUserId && user.id === myUserId) return 'self';
  if (isLastHqUser(user, allUsers)) return 'last_hq';
  return null;
}

/** The same grant already exists (the RPC is idempotent; the dialog says so instead). */
export function hasGrant(
  user: Pick<AdminUser, 'roles'>,
  role: RoleName,
  scopeType: ScopeType,
  scopeId: string | null,
): boolean {
  return user.roles.some(
    (g) =>
      g.role === role &&
      g.scope_type === scopeType &&
      (g.scope_id ?? null) === (scopeType === 'global' ? null : scopeId),
  );
}

/** Roles of a user, highest first. */
export function sortedRoles<T extends { role: RoleName }>(roles: readonly T[]): T[] {
  return [...roles].sort((a, b) => ROLE_RANK.indexOf(a.role) - ROLE_RANK.indexOf(b.role));
}

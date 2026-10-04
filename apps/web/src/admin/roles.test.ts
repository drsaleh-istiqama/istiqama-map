import { describe, expect, it } from 'vitest';
import {
  countEffectiveHq,
  deactivateBlock,
  hasGrant,
  isLastHqGrant,
  isLastHqUser,
  isValidRoleScope,
  roleNeedsMfa,
  scopesFor,
  sortedRoles,
} from './roles';
import type { AdminRole, AdminUser } from './types';

function grant(
  role: AdminRole['role'],
  scope_type: AdminRole['scope_type'],
  scope_id: string | null = null,
  id = `${role}-${scope_id}`,
): AdminRole {
  return {
    id,
    role,
    scope_type,
    scope_id,
    scope_name_ar: null,
    scope_name_en: null,
    scope_name_sw: null,
    country_id: null,
    created_at: '',
  };
}

function user(id: string, roles: AdminRole[], active = true): AdminUser {
  return {
    id,
    full_name: id,
    email: `${id}@example.org`,
    phone: null,
    preferred_language: 'ar',
    active,
    sessions_revoked_at: null,
    created_at: '',
    last_sign_in_at: null,
    roles,
    devices: [],
  };
}

describe('role scopes (people-admin.md §6)', () => {
  it('offers only the scopes the server accepts', () => {
    expect(scopesFor('hq_admin')).toEqual(['global']);
    expect(scopesFor('country_manager')).toEqual(['country']);
    expect(scopesFor('branch_supervisor')).toEqual(['branch']);
    expect(scopesFor('field_collector')).toEqual(['branch', 'country']);
    expect(scopesFor('viewer')).toEqual(['global', 'country', 'branch']);
    expect(scopesFor('')).toEqual([]);
    expect(isValidRoleScope('field_collector', 'global')).toBe(false);
    expect(isValidRoleScope('viewer', 'branch')).toBe(true);
  });

  it('managers and HQ need a second factor', () => {
    expect(roleNeedsMfa('hq_admin')).toBe(true);
    expect(roleNeedsMfa('country_manager')).toBe(true);
    expect(roleNeedsMfa('branch_supervisor')).toBe(false);
  });

  it('sorts roles highest first', () => {
    const sorted = sortedRoles([
      grant('viewer', 'global'),
      grant('hq_admin', 'global'),
      grant('field_collector', 'branch', 'b'),
    ]);
    expect(sorted.map((g) => g.role)).toEqual(['hq_admin', 'field_collector', 'viewer']);
  });

  it('hasGrant compares role, scope type and scope id', () => {
    const u = user('u', [grant('field_collector', 'branch', 'b1')]);
    expect(hasGrant(u, 'field_collector', 'branch', 'b1')).toBe(true);
    expect(hasGrant(u, 'field_collector', 'branch', 'b2')).toBe(false);
    expect(hasGrant(user('v', [grant('viewer', 'global')]), 'viewer', 'global', 'anything')).toBe(
      true,
    );
  });
});

describe('guard rails', () => {
  const hq1 = user('hq1', [grant('hq_admin', 'global')]);
  const hq2 = user('hq2', [grant('hq_admin', 'global')]);
  const formerHq = user('old', [grant('hq_admin', 'global')], false);
  const collector = user('col', [grant('field_collector', 'branch', 'b')]);

  it('counts only active head-office administrators', () => {
    expect(countEffectiveHq([hq1, formerHq, collector])).toBe(1);
    expect(countEffectiveHq([hq1, hq2])).toBe(2);
  });

  it('the last head-office administrator cannot lose the role', () => {
    const all = [hq1, formerHq, collector];
    expect(isLastHqGrant(hq1, hq1.roles[0]!, all)).toBe(true);
    expect(isLastHqGrant(hq1, hq1.roles[0]!, [hq1, hq2])).toBe(false);
    expect(isLastHqGrant(collector, collector.roles[0]!, all)).toBe(false);
  });

  it('a second global HQ grant of the same person makes one of them removable', () => {
    const double = user('dbl', [
      grant('hq_admin', 'global', null, 'a'),
      grant('hq_admin', 'global', null, 'b'),
    ]);
    expect(isLastHqGrant(double, double.roles[0]!, [double])).toBe(false);
  });

  it('the last head-office administrator cannot be deactivated', () => {
    expect(isLastHqUser(hq1, [hq1, collector])).toBe(true);
    expect(isLastHqUser(hq1, [hq1, hq2])).toBe(false);
    expect(deactivateBlock(hq1, 'someone-else', [hq1, collector])).toBe('last_hq');
  });

  it('nobody deactivates themselves', () => {
    expect(deactivateBlock(hq1, 'hq1', [hq1, hq2])).toBe('self');
    expect(deactivateBlock(collector, 'hq1', [hq1, hq2, collector])).toBeNull();
  });
});

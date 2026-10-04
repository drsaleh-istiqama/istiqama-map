/**
 * `my_context()` payloads of the seeded staging accounts.
 *
 * Captured from the live local stack on 2026-10-03 (password grant for the aal1 payloads, the
 * TOTP flow of tests/integration/auth.live.test.ts for hq_admin at aal2). `managerTzAal2` is
 * the one payload that was NOT captured: it is the aal1 capture of the same account with the
 * fields changed as docs/contracts/sync.md §2 and authz.md §2 specify for an effective
 * country_manager.
 */
import type { MyContext } from '../context';

const PEMBA = '58372685-bb04-3409-b7fa-17b08890ee4a';
const MOMBASA = '96366d9e-3682-308d-91ad-e76c7345f6cb';
const TZ = 'e2a6484f-39a5-3135-816a-03ad934d99fd';

export const collectorPemba: MyContext = {
  aal: 'aal1',
  roles: [{ role: 'field_collector', scope_id: PEMBA, scope_type: 'branch' }],
  scopes: {
    read: { all: false, branches: [PEMBA], countries: [] },
    write: { all: false, branches: [PEMBA], countries: [] },
    people: { all: false, branches: [PEMBA], countries: [] },
    review: { all: false, branches: [], countries: [] },
    restricted: { all: false, countries: [] },
  },
  profile: {
    id: '10819483-9a9e-3205-82f7-facf43870673',
    phone: '+255700000001',
    active: true,
    full_name: 'مُدخل بيمبا 1 (تجريبي)',
    preferred_language: 'sw',
  },
  user_id: '10819483-9a9e-3205-82f7-facf43870673',
  device_id: 'dev-auth-fixture',
  session_ok: true,
  scope_epoch: '51fa8d9a307d500d9afb6ad62410fe5c',
  server_time: '2026-10-03T15:43:14.274456+00:00',
  capabilities: {
    is_hq: false,
    can_write: true,
    can_review: false,
    can_see_people: true,
    can_see_restricted: false,
  },
  mfa_required: false,
  assigned_roles: [{ role: 'field_collector', scope_id: PEMBA, scope_type: 'branch' }],
};

export const collectorMombasa: MyContext = {
  aal: 'aal1',
  roles: [{ role: 'field_collector', scope_id: MOMBASA, scope_type: 'branch' }],
  scopes: {
    read: { all: false, branches: [MOMBASA], countries: [] },
    write: { all: false, branches: [MOMBASA], countries: [] },
    people: { all: false, branches: [MOMBASA], countries: [] },
    review: { all: false, branches: [], countries: [] },
    restricted: { all: false, countries: [] },
  },
  profile: {
    id: '4a4cba62-8fcd-38fb-9f45-068f402e6097',
    phone: '+254700000001',
    active: true,
    full_name: 'مُدخل مومباسا (تجريبي)',
    preferred_language: 'sw',
  },
  user_id: '4a4cba62-8fcd-38fb-9f45-068f402e6097',
  device_id: 'dev-auth-fixture',
  session_ok: true,
  scope_epoch: '5d5952370a7f493b55ae99d85447d133',
  server_time: '2026-10-03T15:42:56.965579+00:00',
  capabilities: {
    is_hq: false,
    can_write: true,
    can_review: false,
    can_see_people: true,
    can_see_restricted: false,
  },
  mfa_required: false,
  assigned_roles: [{ role: 'field_collector', scope_id: MOMBASA, scope_type: 'branch' }],
};

export const supervisorPemba: MyContext = {
  aal: 'aal1',
  roles: [{ role: 'branch_supervisor', scope_id: PEMBA, scope_type: 'branch' }],
  scopes: {
    read: { all: false, branches: [PEMBA], countries: [] },
    write: { all: false, branches: [PEMBA], countries: [] },
    people: { all: false, branches: [PEMBA], countries: [] },
    review: { all: false, branches: [PEMBA], countries: [] },
    restricted: { all: false, countries: [] },
  },
  profile: {
    id: '54076ec2-77c2-39f8-be83-a543bb9f3776',
    phone: null,
    active: true,
    full_name: 'مشرف فرع بيمبا (تجريبي)',
    preferred_language: 'sw',
  },
  user_id: '54076ec2-77c2-39f8-be83-a543bb9f3776',
  device_id: 'dev-auth-fixture',
  session_ok: true,
  scope_epoch: '6b3d947189c884457fef286b7ce2fc79',
  server_time: '2026-10-03T15:41:45.872975+00:00',
  capabilities: {
    is_hq: false,
    can_write: true,
    can_review: true,
    can_see_people: true,
    can_see_restricted: false,
  },
  mfa_required: false,
  assigned_roles: [{ role: 'branch_supervisor', scope_id: PEMBA, scope_type: 'branch' }],
};

export const viewerGlobal: MyContext = {
  aal: 'aal1',
  roles: [{ role: 'viewer', scope_id: null, scope_type: 'global' }],
  scopes: {
    read: { all: true, branches: [], countries: [] },
    write: { all: false, branches: [], countries: [] },
    people: { all: false, branches: [], countries: [] },
    review: { all: false, branches: [], countries: [] },
    restricted: { all: false, countries: [] },
  },
  profile: {
    id: '5336c6c1-b7df-3883-a32e-76f3f3bbe656',
    phone: null,
    active: true,
    full_name: 'مستخدم اطلاع (تجريبي)',
    preferred_language: 'en',
  },
  user_id: '5336c6c1-b7df-3883-a32e-76f3f3bbe656',
  device_id: 'dev-auth-fixture',
  session_ok: true,
  scope_epoch: 'fcee309613ff7d4c71d1f5389c9969ee',
  server_time: '2026-10-03T15:41:46.077018+00:00',
  capabilities: {
    is_hq: false,
    can_write: false,
    can_review: false,
    can_see_people: false,
    can_see_restricted: false,
  },
  mfa_required: false,
  assigned_roles: [{ role: 'viewer', scope_id: null, scope_type: 'global' }],
};

const NO_SCOPES: MyContext['scopes'] = {
  read: { all: false, branches: [], countries: [] },
  write: { all: false, branches: [], countries: [] },
  people: { all: false, branches: [], countries: [] },
  review: { all: false, branches: [], countries: [] },
  restricted: { all: false, countries: [] },
};

const NO_CAPS: MyContext['capabilities'] = {
  is_hq: false,
  can_write: false,
  can_review: false,
  can_see_people: false,
  can_see_restricted: false,
};

export const managerTzAal1: MyContext = {
  aal: 'aal1',
  roles: [],
  scopes: NO_SCOPES,
  profile: {
    id: '030b2f24-f80a-3ef1-95e7-b57e6ff98683',
    phone: null,
    active: true,
    full_name: 'مدير تنزانيا (تجريبي)',
    preferred_language: 'en',
  },
  user_id: '030b2f24-f80a-3ef1-95e7-b57e6ff98683',
  device_id: 'dev-auth-fixture',
  session_ok: true,
  scope_epoch: 'e8529c6dc0318cc3b96c13acfdb0120e',
  server_time: '2026-10-03T15:41:46.289951+00:00',
  capabilities: NO_CAPS,
  mfa_required: true,
  assigned_roles: [{ role: 'country_manager', scope_id: TZ, scope_type: 'country' }],
};

export const managerTzAal2: MyContext = {
  aal: 'aal2',
  roles: [{ role: 'country_manager', scope_id: TZ, scope_type: 'country' }],
  scopes: {
    read: { all: false, branches: [], countries: [TZ] },
    write: { all: false, branches: [], countries: [TZ] },
    people: { all: false, branches: [], countries: [TZ] },
    review: { all: false, branches: [], countries: [TZ] },
    restricted: { all: false, countries: [TZ] },
  },
  profile: {
    id: '030b2f24-f80a-3ef1-95e7-b57e6ff98683',
    phone: null,
    active: true,
    full_name: 'مدير تنزانيا (تجريبي)',
    preferred_language: 'en',
  },
  user_id: '030b2f24-f80a-3ef1-95e7-b57e6ff98683',
  device_id: 'dev-auth-fixture',
  session_ok: true,
  scope_epoch: 'e82ba47f3bec3e0f8513bbb0f1922d5d',
  server_time: '2026-10-04T01:17:25.139213+00:00',
  capabilities: {
    is_hq: false,
    can_write: true,
    can_review: true,
    can_see_people: true,
    can_see_restricted: true,
  },
  mfa_required: false,
  assigned_roles: [{ role: 'country_manager', scope_id: TZ, scope_type: 'country' }],
};

export const hqAdminAal1: MyContext = {
  aal: 'aal1',
  roles: [],
  scopes: NO_SCOPES,
  profile: {
    id: '7865ada1-736e-3480-bddd-31742d7d9445',
    phone: null,
    active: true,
    full_name: 'مسؤول الإدارة العليا (تجريبي)',
    preferred_language: 'ar',
  },
  user_id: '7865ada1-736e-3480-bddd-31742d7d9445',
  device_id: 'dev-auth-fixture',
  session_ok: true,
  scope_epoch: '98c467a08cea7340c536d40d40774fc6',
  server_time: '2026-10-03T15:41:46.453315+00:00',
  capabilities: NO_CAPS,
  mfa_required: true,
  assigned_roles: [{ role: 'hq_admin', scope_id: null, scope_type: 'global' }],
};

export const hqAdminAal2: MyContext = {
  aal: 'aal2',
  roles: [{ role: 'hq_admin', scope_id: null, scope_type: 'global' }],
  scopes: {
    read: { all: true, branches: [], countries: [] },
    write: { all: true, branches: [], countries: [] },
    people: { all: true, branches: [], countries: [] },
    review: { all: true, branches: [], countries: [] },
    restricted: { all: true, countries: [] },
  },
  profile: {
    id: '7865ada1-736e-3480-bddd-31742d7d9445',
    phone: null,
    active: true,
    full_name: 'مسؤول الإدارة العليا (تجريبي)',
    preferred_language: 'ar',
  },
  user_id: '7865ada1-736e-3480-bddd-31742d7d9445',
  device_id: '18f95921-39cd-4bb3-95b3-e42041674189',
  session_ok: true,
  scope_epoch: '79973725626c0cae2dc487eace99eb79',
  server_time: '2026-10-03T16:09:24.465603+00:00',
  capabilities: {
    is_hq: true,
    can_write: true,
    can_review: true,
    can_see_people: true,
    can_see_restricted: true,
  },
  mfa_required: false,
  assigned_roles: [{ role: 'hq_admin', scope_id: null, scope_type: 'global' }],
};

/** A JWT-shaped string whose payload carries the given claims (the signature is irrelevant here). */
export function fakeAccessToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.c2lnbmF0dXJl`;
}

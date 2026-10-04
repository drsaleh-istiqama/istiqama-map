import { describe, expect, it } from 'vitest';
import {
  collectorMombasa,
  collectorPemba,
  fakeAccessToken,
  hqAdminAal1,
  hqAdminAal2,
  managerTzAal1,
  managerTzAal2,
  supervisorPemba,
  viewerGlobal,
} from './__fixtures__/myContext';
import {
  NO_CAPABILITIES,
  decodeAccessToken,
  deriveCapabilities,
  isMyContext,
  needsMfa,
  tokenAal,
  type Aal,
  type Capabilities,
  type MyContext,
} from './context';

interface Case {
  name: string;
  ctx: MyContext;
  aal: Aal;
  mfa: boolean;
  caps: Capabilities;
}

const NONE = { ...NO_CAPABILITIES };

const CASES: Case[] = [
  {
    name: 'field_collector (branch) at aal1',
    ctx: collectorPemba,
    aal: 'aal1',
    mfa: false,
    caps: {
      write: true,
      review: false,
      seePeople: true,
      seeRestricted: false,
      admin: false,
      manage: false,
    },
  },
  {
    name: 'field_collector (other country) at aal1',
    ctx: collectorMombasa,
    aal: 'aal1',
    mfa: false,
    caps: {
      write: true,
      review: false,
      seePeople: true,
      seeRestricted: false,
      admin: false,
      manage: false,
    },
  },
  {
    name: 'branch_supervisor at aal1',
    ctx: supervisorPemba,
    aal: 'aal1',
    mfa: false,
    caps: {
      write: true,
      review: true,
      seePeople: true,
      seeRestricted: false,
      admin: false,
      manage: false,
    },
  },
  {
    name: 'viewer at aal1',
    ctx: viewerGlobal,
    aal: 'aal1',
    mfa: false,
    caps: {
      write: false,
      review: false,
      seePeople: false,
      seeRestricted: false,
      admin: false,
      manage: false,
    },
  },
  {
    name: 'country_manager at aal1 (MFA pending)',
    ctx: managerTzAal1,
    aal: 'aal1',
    mfa: true,
    caps: NONE,
  },
  {
    name: 'country_manager at aal2',
    ctx: managerTzAal2,
    aal: 'aal2',
    mfa: false,
    caps: {
      write: true,
      review: true,
      seePeople: true,
      seeRestricted: true,
      admin: false,
      manage: true,
    },
  },
  { name: 'hq_admin at aal1 (MFA pending)', ctx: hqAdminAal1, aal: 'aal1', mfa: true, caps: NONE },
  {
    name: 'hq_admin at aal2',
    ctx: hqAdminAal2,
    aal: 'aal2',
    mfa: false,
    caps: {
      write: true,
      review: true,
      seePeople: true,
      seeRestricted: true,
      admin: true,
      manage: true,
    },
  },
];

describe('capabilities and MFA gate per role and assurance level', () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(isMyContext(c.ctx)).toBe(true);
      expect(needsMfa(c.ctx, c.aal)).toBe(c.mfa);
      expect(deriveCapabilities(c.ctx, c.aal)).toEqual(c.caps);
    });
  }
});

describe('MFA gating logic', () => {
  it('nothing is required without a context', () => {
    expect(needsMfa(null, null)).toBe(false);
    expect(needsMfa(null, 'aal1')).toBe(false);
  });

  it('the token decides: an aal2 token lifts the gate even while the cached context is aal1', () => {
    expect(needsMfa(hqAdminAal1, 'aal2')).toBe(false);
    expect(needsMfa(managerTzAal1, 'aal2')).toBe(false);
  });

  it('…but capabilities still come from the (stale) context until it is refreshed', () => {
    expect(deriveCapabilities(hqAdminAal1, 'aal2')).toEqual(NONE);
  });

  it('a privileged context cached at aal2 is gated again when the token is only aal1', () => {
    expect(needsMfa(hqAdminAal2, 'aal1')).toBe(true);
    expect(needsMfa(managerTzAal2, 'aal1')).toBe(true);
    expect(deriveCapabilities(hqAdminAal2, 'aal1')).toEqual(NONE);
    expect(deriveCapabilities(managerTzAal2, 'aal1')).toEqual(NONE);
  });

  it('falls back to the aal of the context when the token cannot be read', () => {
    expect(needsMfa(hqAdminAal1, null)).toBe(true);
    expect(needsMfa(hqAdminAal2, null)).toBe(false);
  });

  it('assigned manager / HQ grants require MFA even if the server flag is missing', () => {
    const olderServer = { ...managerTzAal1, mfa_required: false };
    expect(needsMfa(olderServer, 'aal1')).toBe(true);
  });

  it('ordinary roles are never asked for a second factor', () => {
    for (const ctx of [collectorPemba, supervisorPemba, viewerGlobal]) {
      expect(needsMfa(ctx, 'aal1')).toBe(false);
      expect(needsMfa(ctx, null)).toBe(false);
    }
  });

  it('a user holding both an ordinary and a privileged grant is gated', () => {
    const mixed: MyContext = {
      ...supervisorPemba,
      mfa_required: true,
      assigned_roles: [...supervisorPemba.assigned_roles, ...managerTzAal1.assigned_roles],
    };
    expect(needsMfa(mixed, 'aal1')).toBe(true);
    expect(deriveCapabilities(mixed, 'aal1')).toEqual(NONE);
  });
});

describe('capabilities fail closed', () => {
  it('no context → nothing', () => {
    expect(deriveCapabilities(null, null)).toEqual(NONE);
    expect(deriveCapabilities(null, 'aal2')).toEqual(NONE);
  });

  it('revoked session → nothing, whatever the flags say', () => {
    expect(deriveCapabilities({ ...hqAdminAal2, session_ok: false }, 'aal2')).toEqual(NONE);
    expect(deriveCapabilities({ ...collectorPemba, session_ok: false }, 'aal1')).toEqual(NONE);
  });

  it('only literal true counts', () => {
    const odd = {
      ...collectorPemba,
      capabilities: { ...collectorPemba.capabilities, can_write: 'yes' as unknown as boolean },
    };
    expect(deriveCapabilities(odd, 'aal1').write).toBe(false);
  });

  it('rejects payloads that are not a context', () => {
    expect(isMyContext(null)).toBe(false);
    expect(isMyContext('x')).toBe(false);
    expect(isMyContext({})).toBe(false);
    expect(isMyContext({ user_id: 'u', session_ok: true, roles: [] })).toBe(false);
  });
});

describe('access token claims', () => {
  it('reads aal from a JWT payload (base64url, UTF-8)', () => {
    const token = fakeAccessToken({ sub: 'user-1', aal: 'aal2', exp: 1_791_044_010, name: 'مدير' });
    expect(decodeAccessToken(token)).toMatchObject({ sub: 'user-1', aal: 'aal2' });
    expect(tokenAal(token)).toBe('aal2');
    expect(tokenAal(fakeAccessToken({ aal: 'aal1' }))).toBe('aal1');
  });

  it('returns null for anything else', () => {
    expect(tokenAal(null)).toBeNull();
    expect(tokenAal('')).toBeNull();
    expect(tokenAal('not-a-jwt')).toBeNull();
    expect(tokenAal('a.b.c')).toBeNull();
    expect(tokenAal(fakeAccessToken({ aal: 'aal9' }))).toBeNull();
    expect(decodeAccessToken(fakeAccessToken({ sub: 'x' }))?.aal).toBeUndefined();
  });
});

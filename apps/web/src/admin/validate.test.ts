import { describe, expect, it } from 'vitest';
import type { AdminUser, BranchRec, CountryRec, FxRateRec, OptionRec } from './types';
import {
  nextSortOrder,
  parseDecimal,
  validateBranch,
  validateCountry,
  validateFxRate,
  validateNewUser,
  validateOption,
  validateRole,
  type CountryDraft,
  type OptionDraft,
} from './validate';

const std = {
  version: 1,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  deleted_at: null,
};

const TZ: CountryRec = {
  ...std,
  id: 'c-tz',
  iso2: 'TZ',
  iso3: 'TZA',
  name_ar: 'تنزانيا',
  name_en: 'Tanzania',
  name_sw: 'Tanzania',
  default_currency: 'TZS',
  active: true,
};
const GONE: CountryRec = {
  ...TZ,
  id: 'c-xx',
  iso2: 'XX',
  iso3: 'XXX',
  name_en: 'Old',
  deleted_at: '2026-01-01T00:00:00Z',
};

const country = (patch: Partial<CountryDraft> = {}): CountryDraft => ({
  iso2: 'ss',
  iso3: 'ssd',
  name_ar: '  جنوب   السودان ',
  name_en: 'South Sudan',
  name_sw: '',
  default_currency: 'ssp',
  active: true,
  ...patch,
});

describe('validateCountry', () => {
  it('normalises codes to upper case, trims names and turns an empty Swahili name into null', () => {
    const r = validateCountry(country(), [TZ], null);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({
      iso2: 'SS',
      iso3: 'SSD',
      name_ar: 'جنوب السودان',
      name_en: 'South Sudan',
      name_sw: null,
      default_currency: 'SSP',
      active: true,
    });
  });

  it('requires codes, Arabic and English names and a currency', () => {
    const r = validateCountry(
      country({ iso2: '', iso3: '', name_ar: ' ', name_en: '', default_currency: '' }),
      [],
      null,
    );
    expect(r.ok).toBe(false);
    expect(Object.keys(r.errors).sort()).toEqual([
      'default_currency',
      'iso2',
      'iso3',
      'name_ar',
      'name_en',
    ]);
    expect(r.errors.iso2?.key).toBe('admin.v_required');
  });

  it('checks the ISO formats', () => {
    const r = validateCountry(
      country({ iso2: 'T1', iso3: 'TZ', default_currency: 'TZSS' }),
      [],
      null,
    );
    expect(r.errors.iso2?.key).toBe('admin.v_iso2');
    expect(r.errors.iso3?.key).toBe('admin.v_iso3');
    expect(r.errors.default_currency?.key).toBe('admin.v_currency');
  });

  it('refuses codes already used, also by a deleted country (the unique index is not partial)', () => {
    const live = validateCountry(country({ iso2: 'tz', iso3: 'SSD' }), [TZ, GONE], null);
    expect(live.errors.iso2).toEqual({ key: 'admin.v_taken', params: { name: 'Tanzania' } });
    const deleted = validateCountry(country({ iso2: 'SS', iso3: 'xxx' }), [TZ, GONE], null);
    expect(deleted.errors.iso3).toEqual({ key: 'admin.v_taken_deleted', params: { name: 'Old' } });
  });

  it('an edit does not clash with itself', () => {
    const r = validateCountry(
      country({ iso2: 'TZ', iso3: 'TZA', default_currency: 'TZS' }),
      [TZ],
      TZ.id,
    );
    expect(r.ok).toBe(true);
  });

  it('limits names to 120 characters', () => {
    const r = validateCountry(country({ name_sw: 'x'.repeat(121) }), [], null);
    expect(r.errors.name_sw).toEqual({ key: 'admin.v_too_long', params: { max: 120 } });
  });
});

describe('validateBranch', () => {
  const PEMBA: BranchRec = {
    ...std,
    id: 'b-pemba',
    country_id: 'c-tz',
    code: 'PEMBA',
    name_ar: 'فرع بيمبا',
    name_en: null,
    name_sw: null,
    admin_area_ids: [],
    active: true,
  };
  const draft = {
    country_id: 'c-tz',
    code: ' dar es salaam ',
    name_ar: 'فرع دار السلام',
    name_en: '',
    name_sw: '',
    admin_area_ids: ['a1', 'a2', 'a1'],
    active: true,
  };

  it('upper-cases the code (spaces become dashes) and de-duplicates the areas', () => {
    const r = validateBranch(draft, [PEMBA], null);
    expect(r.ok).toBe(true);
    expect(r.value.code).toBe('DAR-ES-SALAAM');
    expect(r.value.admin_area_ids).toEqual(['a1', 'a2']);
    expect(r.value.name_en).toBeNull();
  });

  it('needs a country, a valid code and an Arabic name', () => {
    const r = validateBranch({ ...draft, country_id: '', code: 'x', name_ar: '' }, [], null);
    expect(r.errors.country_id?.key).toBe('admin.v_required');
    expect(r.errors.code?.key).toBe('admin.v_branch_code');
    expect(r.errors.name_ar?.key).toBe('admin.v_required');
  });

  it('a code is unique inside its country only', () => {
    expect(validateBranch({ ...draft, code: 'pemba' }, [PEMBA], null).errors.code?.key).toBe(
      'admin.v_taken',
    );
    expect(validateBranch({ ...draft, code: 'pemba', country_id: 'c-ke' }, [PEMBA], null).ok).toBe(
      true,
    );
    expect(validateBranch({ ...draft, code: 'PEMBA' }, [PEMBA], PEMBA.id).ok).toBe(true);
  });
});

describe('validateOption', () => {
  const fishing: OptionRec = {
    ...std,
    id: 'o-fishing',
    list_key: 'livelihoods',
    code: 'fishing',
    name_ar: 'صيد الأسماك',
    name_en: 'Fishing',
    name_sw: 'Uvuvi',
    sort_order: 20,
    active: true,
  };
  const other: OptionRec = {
    ...fishing,
    id: 'o-other',
    code: 'other',
    name_ar: 'أخرى',
    sort_order: 990,
  };
  const draft = (patch: Partial<OptionDraft> = {}): OptionDraft => ({
    code: 'Beekeeping',
    name_ar: 'تربية النحل',
    name_en: 'Beekeeping',
    name_sw: '',
    sort_order: '30',
    active: true,
    ...patch,
  });

  it('accepts a new option with a lower-case code', () => {
    const r = validateOption('livelihoods', draft(), [fishing, other], null);
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({
      list_key: 'livelihoods',
      code: 'beekeeping',
      sort_order: 30,
      name_sw: null,
    });
  });

  it('checks the code format and uniqueness inside the list', () => {
    expect(validateOption('livelihoods', draft({ code: '1abc' }), [], null).errors.code?.key).toBe(
      'admin.v_option_code',
    );
    expect(
      validateOption('livelihoods', draft({ code: 'bee keeping' }), [], null).errors.code?.key,
    ).toBe('admin.v_option_code');
    expect(
      validateOption('livelihoods', draft({ code: 'fishing' }), [fishing], null).errors.code?.key,
    ).toBe('admin.v_taken');
    // Another list may reuse the code.
    expect(
      validateOption('daawa_activities', draft({ code: 'fishing' }), [fishing], null).errors.code,
    ).toBeUndefined();
  });

  it('refuses a second option with the same (normalised) Arabic name in the list', () => {
    const r = validateOption('livelihoods', draft({ name_ar: 'صيد الاسماك' }), [fishing], null);
    expect(r.errors.name_ar?.key).toBe('admin.v_name_duplicate');
    expect(
      validateOption(
        'livelihoods',
        draft({ name_ar: fishing.name_ar, code: 'fishing' }),
        [fishing],
        fishing.id,
      ).ok,
    ).toBe(true);
  });

  it('the order is a whole number from 0 to 9999', () => {
    for (const bad of ['', '-1', '1.5', 'abc', '10000']) {
      expect(
        validateOption('livelihoods', draft({ sort_order: bad }), [], null).errors.sort_order,
      ).toEqual({
        key: 'admin.v_integer_range',
        params: { min: 0, max: 9999 },
      });
    }
  });

  it('nextSortOrder goes after the last option and ignores "other" and deleted rows', () => {
    expect(nextSortOrder([fishing, other])).toBe(30);
    expect(nextSortOrder([{ ...fishing, sort_order: 85 }])).toBe(90);
    expect(nextSortOrder([{ ...fishing, deleted_at: 'x' }])).toBe(10);
    expect(nextSortOrder([])).toBe(10);
  });
});

describe('validateFxRate', () => {
  const tzs: FxRateRec = {
    ...std,
    id: 'fx1',
    currency: 'TZS',
    usd_per_unit: 0.00038,
    effective_date: '2025-01-01',
  };

  it('parses decimals with a comma or a point', () => {
    expect(parseDecimal('0,00038')).toBe(0.00038);
    expect(parseDecimal(' 2.6008 ')).toBe(2.6008);
    expect(parseDecimal('1e-3')).toBeNull();
    expect(parseDecimal('0.12345678901')).toBeNull();
  });

  it('accepts a new rate', () => {
    const r = validateFxRate(
      { currency: 'tzs', usd_per_unit: '0.00039', effective_date: '2026-10-01' },
      [tzs],
      null,
    );
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({
      currency: 'TZS',
      usd_per_unit: 0.00039,
      effective_date: '2026-10-01',
    });
  });

  it('needs a positive rate, a real date and USD = 1', () => {
    const r = validateFxRate(
      { currency: 'TZS', usd_per_unit: '0', effective_date: '2026-02-30' },
      [],
      null,
    );
    expect(r.errors.usd_per_unit?.key).toBe('admin.v_rate');
    expect(r.errors.effective_date?.key).toBe('admin.v_date');
    expect(
      validateFxRate(
        { currency: 'USD', usd_per_unit: '1.1', effective_date: '2026-01-01' },
        [],
        null,
      ).errors.usd_per_unit?.key,
    ).toBe('admin.v_rate_usd');
    expect(
      validateFxRate({ currency: '', usd_per_unit: '', effective_date: '' }, [], null).errors,
    ).toEqual({
      currency: { key: 'admin.v_required' },
      usd_per_unit: { key: 'admin.v_required' },
      effective_date: { key: 'admin.v_required' },
    });
  });

  it('one rate per currency and date (deleted rows included)', () => {
    const draft = { currency: 'TZS', usd_per_unit: '0.0004', effective_date: '2025-01-01' };
    expect(validateFxRate(draft, [tzs], null).errors.effective_date?.key).toBe(
      'admin.v_rate_taken',
    );
    expect(
      validateFxRate(draft, [{ ...tzs, deleted_at: 'x' }], null).errors.effective_date?.key,
    ).toBe('admin.v_rate_taken_deleted');
    expect(validateFxRate(draft, [tzs], tzs.id).ok).toBe(true);
  });
});

describe('validateRole', () => {
  const user: Pick<AdminUser, 'roles'> = {
    roles: [
      {
        id: 'g1',
        role: 'field_collector',
        scope_type: 'branch',
        scope_id: 'b-pemba',
        scope_name_ar: null,
        scope_name_en: null,
        scope_name_sw: null,
        country_id: 'c-tz',
        created_at: '',
      },
    ],
  };

  it('requires a role and a scope matching the role', () => {
    expect(validateRole({ role: '', scope_type: '', scope_id: '' }, user).errors).toEqual({
      role: { key: 'admin.v_required' },
      scope_type: { key: 'admin.v_required' },
    });
    expect(
      validateRole({ role: 'hq_admin', scope_type: 'country', scope_id: 'c-tz' }, user).errors
        .scope_type?.key,
    ).toBe('admin.v_scope_type');
    expect(
      validateRole({ role: 'country_manager', scope_type: 'country', scope_id: '' }, user).errors
        .scope_id?.key,
    ).toBe('admin.v_required');
  });

  it('a global scope sends no scope id', () => {
    const r = validateRole({ role: 'viewer', scope_type: 'global', scope_id: 'ignored' }, user);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ role: 'viewer', scope_type: 'global', scope_id: null });
  });

  it('says when the grant already exists', () => {
    const r = validateRole(
      { role: 'field_collector', scope_type: 'branch', scope_id: 'b-pemba' },
      user,
    );
    expect(r.errors.role?.key).toBe('admin.v_grant_exists');
    expect(
      validateRole({ role: 'field_collector', scope_type: 'country', scope_id: 'c-tz' }, user).ok,
    ).toBe(true);
  });
});

describe('validateNewUser', () => {
  const existing = [{ email: 'hq.admin@example.org', phone: '+255700000001' }];
  const draft = {
    full_name: ' Amina  Said ',
    email: '',
    phone: '',
    preferred_language: 'sw' as const,
    role: '' as const,
    scope_type: '' as const,
    scope_id: '',
  };

  it('needs a name and an e-mail or a phone', () => {
    const r = validateNewUser({ ...draft, full_name: '' }, existing);
    expect(r.errors.full_name?.key).toBe('admin.v_required');
    expect(r.errors.email?.key).toBe('admin.v_email_or_phone');
    expect(r.errors.phone?.key).toBe('admin.v_email_or_phone');
  });

  it('accepts an e-mail only, lower-cased, without a role', () => {
    const r = validateNewUser({ ...draft, email: 'Amina@Example.org' }, existing);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({
      full_name: 'Amina Said',
      email: 'amina@example.org',
      phone: null,
      preferred_language: 'sw',
      role: null,
      scope_type: null,
      scope_id: null,
    });
  });

  it('checks formats and existing accounts', () => {
    expect(validateNewUser({ ...draft, email: 'no-at' }, existing).errors.email?.key).toBe(
      'admin.v_email',
    );
    expect(
      validateNewUser({ ...draft, email: 'HQ.Admin@example.org' }, existing).errors.email?.key,
    ).toBe('admin.v_email_taken');
    expect(validateNewUser({ ...draft, phone: '0712345678' }, existing).errors.phone?.key).toBe(
      'admin.v_phone',
    );
    expect(
      validateNewUser({ ...draft, phone: '+255 700-000001' }, existing).errors.phone?.key,
    ).toBe('admin.v_phone_taken');
    expect(validateNewUser({ ...draft, phone: '+255 712 345 678' }, existing).value.phone).toBe(
      '+255712345678',
    );
  });

  it('validates the optional first role like the role dialog', () => {
    const r = validateNewUser(
      { ...draft, email: 'a@b.org', role: 'branch_supervisor', scope_type: 'branch', scope_id: '' },
      existing,
    );
    expect(r.errors.scope_id?.key).toBe('admin.v_required');
    const ok = validateNewUser(
      {
        ...draft,
        email: 'a@b.org',
        role: 'branch_supervisor',
        scope_type: 'branch',
        scope_id: 'b1',
      },
      existing,
    );
    expect(ok.value).toMatchObject({
      role: 'branch_supervisor',
      scope_type: 'branch',
      scope_id: 'b1',
    });
  });
});

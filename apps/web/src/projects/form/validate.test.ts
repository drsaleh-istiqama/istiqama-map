import { describe, expect, it } from 'vitest';
import { newRow, type ProjectBundle, type Row } from '../../db';
import {
  fieldId,
  orderedErrorKeys,
  serverErrors,
  serverProblem,
  validateForm,
  validateMaintenance,
  type ValidateContext,
} from './validate';

function valid(): ProjectBundle {
  const project = newRow('projects', {
    name_ar: 'مسجد',
    type: 'mosque',
    status: 'active',
    lon: 39.75,
    lat: -5.05,
    country_id: 'c1',
    admin_area_id: 'a1',
  } as Partial<Row<'projects'>>);
  return { project, maintenance: [], photos: [], donors: [], staff: [] };
}

const ctx = (over: Partial<ValidateContext> = {}): ValidateContext => ({
  intent: 'submit',
  extras: { newLocality: null, areaPath: ['a1', null, null] },
  restrictedWrite: true,
  year: 2026,
  ...over,
});

describe('validateForm (v2 validateProject parity + schema checks)', () => {
  it('accepts a complete record', () => {
    expect(validateForm(valid(), ctx())).toEqual({});
  });

  it('requires type, name, status, country', () => {
    const b = valid();
    b.project.type = null as unknown as 'mosque';
    b.project.name_ar = '   ';
    b.project.status = 'x' as 'active';
    b.project.country_id = null;
    const e = validateForm(b, ctx());
    expect(e).toMatchObject({
      type: 'form.errTypeRequired',
      name_ar: 'form.errNameRequired',
      status: 'form.errStatusRequired',
      country: 'form.errCountryRequired',
    });
  });

  it('location: required to submit, optional for a draft, always valid when given', () => {
    const b = valid();
    b.project.lon = null;
    b.project.lat = null;
    expect(validateForm(b, ctx()).location).toBe('form.errLocationRequired');
    expect(validateForm(b, ctx({ intent: 'draft' })).location).toBeUndefined();
    b.project.lon = 200;
    b.project.lat = 10;
    expect(validateForm(b, ctx({ intent: 'draft' })).location).toBe('form.errLocationInvalid');
    b.project.lon = 39;
    b.project.lat = null;
    expect(validateForm(b, ctx({ intent: 'draft' })).location).toBe('form.errLocationInvalid');
  });

  it('area is required to submit', () => {
    const b = valid();
    b.project.admin_area_id = null;
    expect(validateForm(b, ctx()).area).toBe('form.errAreaRequired');
    expect(validateForm(b, ctx({ intent: 'draft' })).area).toBeUndefined();
  });

  it('capacity and counts are non-negative integers; percentages are 0..100', () => {
    const b = valid();
    b.project.capacity = -1;
    b.land = newRow('project_land', { utilization_pct: 120, area_m2: -3 } as Partial<
      Row<'project_land'>
    >);
    b.facilities = newRow('project_facilities', { quran_need: 2.5, hall_capacity: -1 } as Partial<
      Row<'project_facilities'>
    >);
    b.community = newRow('community_profiles', { population: -5, muslim_pct: 101 } as Partial<
      Row<'community_profiles'>
    >);
    b.sensitive = newRow('community_sensitive', {
      ibadi_families: -1,
      omani_student_pct: -0.5,
    } as Partial<Row<'community_sensitive'>>);
    const e = validateForm(b, ctx());
    expect(e).toMatchObject({
      capacity: 'form.errNonNegativeInt',
      'land.utilization_pct': 'form.errPercent',
      'land.area_m2': 'form.errNonNegative',
      'facilities.quran_need': 'form.errNonNegativeInt',
      'facilities.hall_capacity': 'form.errNonNegativeInt',
      'community.population': 'form.errNonNegativeInt',
      'community.muslim_pct': 'form.errPercent',
      'sensitive.ibadi_families': 'form.errNonNegativeInt',
      'sensitive.omani_student_pct': 'form.errPercent',
    });
  });

  it('restricted fields are not validated when the user cannot write them', () => {
    const b = valid();
    b.sensitive = newRow('community_sensitive', { ibadi_families: -1 } as Partial<
      Row<'community_sensitive'>
    >);
    expect(
      validateForm(b, ctx({ restrictedWrite: false }))['sensitive.ibadi_families'],
    ).toBeUndefined();
  });

  it('typed-but-invalid numbers (NaN) are reported', () => {
    const b = valid();
    b.project.capacity = Number.NaN;
    expect(validateForm(b, ctx()).capacity).toBe('form.errNonNegativeInt');
  });

  it('build year range and date consistency', () => {
    const b = valid();
    b.project.build_year = 1700;
    expect(validateForm(b, ctx()).build_year).toBe('form.errBuildYear');
    b.project.build_year = 2010;
    b.project.build_date = '2011-05-01';
    expect(validateForm(b, ctx()).build_date).toBe('form.errBuildDateYear');
    b.project.build_date = '2010-02-30';
    expect(validateForm(b, ctx()).build_date).toBe('form.errDate');
  });

  it('staff: person and role required, end after start, salary checked', () => {
    const b = valid();
    const s = newRow('project_staff', {
      start_date: '2026-05-01',
      end_date: '2026-01-01',
    } as Partial<Row<'project_staff'>>);
    b.staff = [
      {
        ...s,
        person_id: '' as string,
        role: null as unknown as 'imam',
        compensation: newRow('staff_compensation', {
          monthly_amount: -5,
          currency: 'TZS',
        } as Partial<Row<'staff_compensation'>>),
      },
    ];
    const e = validateForm(b, ctx());
    expect(e[`staff.${s.id}.person`]).toBe('form.errPersonRequired');
    expect(e[`staff.${s.id}.role`]).toBe('form.errRoleRequired');
    expect(e[`staff.${s.id}.end_date`]).toBe('form.errEndBeforeStart');
    expect(e[`staff.${s.id}.salary`]).toBe('form.errNonNegative');
  });

  it('donors: donor required, amount non-negative with a currency', () => {
    const b = valid();
    const d = newRow('project_donors', { amount: 10, currency: null } as Partial<
      Row<'project_donors'>
    >);
    b.donors = [{ ...d, donor_id: '' }];
    const e = validateForm(b, ctx());
    expect(e[`donors.${d.id}.donor`]).toBe('form.errDonorRequired');
    expect(e[`donors.${d.id}.currency`]).toBe('form.errRequired');
  });

  it('a new locality needs a name', () => {
    const b = valid();
    b.project.locality_id = 'L1';
    const e = validateForm(
      b,
      ctx({
        extras: {
          newLocality: { id: 'L1', name_ar: ' ', name_latin: '' },
          areaPath: ['a1', null, null],
        },
      }),
    );
    expect(e.locality).toBe('form.errLocalityName');
  });

  it('maintenance entries: description and date required, cost non-negative', () => {
    expect(validateMaintenance({ description: ' ', reported_on: 'x', estimated_cost: -1 })).toEqual(
      {
        description: 'form.errRequired',
        reported_on: 'form.errDate',
        estimated_cost: 'form.errNonNegative',
      },
    );
  });

  it('orders errors as on screen and derives control ids', () => {
    expect(
      orderedErrorKeys({ 'land.area_m2': 'x', status: 'x', type: 'x', capacity: 'x' }),
    ).toEqual(['type', 'status', 'capacity', 'land.area_m2']);
    expect(fieldId('land.area_m2')).toBe('pf-land-area_m2');
  });
});

describe('server rejections → fields', () => {
  it('maps codes, constraints and columns', () => {
    expect(
      serverProblem({ table: 'projects', row_id: 'p', error: { code: 'invalid_coordinates' } })
        .field,
    ).toBe('location');
    expect(
      serverProblem({
        table: 'projects',
        row_id: 'p',
        error: { code: 'check_violation', constraint: 'projects_geom_required_ck' },
      }),
    ).toMatchObject({ field: 'location', message: 'form.errLocationRequired' });
    expect(
      serverProblem({
        table: 'projects',
        row_id: 'p',
        error: { code: 'check_violation', constraint: 'projects_capacity_ck' },
      }).field,
    ).toBe('capacity');
    expect(
      serverProblem({
        table: 'project_land',
        row_id: 'l',
        error: { code: 'check_violation', constraint: 'project_land_utilization_pct_ck' },
      }).field,
    ).toBe('land.utilization_pct');
    expect(
      serverProblem({
        table: 'projects',
        row_id: 'p',
        error: { code: 'locality_country_mismatch' },
      }).field,
    ).toBe('locality');
    expect(
      serverProblem({
        table: 'project_staff',
        row_id: 's1',
        error: { code: 'person_not_available' },
      }).field,
    ).toBe('staff.s1.person');
    expect(
      serverProblem({
        table: 'community_profiles',
        row_id: 'c',
        error: { code: 'invalid_option_value' },
      }).field,
    ).toBe('community');
  });

  it('collects field errors and general messages', () => {
    const out = serverErrors([
      { table: 'projects', row_id: 'p', error: { code: 'forbidden_transition' } },
      { table: 'projects', row_id: 'p', error: { code: 'not_null_violation', column: 'name_ar' } },
      { table: 'projects', row_id: 'p', error: { code: 'internal_error' } },
    ]);
    expect(out.fields).toEqual({ name_ar: 'form.srvInvalidValue' });
    expect(out.general).toEqual(['form.srvTransition', 'form.srvGeneric']);
  });
});

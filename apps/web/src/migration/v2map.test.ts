import { describe, expect, it } from 'vitest';
import {
  AREAS,
  BR_PEMBA,
  JPEG_DATA,
  KE,
  MKOANI,
  PN,
  PN_WETE,
  PNG_1PX,
  PS,
  SAMPLE_PROJECTS,
  TZ,
  WETE,
  XX,
  ZW,
  makeCtx,
  optionId,
  v2Data,
} from './testing/fixtures';
import {
  hasArabic,
  isoDate,
  isoTimestamp,
  mapV2,
  multiValues,
  num,
  photoDataUrl,
  projectKey,
  text,
  yesNo,
  type GeoHint,
} from './v2map';
import type { V2Project } from './v2types';

const codes = (plan: ReturnType<typeof mapV2>, key?: string): string[] =>
  plan.warnings.filter((w) => key === undefined || w.key === key).map((w) => w.code);

const only = (p: Partial<V2Project>): V2Project => ({
  id: 'x1',
  name: 'مسجد',
  type: 'mosque',
  country: 'تنزانيا',
  lat: -5.05,
  lng: 39.72,
  status: 'active',
  ...p,
});

describe('value helpers', () => {
  it('text trims, collapses spaces, keeps numbers, drops the rest', () => {
    expect(text('  a   b ')).toBe('a b');
    expect(text(12)).toBe('12');
    expect(text('')).toBeNull();
    expect(text('   ')).toBeNull();
    expect(text(null)).toBeNull();
    expect(text({})).toBeNull();
    expect(text('abcdef', 3)).toBe('abc');
  });

  it('num reads numbers, numeric strings and Arabic-Indic digits', () => {
    expect(num(5)).toEqual({ value: 5, invalid: false });
    expect(num('١٢٣')).toEqual({ value: 123, invalid: false });
    expect(num('۴٫۵')).toEqual({ value: 4.5, invalid: false });
    expect(num('1,200')).toEqual({ value: 1200, invalid: false });
    expect(num('')).toEqual({ value: null, invalid: false });
    expect(num(undefined)).toEqual({ value: null, invalid: false });
    expect(num('abc')).toEqual({ value: null, invalid: true });
    expect(num(Number.NaN)).toEqual({ value: null, invalid: true });
    expect(num(true)).toEqual({ value: null, invalid: true });
  });

  it('yesNo understands booleans, select values and Arabic labels', () => {
    expect(yesNo(true).value).toBe(true);
    expect(yesNo('yes').value).toBe(true);
    expect(yesNo('نعم').value).toBe(true);
    expect(yesNo('متوفر').value).toBe(true);
    expect(yesNo('no').value).toBe(false);
    expect(yesNo('غير متوفر').value).toBe(false);
    expect(yesNo(0).value).toBe(false);
    expect(yesNo('').value).toBeNull();
    expect(yesNo('maybe')).toEqual({ value: null, invalid: true });
  });

  it('isoDate accepts real dates only; isoTimestamp normalises to UTC', () => {
    expect(isoDate('2019-01-01')).toBe('2019-01-01');
    expect(isoDate('2024-02-29T10:00:00Z')).toBe('2024-02-29');
    expect(isoDate('2023-02-29')).toBeNull();
    expect(isoDate('01/02/2020')).toBeNull();
    expect(isoDate(2020)).toBeNull();
    expect(isoTimestamp('2025-03-01T08:00:00+03:00')).toBe('2025-03-01T05:00:00.000Z');
    expect(isoTimestamp('not a date')).toBeNull();
    expect(isoTimestamp('')).toBeNull();
  });

  it('multiValues splits like v2 normalizeMultiValue', () => {
    expect(multiValues('الزراعة، الصيد ,الصيد;التجارة|x\nذ')).toEqual([
      'الزراعة',
      'الصيد',
      'التجارة',
      'x',
      'ذ',
    ]);
    expect(multiValues(['a', ' a ', '', null, 'b'])).toEqual(['a', 'b']);
    expect(multiValues(undefined)).toEqual([]);
  });

  it('photoDataUrl accepts only the four v2 image types as base64 data URLs', () => {
    expect(photoDataUrl(PNG_1PX)?.mime).toBe('image/png');
    expect(photoDataUrl(JPEG_DATA)?.mime).toBe('image/jpeg');
    expect(photoDataUrl('data:image/WEBP;base64,AAAA')?.mime).toBe('image/webp');
    expect(photoDataUrl('https://tracker.invalid/pixel.png')).toBeNull();
    expect(photoDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(photoDataUrl('data:text/html;base64,PGgxPg==')).toBeNull();
    expect(photoDataUrl('data:image/png;base64,AA AA')).toBeNull();
    expect(photoDataUrl(42)).toBeNull();
  });

  it('hasArabic tells the script of a name', () => {
    expect(hasArabic('مسجد')).toBe(true);
    expect(hasArabic('Msikiti Noor')).toBe(false);
  });

  it('projectKey uses the v2 id, or a stable content hash without photos', () => {
    expect(projectKey({ id: ' demo-1 ' })).toEqual({ key: 'v2:demo-1', v2Id: 'demo-1' });
    const a = projectKey({ name: 'مسجد', lat: 1, lng: 2, photos: [{ data: PNG_1PX }] });
    const b = projectKey({ name: 'مسجد', lat: 1, lng: 2 });
    expect(a.key).toMatch(/^v2:h:[0-9a-f]{16}$/);
    expect(a.key).toBe(b.key);
    expect(projectKey({ name: 'مسجد آخر', lat: 1, lng: 2 }).key).not.toBe(a.key);
  });
});

describe('mapV2 — the v2 sample projects', () => {
  const ctx = makeCtx({
    geo: new Map<string, GeoHint>([
      ['v2:demo-1', { countryId: TZ, areaPath: [PN, PN_WETE, null], adminAreaId: PN_WETE }],
      ['v2:demo-2', { countryId: TZ, areaPath: [PN, null, null], adminAreaId: PN }],
      ['v2:demo-3', { countryId: TZ, areaPath: [PS, null, null], adminAreaId: PS }],
      ['v2:demo-4', { countryId: TZ, areaPath: [ZW, null, null], adminAreaId: ZW }],
      ['v2:demo-5', { countryId: TZ, areaPath: [PS, null, null], adminAreaId: PS }],
    ]),
  });
  const plan = mapV2(v2Data(SAMPLE_PROJECTS), ctx);

  it('every project becomes one draft with its v2 id as external_id', () => {
    expect(plan.projects).toHaveLength(5);
    expect(plan.skipped).toEqual([]);
    expect(plan.projects.map((p) => p.bundle.project.external_id)).toEqual([
      'v2:demo-1',
      'v2:demo-2',
      'v2:demo-3',
      'v2:demo-4',
      'v2:demo-5',
    ]);
    for (const pp of plan.projects) {
      expect(pp.bundle.project.record_state).toBe('draft');
      expect(pp.bundle.project.location_source).toBe('import');
      expect(pp.bundle.project.country_id).toBe(TZ);
      expect(pp.bundle.project.builder).toBe('الاستقامة');
      expect(pp.bundle.project.review_note).toBeNull();
      expect(pp.bundle.project.migration_note).toBeNull();
      expect(pp.projectId).toBe(ctx.ids[`project:${pp.key}`]);
    }
  });

  it('copies names, types, statuses, capacity, coordinates and build year/date', () => {
    const [p1, p2, p3, p4, p5] = plan.projects.map((p) => p.bundle.project);
    expect(p1).toMatchObject({
      name_ar: 'مسجد النور',
      name_latin: null,
      type: 'mosque',
      status: 'active',
      capacity: 350,
      lat: -5.055,
      lon: 39.729,
      build_year: 2019,
      build_date: '2019-01-01',
    });
    expect(p2).toMatchObject({ type: 'school', capacity: 120 });
    expect(p3).toMatchObject({ type: 'combined', capacity: 280 });
    expect(p4).toMatchObject({ status: 'maintenance', capacity: 420, build_year: 2017 });
    expect(p5).toMatchObject({ status: 'building', capacity: 85, build_year: 2023 });
  });

  it('admin area and branch come from the located point; localities match by name', () => {
    const [p1, p2, p3, p4] = plan.projects;
    expect(p1!.bundle.project.admin_area_id).toBe(PN_WETE);
    expect(p1!.bundle.project.locality_id).toBe(WETE);
    expect(p2!.bundle.project.locality_id).toBe(WETE);
    expect(p3!.bundle.project.locality_id).toBe(MKOANI);
    expect(p1!.bundle.project.branch_id).toBe(BR_PEMBA);
    expect(p1!.newLocality).toBeNull();
    // "مدينة زنجبار" is unknown → one proposed locality in the located area
    expect(p4!.newLocality).toMatchObject({
      name_ar: 'مدينة زنجبار',
      status: 'proposed',
      country_id: TZ,
      admin_area_id: ZW,
      lon: 39.199,
      lat: -6.165,
    });
    expect(p4!.bundle.project.locality_id).toBe(p4!.newLocality!.id);
    expect(plan.newLocalities).toHaveLength(1);
    expect(codes(plan, 'v2:demo-4')).toContain('locality_new');
    // Zanzibar is outside the user's branch areas and no other branch covers it here
    expect(p4!.bundle.project.branch_id).toBe(BR_PEMBA);
  });

  it('maintenance notes become one open maintenance entry', () => {
    const m = plan.projects[3]!.bundle.maintenance;
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({
      description: 'مثال تجريبي: يحتاج إلى فحص وصيانة السقف.',
      state: 'open',
      priority: 'medium',
      reported_on: '2026-10-04',
      project_id: plan.projects[3]!.projectId,
    });
    expect(plan.projects.filter((p) => p.bundle.maintenance.length > 0)).toHaveLength(1);
    expect(plan.counts.maintenance).toBe(1);
  });

  it('one new donor per distinct name, linked to both projects', () => {
    expect(plan.newDonors).toHaveLength(1);
    expect(plan.newDonors[0]).toMatchObject({ name_ar: 'متبرع كريم', name_latin: null });
    const d2 = plan.projects[1]!.bundle.donors;
    const d5 = plan.projects[4]!.bundle.donors;
    expect(d2).toHaveLength(1);
    expect(d5).toHaveLength(1);
    expect(d2[0]!.donor_id).toBe(plan.newDonors[0]!.id);
    expect(d5[0]!.donor_id).toBe(plan.newDonors[0]!.id);
    expect(d2[0]!.donor).toBe(plan.newDonors[0]);
    expect(plan.counts).toMatchObject({ donorsNew: 1, donorsReused: 0 });
  });

  it('managers become persons with the manager role (no salary)', () => {
    expect(plan.persons.map((p) => p.name_ar)).toEqual([
      'عبدالله سالم',
      'محمد علي',
      'خالد حسن',
      'سعيد عمر',
      'يوسف عبدالله',
    ]);
    for (const pp of plan.projects) {
      expect(pp.bundle.staff).toHaveLength(1);
      expect(pp.bundle.staff[0]).toMatchObject({ role: 'manager', project_id: pp.projectId });
      expect(pp.bundle.staff[0]!.person).toBeDefined();
      expect(pp.bundle.staff[0]!.compensation).toBeUndefined();
    }
    expect(plan.persons[0]).toMatchObject({ country_id: TZ, branch_id: BR_PEMBA });
  });

  it('the counts summarise the plan', () => {
    expect(plan.counts).toMatchObject({
      input: 5,
      projects: 5,
      skipped: 0,
      persons: 5,
      staff: 5,
      salaries: 0,
      photos: 0,
      localitiesNew: 1,
      withoutLocation: 0,
    });
  });

  it('a resumed run (same id map) produces the same ids for the shared rows', () => {
    const again = mapV2(v2Data(SAMPLE_PROJECTS), makeCtx({ ...ctx, idFor: ctx.idFor }));
    expect(again.projects.map((p) => p.projectId)).toEqual(plan.projects.map((p) => p.projectId));
    expect(again.persons.map((p) => p.id)).toEqual(plan.persons.map((p) => p.id));
    expect(again.newDonors[0]!.id).toBe(plan.newDonors[0]!.id);
    expect(again.newLocalities[0]!.id).toBe(plan.newLocalities[0]!.id);
  });
});

describe('mapV2 — country, area, locality without a located point', () => {
  it('country by Arabic, English or Swahili name; region name → admin area', () => {
    const plan = mapV2(
      v2Data([
        only({ id: 'a', country: 'تنزانيا', region: 'بيمبا الجنوبية', lat: '', lng: '' }),
        only({ id: 'b', country: 'Kenya', region: '', lat: '', lng: '' }),
        only({ id: 'c', country: ' tanzania ', region: 'north pemba', lat: '', lng: '' }),
      ]),
      makeCtx(),
    );
    const [a, b, c] = plan.projects.map((p) => p.bundle.project);
    expect(a).toMatchObject({ country_id: TZ, admin_area_id: PS, branch_id: BR_PEMBA });
    expect(b).toMatchObject({ country_id: KE, admin_area_id: null, branch_id: null });
    expect(c).toMatchObject({ country_id: TZ, admin_area_id: PN });
  });

  it('region "بيمبا" (not an official name) → area unknown, still a draft', () => {
    const plan = mapV2(v2Data([only({ region: 'بيمبا', lat: '', lng: '' })]), makeCtx());
    expect(plan.projects[0]!.bundle.project.admin_area_id).toBeNull();
    expect(codes(plan)).toContain('area_unknown');
  });

  it('unknown country falls back to the user’s only country, with a warning', () => {
    const plan = mapV2(v2Data([only({ country: 'أخرى بلاد', lat: '', lng: '' })]), makeCtx());
    expect(plan.projects[0]!.bundle.project.country_id).toBe(TZ);
    expect(codes(plan)).toContain('country_unknown');
    const none = mapV2(
      v2Data([only({ country: 'أخرى بلاد', lat: '', lng: '' })]),
      makeCtx({ defaultCountryId: null, defaultBranchId: null }),
    );
    expect(none.projects[0]!.bundle.project.country_id).toBeNull();
    expect(none.projects[0]!.bundle.project.branch_id).toBeNull();
  });

  it('the located point wins over the country name (as on the server), with a warning', () => {
    const plan = mapV2(
      v2Data([only({ id: 'm', country: 'كينيا' })]),
      makeCtx({
        geo: new Map([['v2:m', { countryId: TZ, areaPath: [PN, null, null], adminAreaId: PN }]]),
      }),
    );
    expect(plan.projects[0]!.bundle.project.country_id).toBe(TZ);
    expect(codes(plan)).toContain('country_mismatch');
  });

  it('nearby localities reported by the server are matched first', () => {
    const plan = mapV2(
      v2Data([only({ id: 'n', locality: 'تومبي' })]),
      makeCtx({
        geo: new Map([
          [
            'v2:n',
            {
              countryId: TZ,
              areaPath: [PN, null, null],
              adminAreaId: PN,
              localities: [{ id: 'loc-tumbe', name_ar: 'تومبي', name_latin: 'Tumbe' }],
            },
          ],
        ]),
      }),
    );
    expect(plan.projects[0]!.bundle.project.locality_id).toBe('loc-tumbe');
    expect(plan.newLocalities).toEqual([]);
  });

  it('the same unknown locality in two projects is proposed once; Latin names go to name_latin', () => {
    const plan = mapV2(
      v2Data([
        only({ id: '1', locality: 'Kijiji Kipya' }),
        only({ id: '2', locality: 'kijiji  kipya' }),
        only({ id: '3', locality: 'Kijiji Kipya', country: 'كينيا', lat: '', lng: '' }),
      ]),
      makeCtx(),
    );
    expect(plan.newLocalities).toHaveLength(2);
    expect(plan.newLocalities[0]).toMatchObject({
      name_ar: null,
      name_latin: 'Kijiji Kipya',
      country_id: TZ,
    });
    expect(plan.projects[0]!.bundle.project.locality_id).toBe(
      plan.projects[1]!.bundle.project.locality_id,
    );
    expect(plan.projects[2]!.newLocality!.country_id).toBe(KE);
  });

  it('no country at all → the locality cannot be proposed', () => {
    const plan = mapV2(
      v2Data([only({ country: '', locality: 'قرية', lat: '', lng: '' })]),
      makeCtx({ defaultCountryId: null }),
    );
    expect(plan.projects[0]!.bundle.project.locality_id).toBeNull();
    expect(codes(plan)).toContain('locality_skipped');
  });
});

describe('mapV2 — edge cases of the project record', () => {
  it('missing coordinates: still a draft with no point and no location source', () => {
    const plan = mapV2(v2Data([only({ lat: '', lng: '' })]), makeCtx());
    const p = plan.projects[0]!.bundle.project;
    expect(p).toMatchObject({ lon: null, lat: null, location_source: null, record_state: 'draft' });
    expect(codes(plan)).toEqual(['location_missing']);
    expect(plan.counts.withoutLocation).toBe(1);
  });

  it('invalid or half coordinates are dropped with a warning', () => {
    for (const [lat, lng] of [
      [200, 39],
      [-5, ''],
      ['abc', 39],
    ] as const) {
      const plan = mapV2(v2Data([only({ lat, lng })]), makeCtx());
      expect(plan.projects[0]!.bundle.project.lon).toBeNull();
      expect(codes(plan)).toContain('location_invalid');
    }
  });

  it('missing name → a translated fallback name; a Latin name is kept in name_latin too', () => {
    const plan = mapV2(
      v2Data([only({ id: 'nn', name: '  ' }), only({ id: 'lat', name: 'Msikiti wa Noor' })]),
      makeCtx(),
    );
    expect(plan.projects[0]!.bundle.project.name_ar).toBe('v2 project nn');
    expect(codes(plan, 'v2:nn')).toContain('name_missing');
    expect(plan.projects[1]!.bundle.project).toMatchObject({
      name_ar: 'Msikiti wa Noor',
      name_latin: 'Msikiti wa Noor',
    });
  });

  it('unknown type / status → mosque / active with warnings; capacity validated', () => {
    const plan = mapV2(
      v2Data([
        only({ type: 'church', status: 'closed', capacity: '-3' }),
        only({ id: 'c2', capacity: '٤٠' }),
      ]),
      makeCtx(),
    );
    expect(plan.projects[0]!.bundle.project).toMatchObject({
      type: 'mosque',
      status: 'active',
      capacity: null,
    });
    expect(codes(plan, 'v2:x1')).toEqual(
      expect.arrayContaining(['type_unknown', 'status_unknown', 'value_invalid']),
    );
    expect(plan.projects[1]!.bundle.project.capacity).toBe(40);
  });

  it('build year only, invalid build dates, createdAt', () => {
    const plan = mapV2(
      v2Data([
        only({ id: 'y', buildDate: '2015' }),
        only({ id: 'z', buildDate: '1700-01-01' }),
        only({ id: 'w', buildDate: 'last year', createdAt: '2024-05-06T07:08:09.000Z' }),
      ]),
      makeCtx(),
    );
    expect(plan.projects[0]!.bundle.project).toMatchObject({ build_year: 2015, build_date: null });
    expect(plan.projects[1]!.bundle.project).toMatchObject({ build_year: null, build_date: null });
    expect(codes(plan, 'v2:z')).toContain('date_invalid');
    expect(codes(plan, 'v2:w')).toContain('date_invalid');
    expect(plan.projects[2]!.createdAt).toBe('2024-05-06T07:08:09.000Z');
    expect(plan.projects[0]!.createdAt).toBeNull();
  });

  it('duplicate v2 ids: the second one is skipped', () => {
    const plan = mapV2(v2Data([only({ id: 'd' }), only({ id: 'd', name: 'نسخة' })]), makeCtx());
    expect(plan.projects).toHaveLength(1);
    expect(plan.skipped).toEqual([{ key: 'v2:d', name: 'نسخة', reason: 'duplicate_v2_id' }]);
  });

  it('a project without id gets a hash key and is skipped the second time', () => {
    const p = { name: 'بلا معرف', type: 'mosque', lat: -5, lng: 39 };
    const first = mapV2(v2Data([p]), makeCtx());
    expect(first.projects[0]!.key).toMatch(/^v2:h:/);
    const second = mapV2(v2Data([p]), makeCtx({ existingKeys: new Set([first.projects[0]!.key]) }));
    expect(second.projects).toHaveLength(0);
    expect(second.skipped[0]!.reason).toBe('already_migrated');
  });

  it('non-object entries do not crash the mapping', () => {
    const plan = mapV2(v2Data([null as unknown as V2Project, only({ id: 'ok' })]), makeCtx());
    expect(plan.projects.map((p) => p.key)).toContain('v2:ok');
  });
});

describe('mapV2 — idempotent second run', () => {
  it('projects already present (device or server) are skipped, with their people', () => {
    const staff = [{ name: 'أحمد سعيد', role: 'imam' }];
    const data = v2Data(
      [only({ id: 'p1', staff, manager: 'خالد' }), only({ id: 'p2' })],
      [
        { name: 'أحمد سعيد', roles: ['imam'] },
        { name: 'خالد', roles: ['manager'] },
        { name: 'منفرد', roles: ['teacher'] },
      ],
    );
    const plan = mapV2(data, makeCtx({ existingKeys: new Set(['v2:p1']) }));
    expect(plan.projects.map((p) => p.key)).toEqual(['v2:p2']);
    expect(plan.skipped).toEqual([{ key: 'v2:p1', name: 'مسجد', reason: 'already_migrated' }]);
    // only the directory entry without any project becomes a person
    expect(plan.standalonePersons.map((p) => p.name_ar)).toEqual(['منفرد']);
    expect(plan.persons.map((p) => p.name_ar)).toEqual(['منفرد']);
  });

  it('everything present → an empty plan', () => {
    const plan = mapV2(
      v2Data(SAMPLE_PROJECTS),
      makeCtx({ existingKeys: new Set(SAMPLE_PROJECTS.map((p) => `v2:${String(p.id)}`)) }),
    );
    expect(plan.projects).toEqual([]);
    expect(plan.counts).toMatchObject({ projects: 0, skipped: 5, persons: 0 });
  });
});

describe('mapV2 — staff, people and salaries', () => {
  const staffProject = only({
    id: 's1',
    manager: 'خالد حسن',
    phone: '0712345678',
    staff: [
      {
        name: 'أحمد علي',
        role: 'imam',
        birthDate: '1980-05-01',
        region: 'ويتي',
        education: 'ثانوي',
        graduationInstitution: 'معهد',
        salary: 150000,
      },
      { name: 'احمد  علي', role: 'teacher', salary: 0 },
      { name: 'مريم سالم', role: 'teacher', salary: '80000' },
      { name: 'Juma Hamisi', role: 'janitor', salary: -5 },
      { name: '', role: 'teacher', salary: 100 },
      { name: '', role: '', salary: 0 },
      { name: 'خالد حسن', role: 'manager' },
    ],
  });

  it('every staff entry becomes its OWN new person (no merge by name, brief §2.4); roles kept', () => {
    const plan = mapV2(v2Data([staffProject]), makeCtx());
    const staff = plan.projects[0]!.bundle.staff;
    expect(plan.persons.map((p) => [p.name_ar, p.name_latin])).toEqual([
      ['أحمد علي', null],
      ['احمد علي', null],
      ['مريم سالم', null],
      [null, 'Juma Hamisi'],
      ['خالد حسن', null],
      ['خالد حسن', null],
    ]);
    expect(new Set(plan.persons.map((p) => p.id)).size).toBe(6);
    expect(staff.map((s) => [s.person?.name_ar ?? s.person?.name_latin, s.role])).toEqual([
      ['أحمد علي', 'imam'],
      ['احمد علي', 'teacher'],
      ['مريم سالم', 'teacher'],
      ['Juma Hamisi', 'other'],
      ['خالد حسن', 'manager'],
      ['خالد حسن', 'manager'],
    ]);
    // same-name entries (no matching phone) are suggestions for a reviewer, not one person
    expect(plan.mergeSuggestions).toEqual([
      { sourceId: plan.persons[1]!.id, targetId: plan.persons[0]!.id, name: 'احمد علي' },
      { sourceId: plan.persons[5]!.id, targetId: plan.persons[4]!.id, name: 'خالد حسن' },
    ]);
    expect(plan.counts).toMatchObject({ persons: 6, staff: 6, mergeSuggestions: 2 });
    expect(codes(plan)).toContain('staff_without_name');
    expect(codes(plan).filter((c) => c === 'person_possible_duplicate')).toHaveLength(2);
  });

  it('inside ONE project, same name AND same valid phone → one person with both roles', () => {
    const plan = mapV2(
      v2Data([
        only({
          id: 'ph',
          manager: 'خالد حسن',
          phone: '0712345678',
          staff: [
            { name: 'خالد  حسن', role: 'imam', phone: '0712345678' },
            { name: 'خالد حسن', role: 'teacher', phone: '0799999999' },
            { name: 'خالد حسن', role: 'agent', phone: 'not a phone' },
          ],
        }),
      ]),
      makeCtx(),
    );
    const staff = plan.projects[0]!.bundle.staff;
    expect(plan.persons).toHaveLength(3);
    const linked = staff.filter((s) => s.role === 'imam' || s.role === 'manager');
    expect(linked).toHaveLength(2);
    expect(linked[0]!.person_id).toBe(linked[1]!.person_id);
    expect(linked[0]!.person!.phone_e164).toBe('+255712345678');
    // a different phone or an invalid one is never linked
    const others = staff.filter((s) => s.role === 'teacher' || s.role === 'agent');
    expect(new Set([...others.map((s) => s.person_id), linked[0]!.person_id]).size).toBe(3);
    expect(plan.counts.mergeSuggestions).toBe(2);
  });

  it('the same phone in two DIFFERENT projects is not linked either', () => {
    const plan = mapV2(
      v2Data([
        only({ id: 'a', manager: 'خالد حسن', phone: '0712345678' }),
        only({ id: 'b', manager: 'خالد حسن', phone: '0712345678' }),
      ]),
      makeCtx(),
    );
    expect(plan.persons).toHaveLength(2);
    expect(plan.mergeSuggestions).toHaveLength(1);
  });

  it('person details: birth date/year, home area, education, phone of the manager', () => {
    const plan = mapV2(v2Data([staffProject]), makeCtx());
    const ahmad = plan.persons[0]!;
    expect(ahmad).toMatchObject({
      birth_date: '1980-05-01',
      birth_year: 1980,
      home_area_text: 'ويتي',
      education_level: 'ثانوي',
      graduated_from: 'معهد',
      country_id: TZ,
      branch_id: BR_PEMBA,
      phone_e164: null,
    });
    // the project manager (last person) carries the project phone; the staff row of the same
    // name has no phone of its own
    expect(plan.persons[5]!.phone_e164).toBe('+255712345678');
    expect(plan.persons[4]!.phone_e164).toBeNull();
  });

  it('salary > 0 → compensation in the country currency, flagged for review', () => {
    const plan = mapV2(v2Data([staffProject]), makeCtx());
    const pp = plan.projects[0]!;
    const comp = pp.bundle.staff.filter((s) => s.compensation).map((s) => s.compensation!);
    expect(comp).toHaveLength(2);
    expect(comp[0]).toMatchObject({
      monthly_amount: 150000,
      currency: 'TZS',
      effective_from: '2026-10-04',
    });
    expect(comp[0]!.project_staff_id).toBe(pp.bundle.staff[0]!.id);
    expect(comp[1]).toMatchObject({ monthly_amount: 80000, currency: 'TZS' });
    // the flag goes to migration_note (client-writable, migration 0073), never review_note,
    // which is a reviewer field the server ignores from a collector
    expect(pp.bundle.project.migration_note).toBe('REVIEW salary currency TZS');
    expect(pp.bundle.project.review_note).toBeNull();
    expect(codes(plan).filter((c) => c === 'salary_currency_assumed')).toHaveLength(2);
    expect(codes(plan)).toContain('value_invalid'); // the negative salary
    expect(plan.counts.salaries).toBe(2);
  });

  it('effective_from = the v2 update date when it is in the past', () => {
    const plan = mapV2(
      v2Data([
        only({
          updatedAt: '2025-12-31T10:00:00Z',
          staff: [{ name: 'أ', role: 'imam', salary: 5 }],
        }),
      ]),
      makeCtx(),
    );
    expect(plan.projects[0]!.bundle.staff[0]!.compensation!.effective_from).toBe('2025-12-31');
  });

  it('a country without a currency cannot take salaries', () => {
    const plan = mapV2(
      v2Data([
        only({
          country: 'بلد تجريبي',
          lat: '',
          lng: '',
          staff: [{ name: 'س', role: 'imam', salary: 10 }],
        }),
      ]),
      makeCtx(),
    );
    expect(plan.projects[0]!.bundle.project.country_id).toBe(XX);
    expect(plan.projects[0]!.bundle.staff[0]!.compensation).toBeUndefined();
    expect(codes(plan)).toContain('salary_no_currency');
    expect(plan.projects[0]!.bundle.project.migration_note).toBeNull();
  });

  it('the same name in two projects is TWO persons + a merge suggestion (never merged)', () => {
    const plan = mapV2(
      v2Data([
        only({ id: 'a', staff: [{ name: 'عبدالله سالم', role: 'teacher' }] }),
        only({ id: 'b', manager: 'عبدُالله سالم' }),
      ]),
      makeCtx(),
    );
    expect(plan.persons).toHaveLength(2);
    const a = plan.projects[0]!.bundle.staff[0]!.person_id;
    const b = plan.projects[1]!.bundle.staff[0]!.person_id;
    expect(a).not.toBe(b);
    expect(plan.mergeSuggestions).toEqual([{ sourceId: b, targetId: a, name: 'عبدُالله سالم' }]);
    expect(plan.warnings.find((w) => w.code === 'person_possible_duplicate')).toMatchObject({
      key: 'v2:b',
      value: 'عبدُالله سالم',
    });
    expect(plan.counts.staff).toBe(2);
  });

  it('regression: same name in Tanzania and Kenya → two persons, own data, NO suggestion', () => {
    const plan = mapV2(
      v2Data([
        only({
          id: 'tz',
          staff: [{ name: 'محمد علي', role: 'imam', birthDate: '1960-01-01', salary: 100000 }],
        }),
        only({
          id: 'ke',
          country: 'كينيا',
          lat: '',
          lng: '',
          staff: [{ name: 'محمد  علي', role: 'teacher', birthDate: '1999-09-09' }],
        }),
      ]),
      makeCtx(),
    );
    expect(plan.persons).toHaveLength(2);
    const [tz, ke] = plan.projects.map((pp) => pp.bundle.staff[0]!.person!);
    expect(tz!.id).not.toBe(ke!.id);
    expect(tz).toMatchObject({ country_id: TZ, birth_date: '1960-01-01' });
    expect(ke).toMatchObject({ country_id: KE, birth_date: '1999-09-09', birth_year: 1999 });
    // different countries are never proposed for a merge
    expect(plan.mergeSuggestions).toEqual([]);
    expect(codes(plan)).not.toContain('person_possible_duplicate');
  });

  it('person ids are always new (stable per entry within the run), never ids of existing persons', () => {
    const ctx = makeCtx();
    const plan = mapV2(v2Data([only({ manager: 'محمد علي' })]), ctx);
    expect(plan.persons[0]!.id).toBe(ctx.ids['person:v2:x1:manager']);
    expect(plan.persons[0]!.version).toBe(0);
  });

  it('the directory enriches persons and its other entries become persons of their own', () => {
    const plan = mapV2(
      v2Data(
        [only({ manager: 'خالد حسن', staff: [{ name: 'محمد علي', role: 'teacher' }] })],
        [
          { name: 'خالد حسن', roles: ['manager'], phone: '+255777000111' },
          {
            name: 'محمد علي',
            roles: ['teacher'],
            birthDate: '1990-01-02',
            education: 'جامعي',
            salary: 300,
          },
          { name: 'فاطمة', roles: ['teacher'], region: 'مكواني', phone: 'bad phone' },
          { name: '', roles: [] },
        ],
        'v2_local',
      ),
      makeCtx(),
    );
    expect(plan.persons.find((p) => p.name_ar === 'خالد حسن')!.phone_e164).toBe('+255777000111');
    expect(plan.persons.find((p) => p.name_ar === 'محمد علي')).toMatchObject({
      birth_year: 1990,
      education_level: 'جامعي',
    });
    expect(plan.standalonePersons.map((p) => p.name_ar)).toEqual(['فاطمة']);
    expect(plan.standalonePersons[0]).toMatchObject({
      country_id: TZ,
      branch_id: BR_PEMBA,
      home_area_text: 'مكواني',
    });
    expect(codes(plan)).toEqual(
      expect.arrayContaining(['person_without_project', 'phone_invalid']),
    );
    // directory salaries are never turned into compensation (they belong to no assignment)
    expect(plan.counts.salaries).toBe(0);
    expect(plan.counts.persons).toBe(3);
  });

  it('a directory name borne by several entries enriches none of them (v2 kept one record)', () => {
    const plan = mapV2(
      v2Data(
        [
          only({ id: 'a', staff: [{ name: 'محمد علي', role: 'imam' }] }),
          only({ id: 'b', staff: [{ name: 'محمد علي', role: 'teacher' }] }),
        ],
        [{ name: 'محمد علي', roles: ['imam'], birthDate: '1960-01-01', phone: '0712345678' }],
        'v2_local',
      ),
      makeCtx(),
    );
    expect(plan.persons).toHaveLength(2);
    for (const p of plan.persons) expect(p).toMatchObject({ birth_date: null, phone_e164: null });
    expect(plan.standalonePersons).toEqual([]);
    expect(codes(plan, 'person:محمد علي')).toEqual(['person_directory_ambiguous']);
    expect(plan.mergeSuggestions).toHaveLength(1);
  });

  it('a phone without a manager name is reported, invalid birth dates too', () => {
    const plan = mapV2(
      v2Data([
        only({
          phone: '0712345678',
          staff: [{ name: 'ب', role: 'imam', birthDate: '31/12/1980' }],
        }),
      ]),
      makeCtx(),
    );
    expect(codes(plan)).toEqual(expect.arrayContaining(['phone_invalid', 'date_invalid']));
    expect(plan.persons[0]!.birth_date).toBeNull();
  });
});

describe('mapV2 — land, facilities, community, sensitive', () => {
  const full = only({
    land: {
      ownership: 'waqf',
      ownerName: 'الوقف',
      area: '1500',
      utilization: 60,
      expandable: 'yes',
      notes: 'ملاحظة',
    },
    facilities: {
      teacherHousing: false,
      imamHousing: 'no',
      guestHousing: true,
      library: 'متوفر',
      quranCount: '٢٠',
      quranNeed: 30,
      hall: true,
      hallCapacity: 50,
      studentTransport: 'needed',
      studentsLocal: 'غالبهم من مناطق بعيدة',
    },
    community: {
      branchName: 'فرع ويتي',
      population: 4000,
      muslimPercentage: 95,
      daawaActivities: ['حلقات تحفيظ القرآن', 'دروس شرعية', 'نشاط غير معروف'],
      livelihoods: 'الزراعة، الصيد',
      socialChallenges: [],
      ibadiFamilies: 3,
      omaniFamilies: '2',
      omaniStudentPercentage: 10,
      ibadiStudentPercentage: 12.5,
      omaniTeacherPercentage: 0,
      ibadiTeacherPercentage: 100,
      financialCapacity: 'limited',
    },
  });

  it('maps every section with its value rules', () => {
    const plan = mapV2(v2Data([full]), makeCtx());
    const b = plan.projects[0]!.bundle;
    expect(b.land).toMatchObject({
      ownership: 'waqf',
      owner_name: 'الوقف',
      area_m2: 1500,
      utilization_pct: 60,
      expandable: true,
      notes: 'ملاحظة',
      project_id: b.project.id,
    });
    expect(b.facilities).toMatchObject({
      teacher_housing: false,
      imam_housing: false,
      guest_housing: true,
      library: true,
      quran_count: 20,
      quran_need: 30,
      hall: true,
      hall_capacity: 50,
      student_transport: 'needed',
      students_origin: 'distant',
    });
    expect(b.community).toMatchObject({
      branch_name: 'فرع ويتي',
      population: 4000,
      muslim_pct: 95,
      daawa_activities: [
        optionId('daawa_activities', 'quran_memorization_circles'),
        optionId('daawa_activities', 'islamic_lessons'),
        optionId('daawa_activities', 'other'),
      ],
      daawa_activities_other: 'نشاط غير معروف',
      livelihoods: [optionId('livelihoods', 'agriculture'), optionId('livelihoods', 'fishing')],
      livelihoods_other: null,
      social_challenges: [],
    });
    expect(b.sensitive).toMatchObject({
      ibadi_families: 3,
      omani_families: 2,
      omani_student_pct: 10,
      ibadi_student_pct: 12.5,
      omani_teacher_pct: 0,
      ibadi_teacher_pct: 100,
      guest_financial_capacity: 'limited',
    });
    expect(codes(plan)).toEqual(['option_unknown']);
  });

  it('empty sections are not created', () => {
    const plan = mapV2(
      v2Data([
        only({
          land: { ownership: '', area: undefined },
          facilities: {},
          community: { daawaActivities: [] },
        }),
      ]),
      makeCtx(),
    );
    const b = plan.projects[0]!.bundle;
    expect(b.land).toBeUndefined();
    expect(b.facilities).toBeUndefined();
    expect(b.community).toBeUndefined();
    expect(b.sensitive).toBeUndefined();
  });

  it('out-of-range and unknown values become null with a warning per field', () => {
    const plan = mapV2(
      v2Data([
        only({
          land: { ownership: 'rented', utilization: 140, area: -1, expandable: 'perhaps' },
          facilities: { studentTransport: 'boat', quranCount: 'many' },
          community: {
            muslimPercentage: 101,
            population: -4,
            financialCapacity: 'rich',
            omaniTeacherPercentage: 'x',
          },
        }),
      ]),
      makeCtx(),
    );
    const b = plan.projects[0]!.bundle;
    expect(b.land).toBeUndefined();
    expect(b.facilities).toBeUndefined();
    expect(b.community).toBeUndefined();
    expect(b.sensitive).toBeUndefined();
    const fields = plan.warnings.filter((w) => w.code === 'value_invalid').map((w) => w.field);
    expect(fields).toEqual([
      'land.ownership',
      'land.area',
      'land.utilization',
      'land.expandable',
      'facilities.quranCount',
      'facilities.studentTransport',
      'community.population',
      'community.muslimPercentage',
      'community.omaniTeacherPercentage',
      'community.financialCapacity',
    ]);
  });

  it('v2 Arabic labels of the enumerations are accepted', () => {
    const plan = mapV2(
      v2Data([
        only({
          land: { ownership: 'ملك الجمعية' },
          facilities: { studentTransport: 'حافلة متوفرة' },
          community: { financialCapacity: 'جيدة' },
        }),
      ]),
      makeCtx(),
    );
    const b = plan.projects[0]!.bundle;
    expect(b.land!.ownership).toBe('association');
    expect(b.facilities!.student_transport).toBe('available');
    expect(b.sensitive!.guest_financial_capacity).toBe('good');
  });

  it('only "other" texts: the other option is set with the text', () => {
    const plan = mapV2(
      v2Data([only({ community: { proposedActivities: 'برنامج صيفي' } })]),
      makeCtx(),
    );
    expect(plan.projects[0]!.bundle.community).toMatchObject({
      proposed_activities: [optionId('proposed_activities', 'other')],
      proposed_activities_other: 'برنامج صيفي',
    });
  });
});

describe('mapV2 — photos', () => {
  it('photos[] and the legacy photo, validated, categories and captions kept', () => {
    const plan = mapV2(
      v2Data([
        only({
          photos: [
            { id: 'p1', data: PNG_1PX, category: 'mosque_front', caption: 'الواجهة' },
            { id: 'p2', data: 'https://tracker.invalid/pixel.png', category: 'land' },
            { id: 'p3', data: JPEG_DATA, category: 'sunset', caption: 'x'.repeat(300) },
            'not-an-object',
          ],
          photo: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
        }),
      ]),
      makeCtx(),
    );
    const photos = plan.projects[0]!.photos;
    expect(photos.map((p) => [p.index, p.mime, p.category])).toEqual([
      [0, 'image/png', 'mosque_front'],
      [2, 'image/jpeg', 'unspecified'],
      [4, 'image/gif', 'unspecified'],
    ]);
    expect(photos[0]!.caption).toBe('الواجهة');
    expect(photos[1]!.caption).toHaveLength(160);
    expect(plan.warnings.filter((w) => w.code === 'photo_rejected').map((w) => w.field)).toEqual([
      'photos[1]',
      'photos[3]',
    ]);
    expect(plan.counts).toMatchObject({ photos: 3, photosRejected: 2 });
  });

  it('the legacy photo alone (v2 < 2.5) is migrated; the same image twice only once', () => {
    const legacy = mapV2(v2Data([only({ photo: PNG_1PX })]), makeCtx());
    expect(legacy.projects[0]!.photos).toHaveLength(1);
    expect(legacy.projects[0]!.photos[0]!.category).toBe('unspecified');
    const both = mapV2(v2Data([only({ photos: [{ data: PNG_1PX }], photo: PNG_1PX })]), makeCtx());
    expect(both.projects[0]!.photos).toHaveLength(1);
    const unsafe = mapV2(v2Data([only({ photo: 'https://tracker.invalid/x.png' })]), makeCtx());
    expect(unsafe.projects[0]!.photos).toHaveLength(0);
    expect(codes(unsafe)).toEqual(['photo_rejected']);
  });

  it('at most 10 photos per project', () => {
    const photos = Array.from({ length: 12 }, (_, i) => ({ data: PNG_1PX, caption: `#${i}` }));
    const plan = mapV2(v2Data([only({ photos })]), makeCtx());
    expect(plan.projects[0]!.photos).toHaveLength(10);
    expect(plan.projects[0]!.photos[9]!.caption).toBe('#9');
    expect(codes(plan)).toEqual(['photos_over_limit']);
  });
});

describe('mapV2 — visible donors are reused', () => {
  it('a donor the user can see with the same normalised name is linked, none created', () => {
    const plan = mapV2(
      v2Data([only({ donor: 'مُتبرِّع كريم' }), only({ id: 'b', donor: 'Generous Donor' })]),
      makeCtx({ donors: [{ id: 'donor-1', name_ar: 'متبرع كريم', name_latin: 'generous donor' }] }),
    );
    expect(plan.newDonors).toEqual([]);
    expect(plan.projects[0]!.bundle.donors[0]).toMatchObject({ donor_id: 'donor-1' });
    expect(plan.projects[0]!.bundle.donors[0]!.donor).toBeUndefined();
    expect(plan.projects[1]!.bundle.donors[0]!.donor_id).toBe('donor-1');
    // Two spellings, one donor: counted once.
    expect(plan.counts).toMatchObject({ donorsNew: 0, donorsReused: 1 });
  });
});

describe('fixtures sanity', () => {
  it('the geography fixture is consistent', () => {
    expect(AREAS.every((a) => a.country_id === TZ)).toBe(true);
  });
});

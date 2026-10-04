import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth', async () => {
  const phone = await import('../auth/phone');
  return { DIAL_COUNTRIES: phone.DIAL_COUNTRIES };
});

import * as fixtures from '../auth/__fixtures__/myContext';
import { applyServerRows, db, softDelete, type PersonCursor, type Row } from '../db';
import { freshDb, outbox, serverProject, serverRow } from '../db/testing/factory';
// Test-only: the drift guard compares the people module's query words with the index's own.
import { queryWords as dbQueryWords } from '../db/tokens';
import { cleanDraft, createPerson, updatePerson } from './persons';
import {
  currentPay,
  defaultDial,
  listMergeRequests,
  loadPersonDetail,
  personQueryWords,
  searchPersonsPage,
  serverDefaultsScope,
  summarisePeople,
  writableBranches,
} from './queries';

const TZ = 'e2a6484f-39a5-3135-816a-03ad934d99fd';
const KE = '0c000000-0000-4000-8000-000000000001';
const PEMBA = '58372685-bb04-3409-b7fa-17b08890ee4a';
const MOMBASA = '96366d9e-3682-308d-91ad-e76c7345f6cb';
const PERSON = '0190c000-0000-7000-8000-000000000001';
const PROJECT = '0190c000-0000-7000-8000-0000000000a1';
const OTHER_PROJECT = '0190c000-0000-7000-8000-0000000000a2';

beforeEach(async () => {
  await freshDb({ canSeeRestricted: true });
  await applyServerRows('countries', [
    serverRow('countries', {
      id: TZ,
      iso2: 'TZ',
      name_ar: 'تنزانيا',
      name_en: 'Tanzania',
      active: true,
    }),
    serverRow('countries', {
      id: KE,
      iso2: 'KE',
      name_ar: 'كينيا',
      name_en: 'Kenya',
      active: true,
    }),
  ]);
  await applyServerRows('branches', [
    serverRow('branches', {
      id: PEMBA,
      country_id: TZ,
      code: 'PEMBA',
      name_ar: 'بيمبا',
      admin_area_ids: [],
      active: true,
    }),
    serverRow('branches', {
      id: MOMBASA,
      country_id: KE,
      code: 'MOMBASA',
      name_ar: 'ممباسا',
      admin_area_ids: [],
      active: true,
    }),
  ]);
});

describe('calling code of the user’s country', () => {
  it('comes from the single country of the write scope', async () => {
    expect(await defaultDial(fixtures.collectorPemba)).toBe('255');
    expect(await defaultDial(fixtures.collectorMombasa)).toBe('254');
    expect(await defaultDial(fixtures.managerTzAal2)).toBe('255');
  });

  it('falls back to the device time zone for global users', async () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const expected = tz === 'Africa/Dar_es_Salaam' ? '255' : tz === 'Asia/Muscat' ? '968' : null;
    const got = await defaultDial(fixtures.hqAdminAal2);
    if (expected) expect(got).toBe(expected);
    else expect(got === null || /^\d{3}$/.test(got)).toBe(true);
  });
});

describe('scope of a new person', () => {
  it('the server defaults it only for a single-branch writer', () => {
    expect(serverDefaultsScope(fixtures.collectorPemba)).toBe(true);
    expect(serverDefaultsScope(fixtures.managerTzAal2)).toBe(false);
    expect(serverDefaultsScope(fixtures.hqAdminAal2)).toBe(false);
    expect(serverDefaultsScope(null)).toBe(false);
  });

  it('offers the branches the user may write to', async () => {
    expect((await writableBranches(fixtures.managerTzAal2)).map((b) => b.id)).toEqual([PEMBA]);
    expect((await writableBranches(fixtures.hqAdminAal2)).map((b) => b.id).sort()).toEqual(
      [PEMBA, MOMBASA].sort(),
    );
    expect(await writableBranches(fixtures.viewerGlobal)).toEqual([]);
  });
});

describe('person card data', () => {
  beforeEach(async () => {
    await applyServerRows('persons', [
      serverRow('persons', { id: PERSON, name_ar: 'محمد علي', country_id: TZ, branch_id: PEMBA }),
    ]);
    await applyServerRows('projects', [
      serverProject({ id: PROJECT, code: 'TZ-PN-000001', name_ar: 'مسجد النور' }),
    ]);
    await applyServerRows('project_staff', [
      serverRow('project_staff', {
        id: 's-current',
        project_id: PROJECT,
        person_id: PERSON,
        role: 'imam',
        start_date: '2020-01-01',
        end_date: null,
      }),
      serverRow('project_staff', {
        id: 's-ended',
        project_id: PROJECT,
        person_id: PERSON,
        role: 'teacher',
        start_date: '2015-01-01',
        end_date: '2019-12-31',
      }),
      // A project that is not on the device (outside the read scope).
      serverRow('project_staff', {
        id: 's-hidden',
        project_id: OTHER_PROJECT,
        person_id: PERSON,
        role: 'agent',
        start_date: null,
        end_date: null,
      }),
    ]);
    await applyServerRows('staff_compensation', [
      serverRow('staff_compensation', {
        project_staff_id: 's-current',
        monthly_amount: 200000,
        currency: 'TZS',
        effective_from: '2023-01-01',
      }),
      serverRow('staff_compensation', {
        project_staff_id: 's-current',
        monthly_amount: 250000,
        currency: 'TZS',
        effective_from: '2024-01-01',
      }),
      serverRow('staff_compensation', {
        project_staff_id: 's-current',
        monthly_amount: 999999,
        currency: 'TZS',
        effective_from: '2999-01-01',
      }),
    ]);
  });

  it('lists assignments (current first), counts hidden ones and reads pay only when allowed', async () => {
    const withPay = (await loadPersonDetail(PERSON, { withPay: true }))!;
    expect(withPay.assignments.map((a) => a.staff.id)).toEqual(['s-current', 's-ended']);
    expect(withPay.assignments.map((a) => a.current)).toEqual([true, false]);
    expect(withPay.hidden).toBe(1);
    expect(withPay.assignments[0]!.pay!.monthly_amount).toBe(250000); // in force today, not the future one
    const noPay = (await loadPersonDetail(PERSON, { withPay: false }))!;
    expect(noPay.assignments.every((a) => a.pay === null)).toBe(true);
    expect(await loadPersonDetail('missing', { withPay: false })).toBeNull();
  });

  it('summarises roles and projects for directory rows', async () => {
    const person = (await db.persons.get(PERSON)) as Row<'persons'>;
    const summary = (await summarisePeople([person])).get(PERSON)!;
    expect(summary.roles.sort()).toEqual(['agent', 'imam', 'teacher']);
    expect(summary.projects).toBe(2);
  });

  it('currentPay picks the latest row not in the future', () => {
    const row = (from: string, amount: number) =>
      ({
        effective_from: from,
        monthly_amount: amount,
        deleted_at: null,
      }) as Row<'staff_compensation'>;
    expect(
      currentPay([row('2024-01-01', 1), row('2025-01-01', 2)], '2025-06-01')!.monthly_amount,
    ).toBe(2);
    expect(currentPay([row('2026-01-01', 3)], '2025-06-01')!.monthly_amount).toBe(3);
    expect(currentPay([], '2025-06-01')).toBeNull();
  });
});

describe('merge trail order', () => {
  it('pending requests first, then decided ones, newest first', async () => {
    await applyServerRows('person_merge_requests', [
      serverRow('person_merge_requests', {
        id: 'r-old',
        source_person_id: 'a',
        target_person_id: 'b',
        state: 'merged',
        decided_at: '2026-01-01T00:00:00Z',
      }),
      serverRow('person_merge_requests', {
        id: 'r-new',
        source_person_id: 'c',
        target_person_id: 'd',
        state: 'reverted',
        decided_at: '2026-09-01T00:00:00Z',
      }),
      serverRow('person_merge_requests', {
        id: 'r-pending',
        source_person_id: 'e',
        target_person_id: 'f',
        state: 'pending',
      }),
    ]);
    expect((await listMergeRequests()).map((r) => r.id)).toEqual(['r-pending', 'r-new', 'r-old']);
  });
});

describe('person writes', () => {
  it('createPerson inserts through mutate() with the scope it is given', async () => {
    const id = await createPerson(
      { name_ar: '  سالم   خميس ', name_latin: '', phone_e164: '+255777123456', birth_year: 1981 },
      { countryId: TZ, branchId: PEMBA },
    );
    const row = (await db.persons.get(id))!;
    expect(row).toMatchObject({
      name_ar: 'سالم خميس',
      name_latin: null,
      phone_e164: '+255777123456',
      birth_year: 1981,
      country_id: TZ,
      branch_id: PEMBA,
      version: 0,
    });
    const [op] = await outbox();
    expect(op).toMatchObject({ table: 'persons', row_id: id, kind: 'upsert', base_version: 0 });
    expect(op!.fields).not.toHaveProperty('merged_into_id');
    await expect(createPerson({ name_ar: '  ' })).rejects.toThrow('name_ar_required');
  });

  it('updatePerson sends only the changed fields and can clear one', async () => {
    await applyServerRows('persons', [
      serverRow('persons', {
        id: PERSON,
        name_ar: 'محمد علي',
        name_latin: 'Mohamed',
        education_level: 'ثانوي',
        country_id: TZ,
        branch_id: PEMBA,
      }),
    ]);
    const before = (await db.persons.get(PERSON)) as Row<'persons'>;
    const changed = await updatePerson(before, {
      name_ar: 'محمد علي',
      name_latin: 'Mohamed Ali',
      education_level: '',
    });
    expect(changed.sort()).toEqual(['education_level', 'name_latin']);
    const [op] = await outbox();
    expect(op!.fields).toEqual({ name_latin: 'Mohamed Ali', education_level: null });
    expect(
      await updatePerson((await db.persons.get(PERSON))!, {
        name_ar: 'محمد علي',
        name_latin: 'Mohamed Ali',
      }),
    ).toEqual([]);
  });

  it('cleanDraft drops empty values', () => {
    expect(
      cleanDraft({ name_ar: ' أ ', name_latin: ' ', education_level: '', birth_year: Number.NaN }),
    ).toEqual({ name_ar: 'أ' });
  });
});

describe('directory search in keyset pages (brief §5)', () => {
  const pid = (i: number): string => `0190d000-0000-7000-8000-${String(i).padStart(12, '0')}`;

  /** `n` persons named "محمد سالم NNN" / "Mohamed Salim NNN", plus two that do not match. */
  async function seedMany(n: number): Promise<void> {
    const rows = [];
    for (let i = 0; i < n; i++) {
      const tag = String(i).padStart(3, '0');
      rows.push(
        serverRow('persons', {
          id: pid(i),
          name_ar: `محمد سالم ${tag}`,
          name_latin: `Mohamed Salim ${tag}`,
          country_id: TZ,
          branch_id: PEMBA,
        }),
      );
    }
    rows.push(
      serverRow('persons', { id: pid(900), name_ar: 'خالد حسن', country_id: TZ }),
      serverRow('persons', { id: pid(901), name_ar: 'سالم خميس', country_id: TZ }),
    );
    await applyServerRows('persons', rows);
  }

  /** Every page of a query, following the cursors. */
  async function allPages(q: string, limit = 50) {
    const pages: Array<{ ids: string[]; total: number }> = [];
    let after: PersonCursor | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const page = await searchPersonsPage(q, after, limit);
      if (!page) throw new Error('no searchable word');
      pages.push({ ids: page.rows.map((r) => r.id), total: page.total });
      if (!page.next) break;
      after = page.next;
    }
    return pages;
  }

  it('the query words are the twin of the local index (src/db)', () => {
    for (const q of [
      'محمد سالم',
      'النور  الهدى',
      'Mohamed  ALI',
      'أحمد إبراهيم آل',
      'مُحَمَّد',
      'a b cd',
      'x',
      '',
      'Žanić 0012',
      'الكبيرةجدا'.repeat(5),
    ]) {
      expect(personQueryWords(q), q).toEqual(dbQueryWords(q));
    }
  });

  it('120 matches come in pages of 50, 50 and 20, in directory order, none missing', async () => {
    await seedMany(120);
    const pages = await allPages('Salim');
    expect(pages.map((p) => p.ids.length)).toEqual([50, 50, 20]);
    expect(pages.every((p) => p.total === 120)).toBe(true);
    const ids = pages.flatMap((p) => p.ids);
    expect(new Set(ids).size).toBe(120);
    expect(ids).toEqual(Array.from({ length: 120 }, (_, i) => pid(i)));
    // The Arabic name and two words (every word must start a word of the name).
    expect((await allPages('محمد سال')).flatMap((p) => p.ids)).toHaveLength(120);
    expect((await allPages('سالم')).flatMap((p) => p.ids)).toHaveLength(121);
    expect((await allPages('سالم خميس')).flatMap((p) => p.ids)).toEqual([pid(901)]);
  });

  it('a large match set walks the name index: 260 matches, the same order and no gap', async () => {
    await seedMany(260);
    const pages = await allPages('Mohamed', 50);
    expect(pages.map((p) => p.ids.length)).toEqual([50, 50, 50, 50, 50, 10]);
    expect(pages[0]!.total).toBe(260);
    expect(pages.flatMap((p) => p.ids)).toEqual(Array.from({ length: 260 }, (_, i) => pid(i)));
  });

  it('leaves out a person deleted on this device before the push', async () => {
    await seedMany(3);
    await softDelete('persons', pid(1));
    const [page] = await allPages('Salim');
    expect(page!.ids).toEqual([pid(0), pid(2)]);
    expect(page!.total).toBe(2);
  });

  it('answers null for a query without a searchable word, an empty page for no match', async () => {
    await seedMany(3);
    expect(await searchPersonsPage('m', null)).toBeNull();
    expect(await searchPersonsPage('zzzz', null)).toEqual({ rows: [], next: null, total: 0 });
  });
});

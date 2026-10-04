/**
 * Offline twins of `project_duplicates` (geo-search-tiles.md §3) and `person_candidates`
 * (people-admin.md §3). They only list possible matches — never merge or change anything.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyServerRows } from './apply';
import { db } from './dexie';
import { findLocalDuplicates, findLocalPersonCandidates, normalizePhone } from './match';
import { saveAppSettings } from './meta';
import { USER_A, freshDb, outbox, serverProject, serverRow, tid } from './testing/factory';
import type { Row } from './types';

const BASE = { lon: 39.75, lat: -5.05 };
/** A point `m` metres north of BASE. */
const north = (m: number): { lon: number; lat: number } => ({
  lon: BASE.lon,
  lat: BASE.lat + m / 111195,
});
const LOCALITY = tid(0x60);

beforeEach(async () => {
  await freshDb();
});

describe('findLocalDuplicates', () => {
  let near100: Row<'projects'>;
  let near200: Row<'projects'>;
  let school90: Row<'projects'>;
  let combined120: Row<'projects'>;
  let sameName: Row<'projects'>;
  let farSameName: Row<'projects'>;

  beforeEach(async () => {
    near100 = serverProject({
      name_ar: 'مسجد بلال',
      type: 'mosque',
      ...north(100),
      created_by: USER_A,
    });
    near200 = serverProject({ name_ar: 'مسجد عمر', type: 'mosque', ...north(200) });
    school90 = serverProject({ name_ar: 'مدرسة الأمل', type: 'school', ...north(-90) });
    combined120 = serverProject({ name_ar: 'مجمع الهدى', type: 'combined', ...north(120) });
    sameName = serverProject({
      name_ar: 'مسجد النور الكبير',
      type: 'mosque',
      ...north(3000),
      locality_id: LOCALITY,
    });
    farSameName = serverProject({ name_ar: 'مسجد النور الكبير', type: 'mosque', ...north(9000) });
    await applyServerRows('projects', [
      near100,
      near200,
      school90,
      combined120,
      sameName,
      farSameName,
    ]);
  });

  it('nearby: same type within 150 m; combined overlaps with mosque and school', async () => {
    const hits = await findLocalDuplicates({ type: 'mosque', ...BASE, name: '' });
    expect(hits.map((h) => h.id)).toEqual([near100.id, combined120.id]);
    expect(hits[0]).toMatchObject({ reason: 'nearby', similarity: null, created_by_me: true });
    expect(hits[0]!.distance_m).toBeGreaterThan(99);
    expect(hits[0]!.distance_m).toBeLessThan(101);
    const forCombined = await findLocalDuplicates({ type: 'combined', ...BASE, name: '' });
    expect(forCombined.map((h) => h.id).sort()).toEqual(
      [near100.id, school90.id, combined120.id].sort(),
    );
  });

  it('similar name: similarity >= 0.6 with a project of the same locality, wherever it is', async () => {
    // 6 km away from everything: only the name rule can match
    const hits = await findLocalDuplicates({
      type: 'school',
      ...north(6000),
      name: 'مسجد النور',
      localityId: LOCALITY,
    });
    expect(hits.map((h) => [h.id, h.reason])).toEqual([[sameName.id, 'similar_name']]);
    expect(hits[0]!.similarity).toBeGreaterThanOrEqual(0.6);
    // the same name in another locality is not a duplicate
    expect(hits.map((h) => h.id)).not.toContain(farSameName.id);
  });

  it('both reasons at once rank first; the record being edited is excluded', async () => {
    const hits = await findLocalDuplicates({ type: 'mosque', ...BASE, name: 'مسجد بلال' });
    expect(hits[0]).toMatchObject({ id: near100.id, reason: 'both', similarity: 1 });
    const editing = await findLocalDuplicates({
      type: 'mosque',
      ...BASE,
      name: 'مسجد بلال',
      excludeId: near100.id,
    });
    expect(editing.map((h) => h.id)).not.toContain(near100.id);
  });

  it('thresholds come from the cached app_settings when present', async () => {
    await saveAppSettings([
      { key: 'duplicates.radius_m', value: 250 },
      { key: 'duplicates.name_similarity', value: 0.9 },
    ]);
    const wide = await findLocalDuplicates({ type: 'mosque', ...BASE, name: '' });
    expect(wide.map((h) => h.id)).toContain(near200.id);
    const strict = await findLocalDuplicates({
      type: 'school',
      ...north(6000),
      name: 'مسجد النور',
      localityId: LOCALITY,
    });
    expect(strict).toEqual([]);
  });

  it('never changes anything', async () => {
    const before = await db.projects.count();
    await findLocalDuplicates({ type: 'mosque', ...BASE, name: 'مسجد بلال' });
    expect(await db.projects.count()).toBe(before);
    expect(await outbox()).toEqual([]);
  });
});

describe('findLocalPersonCandidates', () => {
  const AREA_REGION = tid(0x20);
  const AREA_DISTRICT = tid(0x20);
  let salim: Row<'persons'>;
  let salimLatin: Row<'persons'>;
  let mohamed: Row<'persons'>;
  let ali: Row<'persons'>;
  let byPhone: Row<'persons'>;
  let merged: Row<'persons'>;
  let project: Row<'projects'>;

  beforeEach(async () => {
    await applyServerRows('admin_areas', [
      serverRow('admin_areas', {
        id: AREA_REGION,
        country_id: 'c',
        level: 1,
        code: 'R',
        parent_id: null,
        name_ar: 'بيمبا',
      }),
      serverRow('admin_areas', {
        id: AREA_DISTRICT,
        country_id: 'c',
        level: 2,
        code: 'D',
        parent_id: AREA_REGION,
        name_ar: 'ويتي',
      }),
    ]);
    salim = serverRow('persons', {
      name_ar: 'محمد بن سالم الحارثي',
      home_admin_area_id: AREA_DISTRICT,
    });
    salimLatin = serverRow('persons', { name_ar: null, name_latin: 'Mohamed Salim Harthi' });
    mohamed = serverRow('persons', { name_ar: 'محمد' });
    ali = serverRow('persons', { name_ar: 'علي بن خميس' });
    byPhone = serverRow('persons', { name_ar: 'زيد', phone_e164: '+255711111111' });
    merged = serverRow('persons', { name_ar: 'محمد بن سالم الحارثى', merged_into_id: tid() });
    project = serverProject({
      admin_area_id: AREA_DISTRICT,
      name_ar: 'مسجد',
      code: 'TZ-PN-000001',
    });
    await applyServerRows('persons', [salim, salimLatin, mohamed, ali, byPhone, merged]);
    await applyServerRows('projects', [project]);
    await applyServerRows('project_staff', [
      serverRow('project_staff', { project_id: project.id, person_id: ali.id, role: 'teacher' }),
      serverRow('project_staff', { project_id: tid(), person_id: ali.id, role: 'imam' }),
    ]);
  });

  it('phone: the typed number (any format) equals phone_e164', async () => {
    for (const phone of ['+255711111111', '00255711111111', '+255 711 111 111']) {
      const hits = await findLocalPersonCandidates({ name: '', phone });
      expect(hits.map((h) => [h.id, h.reasons])).toEqual([[byPhone.id, ['phone']]]);
    }
    expect(normalizePhone('12')).toBeNull();
  });

  it('name: per-script trigram similarity >= 0.6; merged persons are skipped', async () => {
    const hits = await findLocalPersonCandidates({ name: 'محمد بن سالم الحارثى' });
    expect(hits.map((h) => h.id)).toEqual([salim.id]);
    expect(hits[0]).toMatchObject({ similarity: 1, same_area: false, reasons: ['name'] });
    const typo = await findLocalPersonCandidates({ name: 'محمد سالم الحارثي' });
    expect(typo.map((h) => h.id)).toEqual([salim.id]);
    expect(typo[0]!.similarity).toBeGreaterThanOrEqual(0.6);
    expect(typo[0]!.similarity).toBeLessThan(1);
    // the Latin name is compared on its own (not diluted by an Arabic name)
    expect(
      (await findLocalPersonCandidates({ name: 'Mohamed Salim Harthy' })).map((h) => h.id),
    ).toEqual([salimLatin.id]);
    // clearly different names are not candidates
    expect(await findLocalPersonCandidates({ name: 'خميس بن راشد' })).toEqual([]);
  });

  it('a single word is matched by equality only', async () => {
    expect((await findLocalPersonCandidates({ name: 'محمد' })).map((h) => h.id)).toEqual([
      mohamed.id,
    ]);
    expect(await findLocalPersonCandidates({ name: 'محمود' })).toEqual([]);
    expect(await findLocalPersonCandidates({ name: 'م' })).toEqual([]);
  });

  it('same area (home inside / ancestor, or works in a project there) ranks higher and is reported', async () => {
    const hits = await findLocalPersonCandidates({
      name: 'محمد بن سالم الحارثي',
      adminAreaId: AREA_REGION,
    });
    expect(hits[0]).toMatchObject({ id: salim.id, same_area: true, reasons: ['name', 'area'] });
    const worker = await findLocalPersonCandidates({
      name: 'علي بن خميس',
      adminAreaId: AREA_DISTRICT,
    });
    expect(worker[0]).toMatchObject({
      id: ali.id,
      same_area: true,
      hidden_projects: 1,
      roles: ['teacher'],
    });
    expect(worker[0]!.staff).toEqual([
      expect.objectContaining({
        project_id: project.id,
        project_code: 'TZ-PN-000001',
        role: 'teacher',
      }),
    ]);
  });

  it('phone matches rank before name matches', async () => {
    await applyServerRows('persons', [{ ...byPhone, version: 2, name_ar: 'محمد بن سالم الحارثي' }]);
    const hits = await findLocalPersonCandidates({
      name: 'محمد بن سالم الحارثي',
      phone: '+255711111111',
    });
    expect(hits[0]).toMatchObject({ id: byPhone.id, reasons: ['phone', 'name'] });
    expect(hits.map((h) => h.id)).toContain(salim.id);
  });

  it('the threshold comes from the cached app_settings (clamped)', async () => {
    await saveAppSettings([{ key: 'persons.name_similarity', value: 0.95 }]);
    expect(await findLocalPersonCandidates({ name: 'محمد سالم الحارثي' })).toEqual([]);
  });

  it('NEVER merges or changes anything', async () => {
    const before = (await db.persons.toArray()).map((p) => JSON.stringify(p)).sort();
    await findLocalPersonCandidates({
      name: 'محمد بن سالم الحارثي',
      phone: '+255711111111',
      adminAreaId: AREA_REGION,
    });
    expect((await db.persons.toArray()).map((p) => JSON.stringify(p)).sort()).toEqual(before);
    expect(await outbox()).toEqual([]);
  });

  it('a viewer device has no persons: no candidates', async () => {
    await freshDb();
    expect(
      await findLocalPersonCandidates({ name: 'محمد بن سالم الحارثي', phone: '+255711111111' }),
    ).toEqual([]);
  });
});

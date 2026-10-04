/**
 * loadProjectBundle / saveProjectBundle: one consistent read of a project with everything that
 * belongs to it, and a save that diffs row by row and field by field.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { projectCompleteness } from '../lib/completeness';
import { applyServerRows } from './apply';
import { loadProjectBundle, saveProjectBundle, type ProjectBundle } from './bundle';
import { db } from './dexie';
import { freshDb, outbox, serverProject, serverRow, stored, tid } from './testing/factory';
import { mutate, newRow } from './write';

beforeEach(async () => {
  await freshDb();
});

/** A project with land, two maintenance entries, a photo, a donor link and a staff member, all synced. */
async function seedSynced() {
  const p = serverProject({
    version: 2,
    name_ar: 'مسجد النور',
    capacity: 100,
    lon: 39.7,
    lat: -5.1,
  });
  const land = serverRow('project_land', { project_id: p.id, area_m2: 400, ownership: 'waqf' });
  const m1 = serverRow('project_maintenance', {
    project_id: p.id,
    description: 'سقف',
    reported_on: '2026-09-01',
  });
  const m2 = serverRow('project_maintenance', {
    project_id: p.id,
    description: 'باب',
    reported_on: '2026-09-15',
  });
  const photo = serverRow('project_photos', {
    project_id: p.id,
    storage_path_full: 'f',
    storage_path_thumb: 't',
    is_cover: true,
  });
  const donor = serverRow('donors', { name_ar: 'مؤسسة الخير' });
  const link = serverRow('project_donors', {
    project_id: p.id,
    donor_id: donor.id,
    amount: 1000,
    currency: 'USD',
  });
  const person = serverRow('persons', { name_ar: 'سالم بن علي', phone_e164: '+255711111111' });
  const staff = serverRow('project_staff', {
    project_id: p.id,
    person_id: person.id,
    role: 'imam',
  });
  await applyServerRows('donors', [donor]);
  await applyServerRows('projects', [p]);
  await applyServerRows('project_land', [land]);
  await applyServerRows('project_maintenance', [m1, m2]);
  await applyServerRows('project_photos', [photo]);
  await applyServerRows('project_donors', [link]);
  await applyServerRows('persons', [person]);
  await applyServerRows('project_staff', [staff]);
  return { p, land, m1, m2, photo, donor, link, person, staff };
}

describe('loadProjectBundle', () => {
  it('is undefined for a project that is not on the device', async () => {
    expect(await loadProjectBundle(tid())).toBeUndefined();
  });

  it('collects the children, joins donors and persons, strips index-only fields', async () => {
    const s = await seedSynced();
    const b = (await loadProjectBundle(s.p.id))!;
    expect(b.project).toMatchObject({ id: s.p.id, name_ar: 'مسجد النور' });
    expect(b.project).not.toHaveProperty('_tokens');
    expect(b.project).not.toHaveProperty('_fn');
    expect(b.land).toMatchObject({ id: s.land.id, area_m2: 400 });
    expect(b.facilities).toBeUndefined();
    expect(b.maintenance.map((m) => m.id)).toEqual([s.m2.id, s.m1.id]); // newest report first
    expect(b.maintenance[0]).not.toHaveProperty('_mk');
    expect(b.photos.map((ph) => ph.id)).toEqual([s.photo.id]);
    expect(b.donors).toHaveLength(1);
    expect(b.donors[0]).toMatchObject({
      id: s.link.id,
      amount: 1000,
      donor: { id: s.donor.id, name_ar: 'مؤسسة الخير' },
    });
    expect(b.staff[0]).toMatchObject({ id: s.staff.id, role: 'imam', person: { id: s.person.id } });
    expect(b.staff[0]!.compensation).toBeUndefined();
    expect(b.sensitive).toBeUndefined();
  });

  it('shows the restricted rows this collector entered and has not pushed yet', async () => {
    const s = await seedSynced();
    const comp = newRow('staff_compensation', {
      project_staff_id: s.staff.id,
      monthly_amount: 200,
      currency: 'TZS',
    });
    await mutate('staff_compensation', comp.id, comp, { insert: true });
    const sens = newRow('community_sensitive', { project_id: s.p.id, omani_families: 3 });
    await mutate('community_sensitive', sens.id, sens, { insert: true });
    const b = (await loadProjectBundle(s.p.id))!;
    expect(b.staff[0]!.compensation).toMatchObject({ id: comp.id, monthly_amount: 200, _dirty: 1 });
    expect(b.sensitive).toMatchObject({ id: sens.id, omani_families: 3 });
  });

  it('the bundle feeds the completeness twin', async () => {
    const s = await seedSynced();
    const b = (await loadProjectBundle(s.p.id))!;
    // name_ar 10 + location 15 + capacity 5 + photos 15 + land 10 + staff 10
    expect(projectCompleteness(b)).toBe(65);
  });
});

describe('saveProjectBundle', () => {
  it('a new project with children: rows created parents first, one insert op each', async () => {
    const project = newRow('projects', {
      name_ar: 'مدرسة الفلاح',
      type: 'school',
      lon: 39.6,
      lat: -5.2,
    });
    const donor = newRow('donors', { name_ar: 'متبرع جديد' });
    const link = newRow('project_donors', {
      project_id: project.id,
      donor_id: donor.id,
      amount: 50,
    });
    const person = newRow('persons', { name_ar: 'خميس' });
    const staff = newRow('project_staff', {
      project_id: project.id,
      person_id: person.id,
      role: 'teacher',
    });
    const comp = newRow('staff_compensation', {
      project_staff_id: staff.id,
      monthly_amount: 90,
      currency: 'TZS',
    });
    const bundle: ProjectBundle = {
      project,
      land: newRow('project_land', { project_id: project.id, area_m2: 20 }),
      maintenance: [newRow('project_maintenance', { project_id: project.id, description: 'طلاء' })],
      photos: [],
      donors: [{ ...link, donor }],
      staff: [{ ...staff, person, compensation: comp }],
    };
    await saveProjectBundle(bundle);
    const ops = await outbox();
    expect(ops.map((o) => o.table)).toEqual([
      'projects',
      'donors',
      'project_donors',
      'persons',
      'project_staff',
      'staff_compensation',
      'project_land',
      'project_maintenance',
    ]);
    expect(ops.every((o) => o.base_version === 0 && 'created_at' in o.fields)).toBe(true);
    expect(await db.restricted_local.count()).toBe(1); // collector device
    const loaded = (await loadProjectBundle(project.id))!;
    expect(loaded.staff[0]).toMatchObject({
      person: { name_ar: 'خميس' },
      compensation: { monthly_amount: 90 },
    });
  });

  it('saving the loaded bundle unchanged queues nothing', async () => {
    const s = await seedSynced();
    await saveProjectBundle((await loadProjectBundle(s.p.id))!);
    expect(await outbox()).toEqual([]);
  });

  it('diffs per row and per field', async () => {
    const s = await seedSynced();
    const b = (await loadProjectBundle(s.p.id))!;
    b.project = { ...b.project, capacity: 150 };
    b.land = { ...b.land!, area_m2: 450 };
    b.donors = [{ ...b.donors[0]!, amount: 1200 }];
    await saveProjectBundle(b);
    const ops = await outbox();
    expect(ops.map((o) => [o.table, o.fields])).toEqual([
      ['projects', { capacity: 150 }],
      ['project_donors', { amount: 1200 }],
      ['project_land', { area_m2: 450 }],
    ]);
    expect(ops.map((o) => o.base_version)).toEqual([2, 1, 1]);
  });

  it('a row missing from a list (or carrying deleted_at) is deleted; removing staff deletes the link only', async () => {
    const s = await seedSynced();
    const b = (await loadProjectBundle(s.p.id))!;
    b.maintenance = b.maintenance.filter((m) => m.id !== s.m1.id);
    b.photos = b.photos.map((ph) => ({ ...ph, deleted_at: '2026-10-04T00:00:00Z' }));
    b.staff = [];
    await saveProjectBundle(b);
    const ops = await outbox();
    expect(ops.map((o) => [o.table, o.kind, o.row_id])).toEqual([
      ['project_staff', 'delete', s.staff.id],
      ['project_maintenance', 'delete', s.m1.id],
      ['project_photos', 'delete', s.photo.id],
    ]);
    expect(await stored('persons', s.person.id)).toBeDefined();
    expect(await stored('project_maintenance', s.m2.id)).toBeDefined();
  });

  it('a 1:1 section with a different id updates the stored row of that project', async () => {
    const s = await seedSynced();
    const b = (await loadProjectBundle(s.p.id))!;
    b.land = newRow('project_land', { project_id: s.p.id, area_m2: 999, ownership: 'waqf' });
    await saveProjectBundle(b);
    const ops = await outbox();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      table: 'project_land',
      row_id: s.land.id,
      fields: { area_m2: 999 },
    });
    expect(await db.project_land.count()).toBe(1);
  });

  it('a 1:1 section passed with deleted_at is removed; undefined means untouched', async () => {
    const s = await seedSynced();
    const b = (await loadProjectBundle(s.p.id))!;
    await saveProjectBundle({ ...b, land: undefined });
    expect(await outbox()).toEqual([]);
    await saveProjectBundle({ ...b, land: { ...b.land!, deleted_at: '2026-10-04T00:00:00Z' } });
    expect((await outbox()).map((o) => [o.table, o.kind])).toEqual([['project_land', 'delete']]);
  });

  it('a new person for an existing staff entry and a new compensation date create rows', async () => {
    const s = await seedSynced();
    const b = (await loadProjectBundle(s.p.id))!;
    const person = newRow('persons', { name_ar: 'علي' });
    b.staff = [
      {
        ...b.staff[0]!,
        person_id: person.id,
        person,
        compensation: newRow('staff_compensation', {
          project_staff_id: s.staff.id,
          monthly_amount: 10,
          currency: 'KES',
          effective_from: '2026-10-01',
        }),
      },
    ];
    await saveProjectBundle(b);
    expect(
      (await outbox()).map((o) => [o.table, Object.keys(o.fields).includes('created_at')]),
    ).toEqual([
      ['persons', true],
      ['project_staff', false],
      ['staff_compensation', true],
    ]);
  });
});

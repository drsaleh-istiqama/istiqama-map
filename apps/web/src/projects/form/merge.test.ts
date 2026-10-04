import { describe, expect, it } from 'vitest';
import { newRow, type ProjectBundle, type Row } from '../../db';
import { buildBundle, changedFields, hasChanges } from './merge';
import { clone } from './model';

function bundle(): ProjectBundle {
  const project = newRow('projects', {
    name_ar: 'مسجد النور',
    type: 'mosque',
    status: 'active',
    lon: 39.75,
    lat: -5.05,
    country_id: 'c1',
    version: 3,
  } as Partial<Row<'projects'>>);
  const person = newRow('persons', { name_ar: 'أحمد', version: 2 } as Partial<Row<'persons'>>);
  const staff = {
    ...newRow('project_staff', {
      project_id: project.id,
      person_id: person.id,
      role: 'imam',
      version: 1,
    } as Partial<Row<'project_staff'>>),
    person,
  };
  const maint = newRow('project_maintenance', {
    project_id: project.id,
    description: 'سقف',
    version: 1,
  } as Partial<Row<'project_maintenance'>>);
  return {
    project,
    land: newRow('project_land', { project_id: project.id, area_m2: 400, version: 1 } as Partial<
      Row<'project_land'>
    >),
    maintenance: [maint],
    photos: [],
    donors: [],
    staff: [staff],
  };
}

const NOW = '2026-10-04T10:00:00.000Z';

describe('changedFields', () => {
  it('returns only differing data fields and ignores bookkeeping', () => {
    const a = { id: '1', version: 1, name_ar: 'a', capacity: 10, tags: ['x'], _dirty: 1 };
    const b = { id: '2', version: 9, name_ar: 'a', capacity: 12, tags: ['x'], _dirty: undefined };
    expect(changedFields(a, b)).toEqual({ capacity: 12 });
  });
  it('without a base keeps only fields that carry a value', () => {
    expect(changedFields(null, { name_ar: 'x', capacity: null, list: [], blank: '  ' })).toEqual({
      name_ar: 'x',
    });
  });
  it('a cleared field is a change', () => {
    expect(changedFields({ capacity: 5 }, { capacity: null })).toEqual({ capacity: null });
  });
});

describe('buildBundle', () => {
  it('passes a new project through (no stored copy)', () => {
    const working = bundle();
    const out = buildBundle({
      original: null,
      working,
      current: undefined,
      newDonorIds: [],
      newPersonIds: [working.staff[0]!.person!.id],
      now: NOW,
    });
    expect(out.project).toEqual(working.project);
    expect(out.staff).toHaveLength(1);
    // a person created in the form is saved with its link
    expect(out.staff[0]!.person?.id).toBe(working.staff[0]!.person_id);
    expect(out.land?.area_m2).toBe(400);
  });

  it('keeps changes that arrived through sync while the form was open', () => {
    const original = bundle();
    const working = clone(original);
    working.project.name_ar = 'مسجد النور الجديد';
    const current = clone(original);
    current.project.status = 'maintenance'; // another device changed the status meanwhile
    current.project.version = 4;
    const out = buildBundle({
      original,
      working,
      current,
      newDonorIds: [],
      newPersonIds: [],
      now: NOW,
    });
    expect(out.project.name_ar).toBe('مسجد النور الجديد');
    expect(out.project.status).toBe('maintenance');
    expect(out.project.version).toBe(4);
  });

  it('deletes what the user removed and keeps rows added elsewhere', () => {
    const original = bundle();
    const working = clone(original);
    working.maintenance = []; // user removed the entry
    const current = clone(original);
    const other = newRow('project_maintenance', {
      project_id: original.project.id,
      description: 'من جهاز آخر',
    } as Partial<Row<'project_maintenance'>>);
    current.maintenance.push(other);
    const out = buildBundle({
      original,
      working,
      current,
      newDonorIds: [],
      newPersonIds: [],
      now: NOW,
    });
    expect(out.maintenance.map((m) => m.id)).toEqual([other.id]);
  });

  it('a row deleted elsewhere while the user kept it untouched stays deleted', () => {
    const original = bundle();
    const working = clone(original);
    const current = clone(original);
    current.maintenance = [];
    const out = buildBundle({
      original,
      working,
      current,
      newDonorIds: [],
      newPersonIds: [],
      now: NOW,
    });
    expect(out.maintenance).toEqual([]);
  });

  it('untouched 1:1 sections are "not touched" (undefined)', () => {
    const original = bundle();
    const working = clone(original);
    working.facilities = newRow('project_facilities', {
      project_id: original.project.id,
    } as Partial<Row<'project_facilities'>>); // opened, nothing typed
    const out = buildBundle({
      original,
      working,
      current: clone(original),
      newDonorIds: [],
      newPersonIds: [],
      now: NOW,
    });
    expect(out.land).toBeUndefined();
    expect(out.facilities).toBeUndefined();
  });

  it('an edited section is merged over the stored row (stored id kept)', () => {
    const original = bundle();
    const working = clone(original);
    working.land = { ...working.land!, utilization_pct: 60 };
    const current = clone(original);
    current.land = { ...current.land!, notes: 'من الخادم' };
    const out = buildBundle({
      original,
      working,
      current,
      newDonorIds: [],
      newPersonIds: [],
      now: NOW,
    });
    expect(out.land).toMatchObject({
      id: original.land!.id,
      utilization_pct: 60,
      notes: 'من الخادم',
      area_m2: 400,
    });
  });

  it('never re-saves an existing person or donor', () => {
    const original = bundle();
    const working = clone(original);
    working.staff[0]!.role = 'teacher';
    const out = buildBundle({
      original,
      working,
      current: clone(original),
      newDonorIds: [],
      newPersonIds: [],
      now: NOW,
    });
    expect(out.staff[0]!.role).toBe('teacher');
    expect(out.staff[0]!.person).toBeUndefined();
  });

  it('sends a salary only when the user entered one, and keeps the staff link', () => {
    const original = bundle();
    const working = clone(original);
    const untouched = buildBundle({
      original,
      working,
      current: clone(original),
      newDonorIds: [],
      newPersonIds: [],
      now: NOW,
    });
    expect(untouched.staff[0]!.compensation).toBeUndefined();
    working.staff[0]!.compensation = newRow('staff_compensation', {
      project_staff_id: working.staff[0]!.id,
      monthly_amount: 150000,
      currency: 'TZS',
      effective_from: '2026-10-01',
    } as Partial<Row<'staff_compensation'>>);
    const out = buildBundle({
      original,
      working,
      current: clone(original),
      newDonorIds: [],
      newPersonIds: [],
      now: NOW,
    });
    expect(out.staff[0]!.compensation).toMatchObject({
      monthly_amount: 150000,
      currency: 'TZS',
      project_staff_id: working.staff[0]!.id,
    });
  });

  it('sends sensitive community data only when touched', () => {
    const original = bundle();
    const working = clone(original);
    working.sensitive = newRow('community_sensitive', {
      project_id: original.project.id,
    } as Partial<Row<'community_sensitive'>>);
    expect(
      buildBundle({
        original,
        working,
        current: clone(original),
        newDonorIds: [],
        newPersonIds: [],
        now: NOW,
      }).sensitive,
    ).toBeUndefined();
    working.sensitive.ibadi_families = 12;
    expect(
      buildBundle({
        original,
        working,
        current: clone(original),
        newDonorIds: [],
        newPersonIds: [],
        now: NOW,
      }).sensitive,
    ).toMatchObject({ ibadi_families: 12 });
  });

  it('a photo the editor stored and the user then removed is deleted', () => {
    const original = bundle();
    const working = clone(original);
    const photo = newRow('project_photos', { project_id: original.project.id } as Partial<
      Row<'project_photos'>
    >);
    const current = { ...clone(original), photos: [photo] };
    const out = buildBundle({
      original,
      working, // photo no longer in the editor's list
      current,
      newDonorIds: [],
      newPersonIds: [],
      seenPhotoIds: [photo.id],
      now: NOW,
    });
    expect(out.photos).toEqual([]);
  });
});

describe('hasChanges', () => {
  it('detects edits and their absence', () => {
    const original = bundle();
    expect(hasChanges(original, clone(original))).toBe(false);
    const working = clone(original);
    working.project.capacity = 300;
    expect(hasChanges(original, working)).toBe(true);
  });
  it('a blank new form has no changes (defaults do not count)', () => {
    const working = bundle();
    working.project.name_ar = '';
    working.project.type = null as unknown as 'mosque';
    working.project.lon = null;
    working.project.lat = null;
    working.staff = [];
    working.maintenance = [];
    delete working.land;
    expect(hasChanges(null, working)).toBe(false);
    working.project.name_ar = 'x';
    expect(hasChanges(null, working)).toBe(true);
  });
});

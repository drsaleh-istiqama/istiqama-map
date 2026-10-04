/**
 * Twin of SQL `private.project_completeness` (docs/contracts/schema.md §5). The weights are
 * pinned here; tests/integration/registry.live.test.ts compares the score of every project
 * in the database with the stored `projects.completeness`.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectBundle } from '../db/bundle';
import type { Row } from '../db/types';
import {
  COMPLETENESS_WEIGHTS,
  bundleChildren,
  completenessParts,
  completenessScore,
  missingCompletenessKeys,
  projectCompleteness,
  type CompletenessChildren,
  type CompletenessProject,
} from './completeness';

const NO_CHILDREN: CompletenessChildren = { photos: false, land: false, facilities: false, staff: false, community: false };
const ALL_CHILDREN: CompletenessChildren = { photos: true, land: true, facilities: true, staff: true, community: true };

const EMPTY: CompletenessProject = {
  name_ar: '',
  name_latin: null,
  lon: null,
  lat: null,
  admin_area_id: null,
  capacity: null,
  build_year: null,
  build_date: null,
};

const FULL: CompletenessProject = {
  name_ar: 'مسجد النور',
  name_latin: 'Masjid Noor',
  lon: 39.75,
  lat: -5.05,
  admin_area_id: 'a1',
  capacity: 120,
  build_year: 2015,
  build_date: null,
};

describe('weights', () => {
  it('are the ones of the contract and add up to 100', () => {
    expect(COMPLETENESS_WEIGHTS).toEqual({
      name_ar: 10,
      name_latin: 5,
      location: 15,
      admin_area: 5,
      capacity: 5,
      build_year: 5,
      photos: 15,
      land: 10,
      facilities: 10,
      staff: 10,
      community: 10,
    });
    expect(Object.values(COMPLETENESS_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe('completenessScore', () => {
  it('0 for an empty project, 100 for a complete one', () => {
    expect(completenessScore(EMPTY, NO_CHILDREN)).toBe(0);
    expect(completenessScore(FULL, ALL_CHILDREN)).toBe(100);
    expect(completenessScore(FULL, NO_CHILDREN)).toBe(45);
    expect(completenessScore(EMPTY, ALL_CHILDREN)).toBe(55);
  });

  it.each([
    ['name_ar', { name_ar: 'مسجد' }, 10],
    ['name_latin', { name_latin: 'Masjid' }, 5],
    ['location', { lon: 39.7, lat: -5 }, 15],
    ['admin_area', { admin_area_id: 'x' }, 5],
    ['capacity', { capacity: 1 }, 5],
    ['build_year', { build_year: 1999 }, 5],
  ] as Array<[string, Partial<CompletenessProject>, number]>)('%s alone is worth its weight', (_key, patch, weight) => {
    expect(completenessScore({ ...EMPTY, ...patch }, NO_CHILDREN)).toBe(weight);
  });

  it.each([
    ['photos', 15],
    ['land', 10],
    ['facilities', 10],
    ['staff', 10],
    ['community', 10],
  ] as Array<[keyof CompletenessChildren, number]>)('child %s alone is worth its weight', (key, weight) => {
    expect(completenessScore(EMPTY, { ...NO_CHILDREN, [key]: true })).toBe(weight);
  });

  it('blank names do not count (SQL btrim removes blanks only)', () => {
    expect(completenessScore({ ...EMPTY, name_ar: '   ', name_latin: '  ' }, NO_CHILDREN)).toBe(0);
    // btrim() keeps a tab: the name is "not blank" for the server, so it is here too
    expect(completenessScore({ ...EMPTY, name_ar: '\t' }, NO_CHILDREN)).toBe(10);
  });

  it('capacity must be greater than zero', () => {
    expect(completenessScore({ ...EMPTY, capacity: 0 }, NO_CHILDREN)).toBe(0);
    expect(completenessScore({ ...EMPTY, capacity: 1 }, NO_CHILDREN)).toBe(5);
  });

  it('location needs both coordinates; 0/0 is a location', () => {
    expect(completenessScore({ ...EMPTY, lon: 39.7 }, NO_CHILDREN)).toBe(0);
    expect(completenessScore({ ...EMPTY, lon: 0, lat: 0 }, NO_CHILDREN)).toBe(15);
  });

  it('a build date counts like a build year (the server fills the year from the date)', () => {
    expect(completenessScore({ ...EMPTY, build_date: '2011-05-01' }, NO_CHILDREN)).toBe(5);
    expect(completenessScore({ ...EMPTY, build_date: '' }, NO_CHILDREN)).toBe(0);
  });

  it('completenessParts names what is satisfied', () => {
    const parts = completenessParts(FULL, { ...NO_CHILDREN, land: true });
    expect(parts.name_ar && parts.location && parts.land).toBe(true);
    expect(parts.photos || parts.staff).toBe(false);
  });
});

const std = { created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', created_by: null, updated_by: null, version: 1, deleted_at: null };

function bundle(): ProjectBundle {
  const project = {
    ...std,
    id: 'p1',
    code: null,
    external_id: null,
    type: 'mosque',
    status: 'active',
    gps_accuracy_m: null,
    location_source: null,
    country_id: null,
    locality_id: null,
    branch_id: null,
    builder: null,
    record_state: 'draft',
    review_note: null,
    reviewed_by: null,
    reviewed_at: null,
    completeness: 0,
    search_norm: '',
    import_batch_id: null,
    ...FULL,
  } as Row<'projects'>;
  return { project, maintenance: [], photos: [], donors: [], staff: [] };
}

describe('projectCompleteness (bundle)', () => {
  it('scores the project fields when there are no children', () => {
    expect(projectCompleteness(bundle())).toBe(45);
  });

  it('counts live children only; maintenance, donors and restricted data do not count', () => {
    const b = bundle();
    b.land = { ...std, id: 'l1', project_id: 'p1' } as Row<'project_land'>;
    b.facilities = { ...std, id: 'f1', project_id: 'p1', deleted_at: '2026-10-02T00:00:00Z' } as Row<'project_facilities'>;
    b.community = { ...std, id: 'c1', project_id: 'p1' } as Row<'community_profiles'>;
    b.sensitive = { ...std, id: 's1', project_id: 'p1' } as Row<'community_sensitive'>;
    b.photos = [{ ...std, id: 'ph1', project_id: 'p1', deleted_at: '2026-10-02T00:00:00Z' } as Row<'project_photos'>];
    b.staff = [{ ...std, id: 'st1', project_id: 'p1', person_id: 'x', role: 'imam' } as Row<'project_staff'>];
    b.maintenance = [{ ...std, id: 'm1', project_id: 'p1' } as Row<'project_maintenance'>];
    b.donors = [{ ...std, id: 'd1', project_id: 'p1', donor_id: 'dn' } as Row<'project_donors'>];
    expect(bundleChildren(b)).toEqual({ photos: false, land: true, facilities: false, staff: true, community: true });
    expect(projectCompleteness(b)).toBe(45 + 10 + 10 + 10);
  });

  it('a pending photo counts (any upload_state)', () => {
    const b = bundle();
    b.photos = [{ ...std, id: 'ph1', project_id: 'p1', upload_state: 'pending' } as Row<'project_photos'>];
    expect(projectCompleteness(b)).toBe(60);
  });

  it('missingCompletenessKeys lists what is left, heaviest first', () => {
    const b = bundle();
    b.project.capacity = null;
    const missing = missingCompletenessKeys(b);
    expect(missing[0]).toBe('photos');
    expect(missing).toContain('capacity');
    expect(missing).not.toContain('name_ar');
    expect(missing.map((k) => COMPLETENESS_WEIGHTS[k])).toEqual(
      [...missing.map((k) => COMPLETENESS_WEIGHTS[k])].sort((x, y) => y - x),
    );
  });
});

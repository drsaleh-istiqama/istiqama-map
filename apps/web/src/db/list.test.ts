/**
 * Lists over the local stores: keyset paging (no duplicates, no skips), every filter of
 * `ProjectFilter`, the map viewport, maintenance, the people directory and badge counts.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyServerRows } from './apply';
import { drafts, setLocalSession } from './meta';
import {
  badgeCounts,
  listIncompleteProjects,
  listOpenMaintenance,
  listPersons,
  listProjects,
  projectsInBounds,
  type ListCursor,
  type ProjectFilter,
  type ProjectListItem,
} from './list';
import { USER_A, USER_B, freshDb, serverProject, serverRow, tid } from './testing/factory';
import type { Row } from './types';
import { mutate, newRow } from './write';

const TZ = '10000000-0000-4000-8000-000000000001';
const KE = '10000000-0000-4000-8000-000000000002';
const BR_PEMBA = '20000000-0000-4000-8000-000000000001';
const BR_UNGUJA = '20000000-0000-4000-8000-000000000002';
const REGION = '30000000-0000-4000-8000-000000000001';
const DISTRICT_A = '30000000-0000-4000-8000-000000000002';
const DISTRICT_B = '30000000-0000-4000-8000-000000000003';
const WARD = '30000000-0000-4000-8000-000000000004';
const LOCALITY = '40000000-0000-4000-8000-000000000001';

const NAMES = [
  'مسجد النور',
  'مدرسة الفلاح',
  'مسجد الرحمة',
  'مسجد التقوى',
  'مدرسة القرآن',
  'Masjid Ijumaa',
  'مسجد النور',
];
const TYPES = ['mosque', 'school', 'combined'] as const;
const STATUSES = ['active', 'maintenance', 'building', 'inactive'] as const;
const STATES = ['draft', 'submitted', 'approved', 'returned'] as const;
const AREAS = [null, REGION, DISTRICT_A, DISTRICT_B, WARD] as const;

/** Deterministic pseudo-random sequence. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const N = 260;
let projects: Array<Row<'projects'>> = [];

async function seed(): Promise<void> {
  await applyServerRows('admin_areas', [
    serverRow('admin_areas', {
      id: REGION,
      country_id: TZ,
      level: 1,
      code: 'R',
      parent_id: null,
      name_ar: 'بيمبا',
    }),
    serverRow('admin_areas', {
      id: DISTRICT_A,
      country_id: TZ,
      level: 2,
      code: 'DA',
      parent_id: REGION,
      name_ar: 'ويتي',
    }),
    serverRow('admin_areas', {
      id: DISTRICT_B,
      country_id: TZ,
      level: 2,
      code: 'DB',
      parent_id: REGION,
      name_ar: 'شاكي',
    }),
    serverRow('admin_areas', {
      id: WARD,
      country_id: TZ,
      level: 3,
      code: 'W',
      parent_id: DISTRICT_A,
      name_ar: 'كيوني',
    }),
  ]);
  await applyServerRows('localities', [
    serverRow('localities', {
      id: LOCALITY,
      country_id: TZ,
      name_ar: 'مكواني',
      name_latin: 'Mkoani',
      status: 'approved',
    }),
  ]);
  const r = rng(42);
  projects = [];
  for (let i = 0; i < N; i++) {
    const pick = <T>(list: readonly T[]): T => list[Math.floor(r() * list.length)]!;
    const country = r() < 0.8 ? TZ : KE;
    projects.push(
      serverProject({
        name_ar: `${pick(NAMES)} ${i % 9 === 0 ? '' : String(i % 23)}`.trim(),
        name_latin: r() < 0.5 ? `Project ${i}` : null,
        code: `TZ-PN-${String(i).padStart(6, '0')}`,
        type: pick(TYPES),
        status: pick(STATUSES),
        record_state: pick(STATES),
        country_id: country,
        branch_id: country === TZ ? pick([BR_PEMBA, BR_UNGUJA]) : null,
        admin_area_id: country === TZ ? pick(AREAS) : null,
        locality_id: i % 10 === 0 ? LOCALITY : null,
        completeness: r() < 0.3 ? 100 : Math.floor(r() * 100),
        created_by: r() < 0.25 ? USER_A : USER_B,
        updated_at: new Date(Date.UTC(2026, 8, 1) + Math.floor(r() * 30 * 86400000)).toISOString(),
        lon: 39 + r() * 0.5,
        lat: -5.5 + r() * 0.5,
        version: 2,
      }),
    );
  }
  await applyServerRows('projects', projects);
  // open maintenance on every 7th project
  const entries = projects
    .filter((_, i) => i % 7 === 0)
    .map((p, i) =>
      serverRow('project_maintenance', {
        project_id: p.id,
        description: `m${i}`,
        state: i % 2 ? 'open' : 'in_progress',
        priority: (['low', 'medium', 'high', 'urgent'] as const)[i % 4],
        reported_on: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`,
      }),
    );
  entries.push(
    serverRow('project_maintenance', {
      project_id: projects[1]!.id,
      description: 'done',
      state: 'done',
    }),
  );
  await applyServerRows('project_maintenance', entries);
}

const byName = (a: Row<'projects'>, b: Row<'projects'>): number =>
  a.name_ar < b.name_ar ? -1 : a.name_ar > b.name_ar ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const byUpdated = (a: Row<'projects'>, b: Row<'projects'>): number =>
  Date.parse(b.updated_at) - Date.parse(a.updated_at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

const chain: Record<string, string[]> = {
  [REGION]: [REGION],
  [DISTRICT_A]: [DISTRICT_A, REGION],
  [DISTRICT_B]: [DISTRICT_B, REGION],
  [WARD]: [WARD, DISTRICT_A, REGION],
};
const openMaintenance = (): Set<string> =>
  new Set(projects.filter((_, i) => i % 7 === 0).map((p) => p.id));

/** The reference answer computed in plain JS from the seed. */
function expected(filter: ProjectFilter, userId: string): string[] {
  const open = openMaintenance();
  return projects
    .filter(
      (p) =>
        (!filter.type || p.type === filter.type) &&
        (!filter.status || p.status === filter.status) &&
        (!filter.recordState || p.record_state === filter.recordState) &&
        (!filter.countryId || p.country_id === filter.countryId) &&
        (!filter.branchId || p.branch_id === filter.branchId) &&
        (!filter.adminAreaId ||
          (p.admin_area_id !== null &&
            (chain[p.admin_area_id] ?? []).includes(filter.adminAreaId))) &&
        (!filter.incomplete || p.completeness < 100) &&
        (!filter.mine || p.created_by === userId) &&
        (!filter.openMaintenance || open.has(p.id)),
    )
    .sort(filter.sort === 'updated' ? byUpdated : byName)
    .map((p) => p.id);
}

async function allPages(
  filter: ProjectFilter,
  limit: number,
): Promise<{ ids: string[]; totals: number[]; pages: number }> {
  const ids: string[] = [];
  const totals: number[] = [];
  let cursor: ListCursor | null = null;
  let pages = 0;
  do {
    const page = await listProjects(filter, cursor, limit);
    expect(page.rows.length).toBeLessThanOrEqual(limit);
    ids.push(...page.rows.map((r) => r.id));
    totals.push(page.total);
    cursor = page.next;
    pages++;
    if (pages > 500) throw new Error('paging does not end');
  } while (cursor);
  return { ids, totals, pages };
}

beforeAll(async () => {
  await freshDb();
  await seed();
});

describe('listProjects — keyset paging', () => {
  const FILTERS: Array<[string, ProjectFilter]> = [
    ['no filter, by name', {}],
    ['no filter, by updated', { sort: 'updated' }],
    ['type', { type: 'mosque' }],
    ['status', { status: 'maintenance', sort: 'updated' }],
    ['record state', { recordState: 'submitted' }],
    ['country', { countryId: KE }],
    ['branch', { branchId: BR_PEMBA, sort: 'updated' }],
    ['admin area with descendants', { adminAreaId: REGION }],
    ['district', { adminAreaId: DISTRICT_A }],
    ['incomplete', { incomplete: true }],
    ['mine', { mine: true }],
    ['mine + incomplete', { mine: true, incomplete: true, sort: 'updated' }],
    ['open maintenance', { openMaintenance: true }],
    ['country + type + status', { countryId: TZ, type: 'school', status: 'active' }],
    [
      'branch + area + record state',
      { branchId: BR_UNGUJA, adminAreaId: REGION, recordState: 'approved', sort: 'updated' },
    ],
    ['nothing matches', { countryId: KE, branchId: BR_PEMBA }],
  ];

  for (const [name, filter] of FILTERS) {
    it(`${name}: pages join to the full ordered result, no duplicates, no skips, constant total`, async () => {
      const want = expected(filter, USER_A);
      for (const limit of [7, 50]) {
        const { ids, totals } = await allPages(filter, limit);
        expect(ids).toEqual(want);
        expect(new Set(totals)).toEqual(new Set([want.length]));
      }
    });
  }

  it('a text query: names in both scripts, code, locality — paged the same way', async () => {
    const want = projects
      .filter((p) => p.name_ar.startsWith('مسجد الرحمة'))
      .sort(byName)
      .map((p) => p.id);
    expect(want.length).toBeGreaterThan(5);
    const { ids, totals } = await allPages({ q: 'مسجد رحمه' }, 4);
    expect(ids).toEqual(want);
    expect(totals[0]).toBe(want.length);
    // every query word must START a word of the names, the code (also without its leading
    // zeros) or the locality names
    const words = (p: Row<'projects'>): string[] =>
      [p.name_ar, p.name_latin ?? '', p.code ?? '', p.locality_id ? 'mkoani' : '']
        .join(' ')
        .toLowerCase()
        .split(/[\s-]+/)
        .flatMap((w) => [w, w.replace(/^0+(?=\d)/, '')]);
    const project17 = projects
      .filter(
        (p) =>
          words(p).some((w) => w.startsWith('project')) && words(p).some((w) => w.startsWith('17')),
      )
      .sort(byName)
      .map((p) => p.id);
    expect(project17.length).toBeGreaterThan(1);
    expect((await allPages({ q: 'Project 17' }, 2)).ids).toEqual(project17);
    expect((await listProjects({ q: '000042' }, null)).rows.map((r) => r.code)).toEqual([
      'TZ-PN-000042',
    ]);
    const inLocality = (await listProjects({ q: 'mkoani' }, null, 200)).rows
      .map((r) => r.id)
      .sort();
    expect(inLocality).toEqual(
      projects
        .filter((p) => p.locality_id === LOCALITY)
        .map((p) => p.id)
        .sort(),
    );
    expect(await listProjects({ q: 'لا يوجد' }, null)).toEqual({ rows: [], next: null, total: 0 });
  });

  it('a text query combined with a filter', async () => {
    const want = projects
      .filter((p) => p.name_ar.startsWith('مسجد النور') && p.type === 'combined')
      .sort(byName)
      .map((p) => p.id);
    expect((await allPages({ q: 'النور', type: 'combined' }, 3)).ids).toEqual(want);
  });

  it('list items carry the area and locality names and the state flags', async () => {
    const p =
      projects.find((x) => x.admin_area_id === WARD && x.locality_id === LOCALITY) ??
      projects.find((x) => x.admin_area_id === WARD)!;
    const page = await listProjects({ q: p.code! }, null);
    const item = page.rows[0] as ProjectListItem;
    expect(item).toMatchObject({
      id: p.id,
      area_level: 3,
      area_name_ar: 'كيوني',
      dirty: false,
      conflict: false,
    });
  });

  it('a user without session id gets no "mine" rows', async () => {
    await setLocalSession({ userId: null });
    expect(await listProjects({ mine: true }, null)).toEqual({ rows: [], next: null, total: 0 });
    await setLocalSession({ userId: USER_A });
  });

  it('listIncompleteProjects = mine + incomplete, newest change first', async () => {
    const page = await listIncompleteProjects({}, null, 200);
    expect(page.rows.map((r) => r.id)).toEqual(
      expected({ mine: true, incomplete: true, sort: 'updated' }, USER_A),
    );
  });

  it('limit is clamped to 1..200', async () => {
    expect((await listProjects({}, null, 0)).rows).toHaveLength(1);
    expect((await listProjects({}, null, 5000)).rows).toHaveLength(200);
  });
});

describe('projectsInBounds (map at zoom >= 14)', () => {
  it('returns the projects inside the box that match the filter, at most `limit`', async () => {
    const box: [number, number, number, number] = [39.1, -5.4, 39.3, -5.2];
    const inside = (p: Row<'projects'>): boolean =>
      p.lon! >= 39.1 && p.lon! <= 39.3 && p.lat! >= -5.4 && p.lat! <= -5.2;
    const got = (await projectsInBounds(box, {}, 1000)).map((r) => r.id).sort();
    expect(got).toEqual(
      projects
        .filter(inside)
        .map((p) => p.id)
        .sort(),
    );
    const mosques = (await projectsInBounds([39.3, -5.2, 39.1, -5.4], { type: 'mosque' }, 1000))
      .map((r) => r.id)
      .sort();
    expect(mosques).toEqual(
      projects
        .filter((p) => inside(p) && p.type === 'mosque')
        .map((p) => p.id)
        .sort(),
    );
    expect(await projectsInBounds(box, {}, 3)).toHaveLength(3);
  });

  it('a box far too large for the grid still answers (bounded scan)', async () => {
    const rows = await projectsInBounds([-180, -90, 180, 90], {}, 10);
    expect(rows.length).toBeLessThanOrEqual(10);
  });
});

describe('listOpenMaintenance', () => {
  it('open and in-progress entries only, most urgent first then newest, keyset-paged', async () => {
    const seen: string[] = [];
    let cursor = null;
    let total = -1;
    do {
      const page: Awaited<ReturnType<typeof listOpenMaintenance>> = await listOpenMaintenance(
        {},
        cursor,
        4,
      );
      if (total < 0) total = page.total;
      seen.push(...page.rows.map((r) => r.entry.id));
      for (const r of page.rows) expect(['open', 'in_progress']).toContain(r.entry.state);
      cursor = page.next;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(Math.ceil(N / 7));
    expect(total).toBe(seen.length);
    const all = (await listOpenMaintenance({}, null, 200)).rows;
    const rank = { urgent: 0, high: 1, medium: 2, low: 3 } as const;
    for (let i = 1; i < all.length; i++) {
      const a = all[i - 1]!.entry;
      const b = all[i]!.entry;
      expect(
        rank[a.priority] < rank[b.priority] ||
          (rank[a.priority] === rank[b.priority] && a.reported_on >= b.reported_on),
      ).toBe(true);
    }
    expect(all[0]!.project).not.toBeNull();
  });

  it('accepts a project filter', async () => {
    const page = await listOpenMaintenance({ countryId: KE }, null, 200);
    expect(page.rows.every((r) => r.project?.country_id === KE)).toBe(true);
    expect(page.total).toBe(page.rows.length);
  });
});

describe('badgeCounts', () => {
  it('index counts for navigation badges', async () => {
    const c = await badgeCounts();
    expect(c.projects).toBe(N);
    expect(c.openMaintenance).toBe(Math.ceil(N / 7));
    expect(c.projectsWithOpenMaintenance).toBe(openMaintenance().size);
    expect(c.incomplete).toBe(projects.filter((p) => p.completeness < 100).length);
    expect(c.incompleteMine).toBe(expected({ mine: true, incomplete: true }, USER_A).length);
    expect(c.submitted).toBe(projects.filter((p) => p.record_state === 'submitted').length);
    expect(c.returned).toBe(projects.filter((p) => p.record_state === 'returned').length);
    expect(c.pendingOps).toBe(0);
  });
});

describe('local edits in lists', () => {
  beforeEach(async () => {
    await freshDb();
    await seed();
  });

  it('a locally edited project moves to the top of "updated" and shows its estimate', async () => {
    const target = projects.find((p) => p.completeness === 100)!;
    await mutate('projects', target.id, { capacity: 12, builder: 'local edit' });
    const first = (await listProjects({ sort: 'updated' }, null, 1)).rows[0]!;
    expect(first).toMatchObject({ id: target.id, dirty: true });
    expect(first.completeness).toBeLessThan(100);
    expect(
      (await listProjects({ incomplete: true, q: target.code! }, null)).rows.map((r) => r.id),
    ).toEqual([target.id]);
  });

  it('a project created offline is listed (and counted) at once', async () => {
    const row = newRow('projects', { name_ar: 'AAA مشروع جديد', type: 'school', country_id: KE });
    await mutate('projects', row.id, row, { insert: true });
    const page = await listProjects({ countryId: KE }, null, 1);
    expect(page.rows[0]!.id).toBe(row.id); // code-point order: Latin capitals before Arabic
    expect(page.total).toBe(expected({ countryId: KE }, USER_A).length + 1);
    expect((await badgeCounts()).pendingOps).toBe(1);
    await drafts.put('x', 1);
    expect((await badgeCounts()).drafts).toBe(1);
  });

  it('a new open maintenance entry flags its project for the openMaintenance filter', async () => {
    const target = projects.find((_, i) => i % 7 !== 0)!;
    const m = newRow('project_maintenance', {
      project_id: target.id,
      description: 'تسرب',
      priority: 'urgent',
    });
    await mutate('project_maintenance', m.id, m, { insert: true });
    const ids = (await listProjects({ openMaintenance: true }, null, 200)).rows.map((r) => r.id);
    expect(ids).toContain(target.id);
    expect((await listOpenMaintenance({}, null, 1)).rows[0]!.entry.id).toBe(m.id);
    await mutate('project_maintenance', m.id, { state: 'done' });
    expect(
      (await listProjects({ openMaintenance: true }, null, 200)).rows.map((r) => r.id),
    ).not.toContain(target.id);
  });
});

describe('listPersons', () => {
  it('pages by name; a query returns the best matches', async () => {
    await freshDb();
    const names = ['سالم', 'علي بن سالم', 'Ali Juma', 'فاطمة', 'خميس', 'سالمة'];
    await applyServerRows(
      'persons',
      names.map((n) =>
        serverRow('persons', {
          id: tid(0x140),
          name_ar: /[a-z]/i.test(n) ? null : n,
          name_latin: /[a-z]/i.test(n) ? n : null,
        }),
      ),
    );
    const seen: string[] = [];
    let cursor = null;
    do {
      const page: Awaited<ReturnType<typeof listPersons>> = await listPersons(undefined, cursor, 2);
      seen.push(...page.rows.map((r) => r.name_ar ?? r.name_latin ?? ''));
      cursor = page.next;
    } while (cursor);
    expect(seen).toEqual([...names].sort());
    expect((await listPersons('سالم', null)).rows.map((r) => r.name_ar)).toEqual([
      'سالم',
      'سالمة',
      'علي بن سالم',
    ]);
    expect((await listPersons('juma', null)).rows.map((r) => r.name_latin)).toEqual(['Ali Juma']);
  });
});

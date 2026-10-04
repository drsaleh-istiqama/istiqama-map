/**
 * Benchmark-style proof that lists, map queries and search stay bounded with 20,000 local
 * projects: a counting middleware below Dexie (testing/readCounter.ts) records every object
 * and every index key read from IndexedDB. The assertions are about COUNTS (deterministic),
 * not about time; the timings are only printed.
 *
 *   rows = objects materialised     keys = index keys read without their objects
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { applyServerRows } from './apply';
import { db } from './dexie';
import { decorateMany } from './derive';
import { listOpenMaintenance, listProjects, projectsInBounds, type ListCursor } from './list';
import { findLocalDuplicates, findLocalPersonCandidates } from './match';
import { searchLocal, SEARCH_KEY_BUDGET } from './search';
import { installReadCounter } from './testing/readCounter';
import { freshDb, serverProject, serverRow, USER_A, USER_B } from './testing/factory';
import type { Row } from './types';

// Installed before the database is opened (Dexie builds its middleware stack on open).
const counter = installReadCounter(db);

const N = Number(process.env.DB_PERF_N ?? 20_000);
const PAGE = 50;
const COUNTRIES = ['c1', 'c2', 'c3', 'c4'].map(
  (c) => `10000000-0000-4000-8000-0000000000${c.slice(1).padStart(2, '0')}`,
);
const BRANCHES = Array.from(
  { length: 20 },
  (_, i) => `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
);
const WORDS_AR = [
  'مسجد',
  'مدرسة',
  'النور',
  'الفلاح',
  'الرحمة',
  'التقوى',
  'الهدى',
  'السلام',
  'الإيمان',
  'القرآن',
  'بلال',
  'عمر',
];
const WORDS_LAT = [
  'Masjid',
  'Shule',
  'Nur',
  'Falah',
  'Rahma',
  'Taqwa',
  'Huda',
  'Salaam',
  'Iman',
  'Quran',
  'Bilal',
  'Umar',
];
const TYPES = ['mosque', 'school', 'combined'] as const;
const STATUSES = ['active', 'maintenance', 'building', 'inactive'] as const;
const STATES = ['draft', 'submitted', 'approved', 'returned'] as const;

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const timings: Record<string, number> = {};
async function measure<T>(label: string, fn: () => Promise<T>) {
  const t0 = performance.now();
  const r = await counter.measure(fn);
  timings[label] = Math.round(performance.now() - t0);
  return r;
}

let sample: Row<'projects'>;

beforeAll(async () => {
  await freshDb();
  const r = rng(7);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(r() * list.length)]!;
  const t0 = performance.now();
  const batch: Array<Row<'projects'>> = [];
  for (let i = 0; i < N; i++) {
    const w = Math.floor(r() * WORDS_AR.length);
    batch.push(
      serverProject({
        id: `00000000-0080-7000-8000-${String(i).padStart(12, '0')}`,
        name_ar: `${pick(WORDS_AR.slice(0, 2))} ${WORDS_AR[w]} ${i % 97}`,
        name_latin: `${pick(WORDS_LAT.slice(0, 2))} ${WORDS_LAT[w]} ${i % 97}`,
        code: `TZ-PN-${String(i).padStart(6, '0')}`,
        type: pick(TYPES),
        status: pick(STATUSES),
        record_state: pick(STATES),
        country_id: pick(COUNTRIES),
        branch_id: pick(BRANCHES),
        completeness: Math.floor(r() * 101),
        created_by: r() < 0.1 ? USER_A : USER_B,
        updated_at: new Date(Date.UTC(2026, 0, 1) + Math.floor(r() * 270 * 86400000)).toISOString(),
        // spread over 2 x 2 degrees around Pemba
        lon: 38.8 + r() * 2,
        lat: -6 + r() * 2,
        version: 3,
      }),
    );
  }
  // fake-indexeddb rewrites an existing row in O(size of its indexes) (it scans every index
  // for the old entries; real IndexedDB does not). Children that would make the pull rewrite
  // their project (open maintenance) are therefore stored as a first sync leaves them: the
  // project already carries its open-maintenance flag and the entries are written directly.
  const maintenance = Array.from({ length: Math.ceil(N / 10) }, (_, i) =>
    serverRow('project_maintenance', {
      project_id: batch[(i * 7) % N]!.id,
      description: 'm',
      state: 'open',
      reported_on: '2026-09-01',
    }),
  );
  const flagged = new Set(maintenance.map((m) => m.project_id));
  for (const p of batch) if (flagged.has(p.id)) (p as Row<'projects'> & { _om?: 1 })._om = 1;
  await applyServerRows('projects', batch);
  timings.seedProjects = Math.round(performance.now() - t0);
  await decorateMany('project_maintenance', maintenance);
  await db.project_maintenance.bulkPut(maintenance);
  sample = batch[Math.floor(N * 0.6)]!;
  const persons = Array.from({ length: Math.ceil(N / 7) }, (_, i) =>
    serverRow('persons', {
      name_ar: `${pick(['محمد', 'علي', 'سالم', 'خميس'])} بن ${pick(WORDS_AR)} ${i}`,
      phone_e164: `+2557${String(i).padStart(8, '0')}`,
    }),
  );
  await applyServerRows('persons', persons);
  // every person works in one project (staff hits need an assignment)
  await applyServerRows(
    'project_staff',
    persons.map((p, i) =>
      serverRow('project_staff', {
        project_id: batch[(i * 13) % N]!.id,
        person_id: p.id,
        role: 'imam',
      }),
    ),
  );
  timings.seed = Math.round(performance.now() - t0);
  if (process.env.PROFILE_OUT)
    (await import('node:fs')).writeFileSync(process.env.PROFILE_OUT, JSON.stringify(timings));
}, 600_000);

describe(
  `bounded reads with ${N.toLocaleString('en')} local projects`,
  { timeout: 180_000 },
  () => {
    it('seeded', async () => {
      expect(await db.projects.count()).toBe(N);
    });

    it('listProjects by name: every page reads O(page) rows and keys, also deep in the list', async () => {
      let cursor: ListCursor | null = null;
      const seen = new Set<string>();
      const pages = Math.min(30, Math.ceil(N / PAGE));
      for (let page = 0; page < pages; page++) {
        const { result, rows, keys } = await measure(`list name p${page}`, () =>
          listProjects({}, cursor, PAGE),
        );
        expect(rows).toBeLessThanOrEqual(PAGE * 3); // the page + its area / locality lookups
        expect(keys).toBeLessThanOrEqual(PAGE * 2);
        for (const row of result.rows) seen.add(row.id);
        if (page === 0) expect(result.total).toBe(N);
        cursor = result.next;
      }
      expect(seen.size).toBe(Math.min(pages * PAGE, N));
    });

    it('listProjects by updated with one filter: O(page)', async () => {
      const { result, rows, keys } = await measure('list updated status', () =>
        listProjects({ status: 'maintenance', sort: 'updated' }, null, PAGE),
      );
      expect(result.rows).toHaveLength(PAGE);
      expect(rows).toBeLessThanOrEqual(PAGE * 3);
      expect(keys).toBeLessThanOrEqual(PAGE * 2);
      const next = await measure('list updated status p2', () =>
        listProjects({ status: 'maintenance' }, result.next, PAGE),
      );
      expect(next.rows).toBeLessThanOrEqual(PAGE * 3);
    });

    it('listProjects with three filters: rows O(page); keys bounded by the filtered facets', async () => {
      const filter = { countryId: COUNTRIES[1]!, type: 'school', status: 'active' };
      const first = await measure('list 3 filters', () => listProjects(filter, null, PAGE));
      expect(first.result.rows).toHaveLength(PAGE);
      expect(first.rows).toBeLessThanOrEqual(PAGE * 3);
      // the matching ids are intersected on index keys read in batch requests (never rows):
      // country (1/4) + type (1/3) + status (1/4) of the table, plus the walk of the page
      expect(first.keys).toBeLessThan(N);
      const second = await measure('list 3 filters p2', () =>
        listProjects(filter, first.result.next, PAGE),
      );
      expect(second.rows).toBeLessThanOrEqual(PAGE * 3);
      expect(second.keys).toBeLessThan(N);
      expect(second.result.total).toBe(first.result.total);
      const ids = new Set([...first.result.rows, ...second.result.rows].map((r) => r.id));
      expect(ids.size).toBe(PAGE * 2);
    });

    it('listProjects with a text query: rows O(page)', async () => {
      const common = await measure('list q common', () => listProjects({ q: 'مسجد' }, null, PAGE));
      expect(common.result.rows).toHaveLength(PAGE);
      expect(common.rows).toBeLessThanOrEqual(PAGE * 3);
      const rare = await measure('list q rare', () =>
        listProjects({ q: sample.code! }, null, PAGE),
      );
      expect(rare.result.rows.map((x) => x.id)).toEqual([sample.id]);
      expect(rare.rows).toBeLessThanOrEqual(10);
    });

    it('projectsInBounds at zoom 14 reads the covered grid cells only', async () => {
      // a zoom-14 viewport is about 0.02 x 0.02 degrees
      const box: [number, number, number, number] = [
        sample.lon! - 0.01,
        sample.lat! - 0.01,
        sample.lon! + 0.01,
        sample.lat! + 0.01,
      ];
      const { result, rows } = await measure('in bounds z14', () => projectsInBounds(box, {}, 500));
      expect(result.map((x) => x.id)).toContain(sample.id);
      expect(rows).toBeLessThan(100); // ~ 20 000 / (200 x 200 cells) x 3 x 3 cells
      const zoomedOut = await measure('in bounds world', () =>
        projectsInBounds([-180, -90, 180, 90], {}, 100),
      );
      expect(zoomedOut.rows).toBeLessThanOrEqual(2001);
    });

    it('searchLocal stays bounded however common the words are', async () => {
      for (const q of ['مسجد', 'masjid nur', 'النور 5', sample.code!, 'محمد']) {
        const { result, rows, keys } = await measure(`search ${q}`, () => searchLocal(q, 20));
        expect(result.length).toBeGreaterThan(0);
        expect(rows, q).toBeLessThanOrEqual(4 * 80 + 4 * 20 * 6); // candidates per kind + staff/donor links
        expect(keys, q).toBeLessThanOrEqual(4 * 3 * SEARCH_KEY_BUDGET);
      }
    });

    it('duplicates and person candidates read a neighbourhood, not the table', async () => {
      const dup = await measure('duplicates', () =>
        findLocalDuplicates({
          type: sample.type,
          lon: sample.lon!,
          lat: sample.lat!,
          name: sample.name_ar,
        }),
      );
      expect(dup.result.map((h) => h.id)).toContain(sample.id);
      expect(dup.rows).toBeLessThan(200);
      const cand = await measure('person candidates', () =>
        findLocalPersonCandidates({ name: 'محمد بن النور 12' }),
      );
      expect(cand.rows).toBeLessThan(400);
    });

    it('the open-maintenance list pages over its own sparse index', async () => {
      const { result, rows } = await measure('maintenance', () =>
        listOpenMaintenance({}, null, PAGE),
      );
      expect(result.rows).toHaveLength(PAGE);
      expect(rows).toBeLessThanOrEqual(PAGE * 3 + 10);
    });

    it('prints the timings (informational)', () => {
      // eslint-disable-next-line no-console -- informational timings of the perf suite
      console.info('db perf (ms):', JSON.stringify(timings));
      expect(Object.keys(timings).length).toBeGreaterThan(5);
    });
  },
);

/**
 * Lists over the local stores: keyset paging straight from the indexes, never a table scan.
 *
 * Project lists are driven by the facet indexes `_fn` (sorted by name) and `_fu` (sorted by
 * last change): every entry is `[facet, sort key, id]`, so one filter (or none) is a single
 * index range and a page costs `limit` row reads. With several filters the rarest facet
 * drives; the others (and a text query) are checked on index keys only, and rows are read
 * for the final page alone. The first page of a multi-filter list counts its total in the
 * same pass over the driving facet (index keys, no rows).
 */
import Dexie from 'dexie';
import { bboxContains, gridCell, gridRangesForBBox, isValidLonLat, type BBox } from '../lib/geo';
import {
  FACET_ALL,
  FACET_INCOMPLETE,
  FACET_OPEN_MAINTENANCE,
  facetOf,
  type StoredMaintenance,
  type StoredPerson,
  type StoredProject,
} from './derive';
import { db } from './dexie';
import { getLocalSession } from './meta';
import { matchesAllWords, queryWords } from './tokens';
import { publicRow } from './bundle';
import type { Row } from './types';

// ---------------------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------------------

export type ProjectSort = 'name' | 'updated';

export interface ProjectFilter {
  /** Words that must each start a word of the names, the code or the locality. */
  q?: string;
  countryId?: string;
  branchId?: string;
  /** An area of any level: the area and everything inside it. */
  adminAreaId?: string;
  type?: string;
  status?: string;
  recordState?: string;
  /** Completeness below 100. */
  incomplete?: boolean;
  /** Created by the signed-in user. */
  mine?: boolean;
  /** At least one open / in-progress maintenance entry. */
  openMaintenance?: boolean;
  /** `name` (default): by Arabic name; `updated`: most recently changed first. */
  sort?: ProjectSort;
}

/** Opaque: pass back unchanged together with the same filter. */
export interface ListCursor {
  s: ProjectSort;
  k: string | number;
  id: string;
  /** Total of the first page, carried along. */
  total: number;
}

/** Light list row (same names as the server's `projects_page` row). */
export interface ProjectListItem {
  id: string;
  code: string | null;
  name_ar: string;
  name_latin: string | null;
  type: Row<'projects'>['type'];
  status: Row<'projects'>['status'];
  record_state: Row<'projects'>['record_state'];
  /** Server value, or the local estimate while the project has unsynced work. */
  completeness: number;
  capacity: number | null;
  lon: number | null;
  lat: number | null;
  country_id: string | null;
  branch_id: string | null;
  admin_area_id: string | null;
  locality_id: string | null;
  area_level: number | null;
  area_name_ar: string | null;
  area_name_en: string | null;
  area_name_sw: string | null;
  locality_name_ar: string | null;
  locality_name_latin: string | null;
  /** Storage path of the thumbnail (bucket `photos`), or null. */
  cover_thumb: string | null;
  /** `project_photos.id` of that thumbnail (local blob lookup). */
  cover_photo_id: string | null;
  updated_at: string;
  version: number;
  created_by: string | null;
  /** True while the row has changes the server has not acknowledged. */
  dirty: boolean;
  conflict: boolean;
  failed: boolean;
}

export interface ProjectPage {
  rows: ProjectListItem[];
  next: ListCursor | null;
  total: number;
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

/** Like the server: a missing / non-numeric limit is the default, anything else is clamped to 1..max. */
const clampLimit = (limit: number | undefined, fallback: number, max: number): number => {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : fallback;
  return Math.max(1, Math.min(max, n));
};

function facetsFor(filter: ProjectFilter, userId: string | null): string[] {
  const f: string[] = [];
  if (filter.branchId) f.push(facetOf.branch(filter.branchId));
  if (filter.adminAreaId) f.push(facetOf.area(filter.adminAreaId));
  if (filter.countryId) f.push(facetOf.country(filter.countryId));
  if (filter.recordState) f.push(facetOf.recordState(filter.recordState));
  if (filter.status) f.push(facetOf.status(filter.status));
  if (filter.type) f.push(facetOf.type(filter.type));
  if (filter.openMaintenance) f.push(FACET_OPEN_MAINTENANCE);
  if (filter.mine && filter.incomplete && userId) f.push(facetOf.creatorIncomplete(userId));
  else {
    if (filter.mine && userId) f.push(facetOf.creator(userId));
    if (filter.incomplete) f.push(FACET_INCOMPLETE);
  }
  return f;
}

const indexOfSort = (sort: ProjectSort): '_fn' | '_fu' => (sort === 'name' ? '_fn' : '_fu');

function facetRange(sort: ProjectSort, facet: string) {
  return db.projects
    .where(indexOfSort(sort))
    .between([facet, Dexie.minKey], [facet, Dexie.maxKey], true, true);
}

/**
 * The next project ids of a facet in list order, strictly after `pos` (`[sort key, id]`).
 * Primary keys only, read in ONE batch request (`getAllKeys`) — no cursor step per key,
 * which is what makes index walks slow on IndexedDB.
 */
async function nextIds(
  sort: ProjectSort,
  facet: string,
  pos: [string | number, string] | null,
  n: number,
): Promise<string[]> {
  const index = indexOfSort(sort);
  const c =
    sort === 'name'
      ? db.projects
          .where(index)
          .between(
            pos ? [facet, pos[0], pos[1]] : [facet, Dexie.minKey],
            [facet, Dexie.maxKey],
            !pos,
            true,
          )
      : db.projects
          .where(index)
          .between(
            [facet, Dexie.minKey],
            pos ? [facet, pos[0], pos[1]] : [facet, Dexie.maxKey],
            true,
            !pos,
          )
          .reverse();
  return (await c.limit(n).primaryKeys()) as string[];
}

/** All project ids of a facet (one batch key read of the index range, no rows). */
async function facetIds(sort: ProjectSort, facet: string): Promise<Set<string>> {
  return new Set((await facetRange(sort, facet).primaryKeys()) as string[]);
}

function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const out = new Set<string>();
  for (const id of small) if (large.has(id)) out.add(id);
  return out;
}

/** The value a row has in the sort index (`_fn` / `_fu` middle component). */
const sortKeyOf = (sort: ProjectSort, p: StoredProject): string | number =>
  sort === 'name' ? (p.name_ar ?? '') : (p._u ?? 0);

/** List order of stored rows: the same order as the `_fn` / `_fu` index entries. */
function compareRows(sort: ProjectSort): (a: StoredProject, b: StoredProject) => number {
  if (sort === 'name') {
    return (a, b) => {
      const x = a.name_ar ?? '';
      const y = b.name_ar ?? '';
      return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    };
  }
  return (a, b) => (b._u ?? 0) - (a._u ?? 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** A text query with at most this many matches is answered from the matching rows directly. */
const smallSetLimit = (size: number): number => Math.max(size * 4, 200);

/** Ids of projects whose tokens match every query word (index keys only). */
async function projectIdsMatching(qWords: string[]): Promise<Set<string>> {
  let result: Set<string> | null = null;
  // Longer words first: they are rarer, so the running set shrinks early.
  const ordered = qWords.slice().sort((a, b) => b.length - a.length);
  for (const w of ordered) {
    const ids = (await db.projects.where('_tokens').startsWith(w).primaryKeys()) as string[];
    const set = new Set(ids);
    if (result === null) {
      result = set;
    } else {
      const narrowed = new Set<string>();
      for (const id of result) if (set.has(id)) narrowed.add(id);
      result = narrowed;
    }
    if (result.size === 0) break;
  }
  return result ?? new Set<string>();
}

interface Lookups {
  areas: Map<string, Row<'admin_areas'>>;
  localities: Map<string, Row<'localities'>>;
}

async function lookupsFor(rows: StoredProject[]): Promise<Lookups> {
  const areaIds = [...new Set(rows.map((r) => r.admin_area_id).filter((x): x is string => !!x))];
  const locIds = [...new Set(rows.map((r) => r.locality_id).filter((x): x is string => !!x))];
  const [areas, locs] = await Promise.all([
    areaIds.length ? db.admin_areas.bulkGet(areaIds) : Promise.resolve([]),
    locIds.length ? db.localities.bulkGet(locIds) : Promise.resolve([]),
  ]);
  const out: Lookups = { areas: new Map(), localities: new Map() };
  for (const a of areas) if (a) out.areas.set(a.id, a);
  for (const l of locs) if (l) out.localities.set(l.id, l);
  return out;
}

export function toListItem(p: StoredProject, lookups?: Lookups): ProjectListItem {
  const area = p.admin_area_id ? lookups?.areas.get(p.admin_area_id) : undefined;
  const loc = p.locality_id ? lookups?.localities.get(p.locality_id) : undefined;
  return {
    id: p.id,
    code: p.code,
    name_ar: p.name_ar,
    name_latin: p.name_latin,
    type: p.type,
    status: p.status,
    record_state: p.record_state,
    completeness: p._cmp ?? p.completeness ?? 0,
    capacity: p.capacity,
    lon: p.lon,
    lat: p.lat,
    country_id: p.country_id,
    branch_id: p.branch_id,
    admin_area_id: p.admin_area_id,
    locality_id: p.locality_id,
    area_level: area?.level ?? null,
    area_name_ar: area?.name_ar ?? null,
    area_name_en: area?.name_en ?? null,
    area_name_sw: area?.name_sw ?? null,
    locality_name_ar: loc?.name_ar ?? null,
    locality_name_latin: loc?.name_latin ?? null,
    cover_thumb: p._cover_thumb ?? null,
    cover_photo_id: p._cover ?? null,
    updated_at: p.updated_at,
    version: p.version,
    created_by: p.created_by,
    dirty: p._dirty === 1,
    conflict: p._conflict === 1,
    failed: p._failed === 1,
  };
}

/** The filter as a predicate on a stored row (map viewport, joined lists). */
function matchesFilter(
  p: StoredProject,
  filter: ProjectFilter,
  userId: string | null,
  qWords: string[] | null,
): boolean {
  if (filter.type && p.type !== filter.type) return false;
  if (filter.status && p.status !== filter.status) return false;
  if (filter.recordState && p.record_state !== filter.recordState) return false;
  if (filter.countryId && p.country_id !== filter.countryId) return false;
  if (filter.branchId && p.branch_id !== filter.branchId) return false;
  if (filter.adminAreaId && !(p._areas ?? []).includes(filter.adminAreaId)) return false;
  if (filter.incomplete && !((p._cmp ?? p.completeness ?? 0) < 100)) return false;
  if (filter.mine && (!userId || p.created_by !== userId)) return false;
  if (filter.openMaintenance && p._om !== 1) return false;
  if (qWords && qWords.length > 0 && !matchesAllWords(p._tokens, qWords)) return false;
  return true;
}

const hasRowFilter = (f: ProjectFilter): boolean =>
  !!(
    f.q ||
    f.countryId ||
    f.branchId ||
    f.adminAreaId ||
    f.type ||
    f.status ||
    f.recordState ||
    f.incomplete ||
    f.mine ||
    f.openMaintenance
  );

// ---------------------------------------------------------------------------------------
// listProjects
// ---------------------------------------------------------------------------------------

/**
 * One page of the project register. `after` = `next` of the previous page (same filter),
 * `null` for the first page. `total` is computed on the first page and carried in the cursor.
 */
export async function listProjects(
  filter: ProjectFilter,
  after: ListCursor | null,
  limit?: number,
): Promise<ProjectPage> {
  const size = clampLimit(limit, 50, 200);
  const sort: ProjectSort = after?.s ?? filter.sort ?? 'name';
  const userId = filter.mine ? (await getLocalSession()).userId : null;
  if (filter.mine && !userId) return { rows: [], next: null, total: 0 };

  return db.transaction('r', [db.projects, db.admin_areas, db.localities], async () => {
    const facets = facetsFor(filter, userId);
    if (facets.length === 0) facets.push(FACET_ALL);
    // Words shorter than two characters are not indexed: a query made only of such words
    // (the first keystroke) does not filter yet.
    const qWords = filter.q ? queryWords(filter.q) : [];
    const qIds = qWords.length > 0 ? await projectIdsMatching(qWords) : null;
    if (qIds && qIds.size === 0) return { rows: [], next: null, total: 0 };

    // The rarest facet drives the walk. (Native counts walk the index range inside the engine:
    // a later page of a one-facet list needs neither a driver choice nor a total.)
    const sizes =
      facets.length === 1 && after
        ? [after.total]
        : await Promise.all(facets.map((f) => facetRange(sort, f).count()));
    let driverAt = 0;
    for (let i = 1; i < sizes.length; i++)
      if ((sizes[i] ?? 0) < (sizes[driverAt] ?? 0)) driverAt = i;
    const driver = facets[driverAt]!;
    const conditions = facets
      .map((f, i) => ({ f, n: sizes[i] ?? 0 }))
      .filter((x) => x.f !== FACET_ALL)
      .sort((a, b) => a.n - b.n);
    const simple = conditions.length <= 1 && qIds === null;
    if (!after && (sizes[driverAt] ?? 0) === 0) return { rows: [], next: null, total: 0 };

    // Several conditions (or a text query): the exact set of matching ids, intersected on
    // index keys read in batches, smallest first — never rows.
    let matchSet: Set<string> | null = null;
    if (!simple) {
      let set: Set<string> | null = qIds;
      for (const { f } of conditions) {
        const ids = await facetIds(sort, f);
        set = set ? intersect(set, ids) : ids;
        if (set.size === 0) break;
      }
      matchSet = set ?? new Set<string>();
    }
    const total = after ? after.total : matchSet ? matchSet.size : (sizes[driverAt] ?? 0);
    if (!after && total === 0) return { rows: [], next: null, total: 0 };
    const cmp = compareRows(sort);

    if (matchSet && matchSet.size <= smallSetLimit(size)) {
      // Few matches: read exactly those rows and order them in memory — fewer reads than
      // walking an index to find a handful of ids.
      const found = (await db.projects.bulkGet([...matchSet])) as Array<StoredProject | undefined>;
      const matching = found.filter((r): r is StoredProject => !!r).sort(cmp);
      let start = 0;
      if (after) {
        const probe = {
          name_ar: String(after.k),
          _u: Number(after.k),
          id: after.id,
        } as StoredProject;
        while (start < matching.length && cmp(matching[start]!, probe) <= 0) start++;
      }
      const page = matching.slice(start, start + size);
      const lookups = await lookupsFor(page);
      const lastRow = page[page.length - 1];
      const next: ListCursor | null =
        matching.length > start + size && lastRow
          ? { s: sort, k: sortKeyOf(sort, lastRow), id: lastRow.id, total }
          : null;
      return { rows: page.map((r) => toListItem(r, lookups)), next, total };
    }

    // Walk the driving facet in list order, in batches of ids; one row read per batch tells
    // where the next batch starts. Collect limit + 1 ids: the extra one tells whether another
    // page exists.
    const wanted = size + 1;
    const picked: string[] = [];
    let pos: [string | number, string] | null = after ? [after.k, after.id] : null;
    let chunk = matchSet ? wanted * 4 : wanted;
    for (;;) {
      const batch = await nextIds(sort, driver, pos, chunk);
      for (const id of batch) {
        if (matchSet && !matchSet.has(id)) continue;
        picked.push(id);
        if (picked.length === wanted) break;
      }
      if (picked.length >= wanted || batch.length < chunk) break;
      const lastId = batch[batch.length - 1]!;
      const lastRow = (await db.projects.get(lastId)) as StoredProject | undefined;
      if (!lastRow) break;
      pos = [sortKeyOf(sort, lastRow), lastId];
      chunk = Math.min(chunk * 2, 8000);
    }

    const pageIds = picked.slice(0, size);
    const found = (await db.projects.bulkGet(pageIds)) as Array<StoredProject | undefined>;
    const rows = found.filter((r): r is StoredProject => !!r);
    const lookups = await lookupsFor(rows);
    const last = rows[rows.length - 1];
    const next: ListCursor | null =
      picked.length > size && last
        ? { s: sort, k: sortKeyOf(sort, last), id: last.id, total }
        : null;
    return { rows: rows.map((r) => toListItem(r, lookups)), next, total };
  });
}

/** "Incomplete records" (brief §7.5): `mine` limits the list to the signed-in user's projects. */
export function listIncompleteProjects(
  opts: { mine?: boolean; sort?: ProjectSort } = {},
  after: ListCursor | null = null,
  limit?: number,
): Promise<ProjectPage> {
  return listProjects(
    { incomplete: true, mine: opts.mine ?? true, sort: opts.sort ?? 'updated' },
    after,
    limit,
  );
}

// ---------------------------------------------------------------------------------------
// Map viewport
// ---------------------------------------------------------------------------------------

/** Rows looked at by `projectsInBounds` when the box is too large for the cell grid. */
export const IN_BOUNDS_SCAN_BUDGET = 2000;

/**
 * Projects inside a bounding box `[minLon, minLat, maxLon, maxLat]` for the map at
 * zoom >= 14, at most `limit`. Reads only the grid cells the box covers.
 */
export async function projectsInBounds(
  bbox: [number, number, number, number],
  filter: ProjectFilter,
  limit: number,
): Promise<ProjectListItem[]> {
  const size = clampLimit(limit, 500, 5000);
  const box: BBox = [
    Math.min(bbox[0], bbox[2]),
    Math.min(bbox[1], bbox[3]),
    Math.max(bbox[0], bbox[2]),
    Math.max(bbox[1], bbox[3]),
  ];
  const userId = filter.mine ? (await getLocalSession()).userId : null;
  const qWords = filter.q ? queryWords(filter.q) : null;
  const inside = (p: StoredProject): boolean =>
    isValidLonLat(p) && bboxContains(box, p) && matchesFilter(p, filter, userId, qWords);

  const ranges = gridRangesForBBox(box);
  if (ranges) {
    // Only the grid cells the box covers are read.
    const rows = (await db.projects
      .where('_cell')
      .inAnyRange(ranges, { includeLowers: true, includeUppers: true })
      .filter((p) => inside(p as StoredProject))
      .limit(size)
      .toArray()) as StoredProject[];
    return rows.map((r) => toListItem(r));
  }
  // A box taller than the grid budget: the caller is zoomed far out, where the map shows the
  // server's clustered tiles instead. Answer from one cell range and look at a bounded
  // number of rows, so that a careless call can never read the whole store.
  let examined = 0;
  const budget = Math.max(size * 4, IN_BOUNDS_SCAN_BUDGET);
  const rows = (await db.projects
    .where('_cell')
    .between(
      gridCell({ lon: box[0], lat: box[1] }),
      gridCell({ lon: box[2], lat: box[3] }),
      true,
      true,
    )
    .until(() => ++examined > budget)
    .filter((p) => inside(p as StoredProject))
    .limit(size)
    .toArray()) as StoredProject[];
  return rows.map((r) => toListItem(r));
}

// ---------------------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------------------

export interface MaintenanceListItem {
  entry: Row<'project_maintenance'>;
  /** Null when the project is not on the device (yet). */
  project: ProjectListItem | null;
}

export interface MaintenanceCursor {
  k: [number, number, string];
  total: number;
}

/**
 * Open and in-progress maintenance entries, most urgent first, then newest. Optional project
 * filter (country, branch, type, …). Keyset-paged over the sparse `_mk` index, which holds
 * open entries only.
 */
export async function listOpenMaintenance(
  filter: ProjectFilter = {},
  after: MaintenanceCursor | null = null,
  limit?: number,
): Promise<{ rows: MaintenanceListItem[]; next: MaintenanceCursor | null; total: number }> {
  const size = clampLimit(limit, 50, 200);
  const filtered = hasRowFilter(filter);
  const userId = filter.mine ? (await getLocalSession()).userId : null;
  const qWords = filter.q ? queryWords(filter.q) : null;

  return db.transaction('r', [db.project_maintenance, db.projects], async () => {
    const out: MaintenanceListItem[] = [];
    let more = false;
    let pos: [number, number, string] | null = after?.k ?? null;
    const chunk = filtered ? size * 2 : size + 1;

    const join = async (entries: StoredMaintenance[]): Promise<MaintenanceListItem[]> => {
      const projects = (await db.projects.bulkGet(entries.map((e) => e.project_id))) as Array<
        StoredProject | undefined
      >;
      const items: MaintenanceListItem[] = [];
      entries.forEach((e, i) => {
        const p = projects[i];
        if (filtered && !(p && matchesFilter(p, filter, userId, qWords))) return;
        items.push({ entry: publicRow(e), project: p ? toListItem(p) : null });
      });
      return items;
    };

    for (;;) {
      const batch: StoredMaintenance[] = await db.project_maintenance
        .where('_mk')
        .between(pos ?? [Dexie.minKey], [Dexie.maxKey], pos === null, true)
        .limit(chunk)
        .toArray();
      if (batch.length === 0) break;
      for (const item of await join(batch)) {
        if (out.length === size) {
          more = true;
          break;
        }
        out.push(item);
      }
      if (more || batch.length < chunk) break;
      pos = batch[batch.length - 1]!._mk ?? null;
      if (pos === null) break;
    }

    let total: number;
    if (after) total = after.total;
    else if (!filtered)
      total = await db.project_maintenance
        .where('_mk')
        .between([Dexie.minKey], [Dexie.maxKey])
        .count();
    else {
      // Open entries are few; count the filtered ones by walking them once (first page only).
      total = 0;
      let p: [number, number, string] | null = null;
      for (;;) {
        const batch: StoredMaintenance[] = await db.project_maintenance
          .where('_mk')
          .between(p ?? [Dexie.minKey], [Dexie.maxKey], p === null, true)
          .limit(500)
          .toArray();
        if (batch.length === 0) break;
        total += (await join(batch)).length;
        if (batch.length < 500) break;
        p = batch[batch.length - 1]!._mk ?? null;
        if (p === null) break;
      }
    }

    const lastEntry = out[out.length - 1]?.entry as StoredMaintenance | undefined;
    const lastKey = lastEntry
      ? ((await db.project_maintenance.get(lastEntry.id)) as StoredMaintenance | undefined)?._mk
      : undefined;
    return { rows: out, next: more && lastKey ? { k: lastKey, total } : null, total };
  });
}

// ---------------------------------------------------------------------------------------
// People directory
// ---------------------------------------------------------------------------------------

export interface PersonCursor {
  k: string;
  id: string;
}

/**
 * Persons by name. Without `q`: keyset pages over the name index. With `q`: the best
 * `limit` matches (every word must start a word of the name), no further pages.
 * Viewers have no persons on the device, so the list is empty for them.
 */
export async function listPersons(
  q: string | undefined,
  after: PersonCursor | null,
  limit?: number,
): Promise<{ rows: Array<Row<'persons'>>; next: PersonCursor | null }> {
  const size = clampLimit(limit, 50, 200);
  const qWords = q ? queryWords(q) : [];
  if (q && q.trim() !== '' && qWords.length > 0) {
    const cap = size * 4;
    const lists = await Promise.all(
      qWords.map(
        (w) =>
          db.persons.where('_tokens').startsWith(w).limit(cap).primaryKeys() as Promise<string[]>,
      ),
    );
    lists.sort((a, b) => a.length - b.length);
    const ids = [...new Set(lists[0] ?? [])];
    const found = (await db.persons.bulkGet(ids)) as Array<StoredPerson | undefined>;
    const rows = found
      .filter((p): p is StoredPerson => !!p && matchesAllWords(p._tokens, qWords))
      .sort((a, b) =>
        (a._name ?? '') < (b._name ?? '') ? -1 : (a._name ?? '') > (b._name ?? '') ? 1 : 0,
      )
      .slice(0, size);
    return { rows: rows.map(publicRow), next: null };
  }
  const rows = (await db.persons
    .where('[_name+id]')
    // `[maxKey]` sorts after every `[name, id]`. Never put the shared `Dexie.maxKey` object
    // twice into one key: IndexedDB rejects a key that contains the same array twice.
    .between(after ? [after.k, after.id] : [Dexie.minKey], [Dexie.maxKey], !after, true)
    .limit(size + 1)
    .toArray()) as StoredPerson[];
  const page = rows.slice(0, size);
  const last = page[page.length - 1];
  return {
    rows: page.map(publicRow),
    next: rows.length > size && last ? { k: last._name ?? '', id: last.id } : null,
  };
}

// ---------------------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------------------

export interface BadgeCounts {
  /** Open / in-progress maintenance entries. */
  openMaintenance: number;
  /** Projects with at least one such entry. */
  projectsWithOpenMaintenance: number;
  /** Projects with completeness below 100. */
  incomplete: number;
  /** … created by the signed-in user. */
  incompleteMine: number;
  /** Projects waiting for review (`record_state = submitted`). */
  submitted: number;
  /** Projects returned to the collector. */
  returned: number;
  /** Field conflicts waiting for a reviewer (reviewer devices only). */
  openConflicts: number;
  unreadNotifications: number;
  pendingOps: number;
  failedOps: number;
  drafts: number;
  projects: number;
}

/** Numbers for navigation badges — index counts only, no rows are read. */
export async function badgeCounts(): Promise<BadgeCounts> {
  const { userId } = await getLocalSession();
  const facetCount = (facet: string): Promise<number> => facetRange('name', facet).count();
  const [
    openMaintenance,
    projectsWithOpenMaintenance,
    incomplete,
    incompleteMine,
    submitted,
    returned,
    openConflicts,
    unreadNotifications,
    pendingOps,
    failedOps,
    draftCount,
    projects,
  ] = await Promise.all([
    db.project_maintenance.where('_mk').between([Dexie.minKey], [Dexie.maxKey]).count(),
    facetCount(FACET_OPEN_MAINTENANCE),
    facetCount(FACET_INCOMPLETE),
    userId ? facetCount(facetOf.creatorIncomplete(userId)) : Promise.resolve(0),
    facetCount(facetOf.recordState('submitted')),
    facetCount(facetOf.recordState('returned')),
    db.sync_conflicts.where('state').equals('open').count(),
    db.notifications.where('_unread').equals(1).count(),
    db.outbox.count(),
    db.failed_ops.count(),
    db.drafts.count(),
    db.projects.count(),
  ]);
  return {
    openMaintenance,
    projectsWithOpenMaintenance,
    incomplete,
    incompleteMine,
    submitted,
    returned,
    openConflicts,
    unreadNotifications,
    pendingOps,
    failedOps,
    drafts: draftCount,
    projects,
  };
}

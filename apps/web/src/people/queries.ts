/**
 * Read-only Dexie queries of the people module (web.md §5: feature queries live next to the
 * feature, on top of the exported `db`). Nothing here writes; writes go through `mutate()`
 * (see persons.ts) and the merge RPCs (rpc.ts).
 */
import Dexie from 'dexie';
import type { MyContext } from '../auth';
import { db, type PersonCursor, type Row } from '../db';
import { norm } from '../lib/normalize';
import { dialForIso, dialFromTimeZone } from './phone';

type Person = Row<'persons'>;
type Staff = Row<'project_staff'>;
type Project = Row<'projects'>;
type Area = Row<'admin_areas'>;
type Pay = Row<'staff_compensation'>;
export type MergeRequest = Row<'person_merge_requests'>;

/** Strips the local index fields (`_tokens`, `_name`, …) but keeps `_dirty` / `_conflict`. */
function plain<T extends object>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!k.startsWith('_') || k === '_dirty' || k === '_conflict' || k === '_failed') out[k] = v;
  }
  return out as T;
}

export async function loadPerson(id: string): Promise<Person | undefined> {
  const row = await db.persons.get(id);
  return row && !row.deleted_at ? plain(row) : undefined;
}

/** Root-first chain of an administrative area: region, district, ward. */
export async function areaPath(id: string | null | undefined): Promise<Area[]> {
  const chain: Area[] = [];
  let next = id ?? null;
  for (let depth = 0; next && depth < 6; depth++) {
    const area = await db.admin_areas.get(next);
    if (!area) break;
    chain.unshift(area);
    next = area.parent_id;
  }
  return chain;
}

export interface Assignment {
  staff: Staff;
  /** undefined when the project is not on this device. */
  project: Project | undefined;
  /** Current salary row; only filled when the caller may see restricted data. */
  pay: Pay | null;
  /** true while the assignment has no end date or ends in the future. */
  current: boolean;
}

export interface PersonDetail {
  person: Person;
  homePath: Area[];
  assignments: Assignment[];
  /** Assignments whose project is not on the device. */
  hidden: number;
}

const today = (): string => new Date().toISOString().slice(0, 10);

/** The salary row in force today (latest `effective_from` not in the future), else the earliest. */
export function currentPay(rows: readonly Pay[], day = today()): Pay | null {
  const live = rows.filter((r) => !r.deleted_at);
  const due = live
    .filter((r) => r.effective_from <= day)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  if (due[0]) return due[0];
  return [...live].sort((a, b) => a.effective_from.localeCompare(b.effective_from))[0] ?? null;
}

/**
 * Everything the person card shows. Salaries are read only when `withPay` (restricted
 * access): they come from the rows a country manager / HQ device pulled.
 */
export async function loadPersonDetail(
  id: string,
  opts: { withPay: boolean },
): Promise<PersonDetail | null> {
  const person = await loadPerson(id);
  if (!person) return null;
  const links = (await db.project_staff.where('person_id').equals(id).toArray()).filter(
    (s) => !s.deleted_at,
  );
  const projects = await db.projects.bulkGet(links.map((l) => l.project_id));
  const pays = opts.withPay
    ? await db.staff_compensation
        .where('project_staff_id')
        .anyOf(links.map((l) => l.id))
        .toArray()
    : [];
  const day = today();
  const assignments: Assignment[] = links.map((staff, i) => ({
    staff: plain(staff),
    project: projects[i] && !projects[i]!.deleted_at ? plain(projects[i]!) : undefined,
    pay: opts.withPay
      ? currentPay(
          pays.filter((p) => p.project_staff_id === staff.id),
          day,
        )
      : null,
    current: staff.end_date === null || staff.end_date >= day,
  }));
  assignments.sort(
    (a, b) =>
      Number(b.current) - Number(a.current) ||
      (b.staff.start_date ?? '').localeCompare(a.staff.start_date ?? '') ||
      (a.staff.id < b.staff.id ? -1 : 1),
  );
  return {
    person,
    homePath: await areaPath(person.home_admin_area_id),
    assignments: assignments.filter((a) => a.project),
    hidden: assignments.filter((a) => !a.project).length,
  };
}

export interface PersonSummary {
  roles: Array<Staff['role']>;
  projects: number;
  home: Area | undefined;
}

/** Roles, number of projects and home area of a page of directory rows (one query each). */
export async function summarisePeople(
  people: readonly Person[],
): Promise<Map<string, PersonSummary>> {
  const out = new Map<string, PersonSummary>();
  if (people.length === 0) return out;
  const ids = people.map((p) => p.id);
  const links = (await db.project_staff.where('person_id').anyOf(ids).toArray()).filter(
    (s) => !s.deleted_at,
  );
  const homeIds = [
    ...new Set(people.map((p) => p.home_admin_area_id).filter((x): x is string => !!x)),
  ];
  const homes = new Map<string, Area>();
  for (const a of await db.admin_areas.bulkGet(homeIds)) if (a) homes.set(a.id, a);
  for (const p of people) {
    const mine = links.filter((l) => l.person_id === p.id);
    out.set(p.id, {
      roles: [...new Set(mine.map((l) => l.role))],
      projects: new Set(mine.map((l) => l.project_id)).size,
      home: p.home_admin_area_id ? homes.get(p.home_admin_area_id) : undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Directory search with keyset pages (brief §5: pages of 50 ordered by a key, searched
// lists included — `listPersons(q)` answers one page of best matches without a cursor)
// ---------------------------------------------------------------------------------------

const SPLIT_RE = /[^\p{L}\p{N}]+/u;
const MAX_TOKEN_LENGTH = 32;
const ALEF_LAM = String.fromCodePoint(0x0627, 0x0644);

/**
 * Words of a directory query, in the form of the local index's `_tokens`: normalised
 * (`norm`), one-character words dropped, long words cut to 32 characters, the Arabic article
 * stripped when at least three letters remain (the index stores both forms). Twin of the
 * query words of `src/db` (kept equal by queries.test.ts).
 */
export function personQueryWords(q: string): string[] {
  const out = new Set<string>();
  for (const raw of norm(q).split(SPLIT_RE)) {
    const w = raw.length > MAX_TOKEN_LENGTH ? raw.slice(0, MAX_TOKEN_LENGTH) : raw;
    if (w.length < 2) continue;
    out.add(w.length >= 5 && w.startsWith(ALEF_LAM) ? w.slice(2) : w);
  }
  return [...out];
}

export interface PersonSearchPage {
  rows: Person[];
  /** Pass back with the same query for the next page; null on the last page. */
  next: PersonCursor | null;
  /** Number of persons matching the query on this device. */
  total: number;
}

type Indexed = Person & { _name?: string };

const byNameThenId = (a: Indexed, b: Indexed): number => {
  const x = a._name ?? '';
  const y = b._name ?? '';
  return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

const isLive = <T extends Person>(p: T | undefined): p is T =>
  !!p && !p.deleted_at && !p.merged_into_id;

/** Ids of the persons whose tokens start with every query word (index keys only, no rows). */
async function matchingPersonIds(words: readonly string[]): Promise<Set<string>> {
  let ids: Set<string> | null = null;
  // Longer words first: they are rarer, so the running set shrinks early.
  for (const w of [...words].sort((a, b) => b.length - a.length)) {
    const keys = (await db.persons.where('_tokens').startsWith(w).primaryKeys()) as string[];
    const found = new Set(keys);
    if (ids === null) ids = found;
    else {
      const narrowed = new Set<string>();
      for (const id of ids) if (found.has(id)) narrowed.add(id);
      ids = narrowed;
    }
    if (ids.size === 0) break;
  }
  const out = ids ?? new Set<string>();
  // Deleted / merged persons leave the device with the server's tombstone; until the local
  // soft delete is pushed they are dirty rows — the only ones to read here.
  if (out.size > 0) {
    for (const p of await db.persons.where('_dirty').equals(1).toArray())
      if (p.deleted_at || p.merged_into_id) out.delete(p.id);
  }
  return out;
}

/** Index keys read per step when walking the name index of a large match set. */
const WALK_BATCH = 500;

/**
 * One page of the persons matching `q` (every word starts a word of the Arabic or Latin
 * name), in directory order (`_name`, then id) — the order of the unfiltered keyset pages.
 * `after` = `next` of the previous page of the same query, `null` for the first page.
 * `limit` may cover several pages (up to 10 000 rows): the directory re-reads the pages it
 * already shows in one call when they change. Answers null when `q` has no searchable word
 * (shorter than two characters): the caller shows the unfiltered list instead.
 */
export async function searchPersonsPage(
  q: string,
  after: PersonCursor | null,
  limit = 50,
): Promise<PersonSearchPage | null> {
  const words = personQueryWords(q);
  if (words.length === 0) return null;
  const size = Math.max(1, Math.min(10_000, Math.floor(limit) || 50));
  const ids = await matchingPersonIds(words);
  const total = ids.size;
  if (total === 0) return { rows: [], next: null, total: 0 };

  // Few matches: read exactly those rows and order them in memory.
  if (total <= Math.max(size * 4, 200)) {
    const rows = ((await db.persons.bulkGet([...ids])) as Array<Indexed | undefined>)
      .filter(isLive)
      .sort(byNameThenId);
    let start = 0;
    if (after) {
      const probe = { _name: after.k, id: after.id } as Indexed;
      while (start < rows.length && byNameThenId(rows[start]!, probe) <= 0) start++;
    }
    const page = rows.slice(start, start + size);
    const last = page[page.length - 1];
    return {
      rows: page.map(plain),
      next: rows.length > start + size && last ? { k: last._name ?? '', id: last.id } : null,
      total,
    };
  }

  // Many matches: walk the name index (keys only) from the cursor and keep the matching ids;
  // size + 1 of them tell whether another page exists. Rows are read for the page alone.
  const picked: Array<[string, string]> = [];
  let lower: [string, string] | null = after ? [after.k, after.id] : null;
  for (;;) {
    const keys = (await db.persons
      .where('[_name+id]')
      // `[maxKey]` sorts after every `[name, id]` (see listPersons).
      .between(lower ?? [Dexie.minKey], [Dexie.maxKey], lower === null, true)
      .limit(WALK_BATCH)
      .keys()) as unknown as Array<[string, string]>;
    for (const key of keys) {
      if (ids.has(key[1])) picked.push(key);
      if (picked.length > size) break;
    }
    const last = keys[keys.length - 1];
    if (picked.length > size || keys.length < WALK_BATCH || !last) break;
    lower = [last[0], last[1]];
  }
  const pageKeys = picked.slice(0, size);
  const rows = (await db.persons.bulkGet(pageKeys.map((k) => k[1]))) as Array<Indexed | undefined>;
  const end = pageKeys[pageKeys.length - 1];
  return {
    rows: rows.filter(isLive).map(plain),
    next: picked.length > size && end ? { k: end[0], id: end[1] } : null,
    total,
  };
}

export async function personsByIds(ids: readonly string[]): Promise<Map<string, Person>> {
  const out = new Map<string, Person>();
  const rows = await db.persons.bulkGet([...new Set(ids)]);
  for (const r of rows) if (r && !r.deleted_at) out.set(r.id, plain(r));
  return out;
}

// ---------------------------------------------------------------------------------------
// Geography (home area, scope of a new person)
// ---------------------------------------------------------------------------------------

export async function listCountries(): Promise<Array<Row<'countries'>>> {
  const rows = await db.countries.toArray();
  return rows
    .filter((c) => c.active && !c.deleted_at)
    .sort((a, b) => a.name_en.localeCompare(b.name_en));
}

/** Areas of one level: level 1 by country, deeper levels by parent. */
export async function listAreas(
  countryId: string,
  parentId: string | null,
  level: 1 | 2 | 3,
): Promise<Area[]> {
  const rows =
    level === 1 || !parentId
      ? await db.admin_areas.where('[country_id+level]').equals([countryId, level]).toArray()
      : await db.admin_areas.where('parent_id').equals(parentId).toArray();
  return rows.filter((a) => !a.deleted_at);
}

export async function listBranches(): Promise<Array<Row<'branches'>>> {
  return (await db.branches.toArray()).filter((b) => b.active && !b.deleted_at);
}

/** Countries of a scope triple (country-scoped grants + the countries of branch grants). */
async function scopeCountryIds(scope: {
  all: boolean;
  countries: string[];
  branches: string[];
}): Promise<string[]> {
  const ids = new Set(scope.countries);
  if (scope.branches.length > 0) {
    for (const b of await db.branches.bulkGet(scope.branches)) if (b) ids.add(b.country_id);
  }
  return [...ids];
}

/**
 * Calling code offered as the phone prefix: the user's own country when the people/write
 * scope names exactly one, else the country of the device time zone, else none (the user
 * picks it or types "+…").
 */
export async function defaultDial(ctx: MyContext | null): Promise<string | null> {
  if (ctx) {
    const scope =
      ctx.scopes.write.all || ctx.scopes.write.countries.length || ctx.scopes.write.branches.length
        ? ctx.scopes.write
        : ctx.scopes.people;
    if (!scope.all) {
      const countries = await scopeCountryIds(scope);
      if (countries.length === 1) {
        const country = await db.countries.get(countries[0]!);
        const dial = dialForIso(country?.iso2);
        if (dial) return dial;
      }
    }
  }
  return dialFromTimeZone();
}

/** Calling code of the country an area belongs to. */
export async function dialOfArea(areaId: string | null | undefined): Promise<string | null> {
  if (!areaId) return null;
  const area = await db.admin_areas.get(areaId);
  if (!area) return null;
  return dialForIso((await db.countries.get(area.country_id))?.iso2);
}

/**
 * Where a new person belongs (`persons.country_id` / `branch_id` decide who sees it).
 * The server fills them itself only when the user's single write scope is one branch
 * (sync.md §4.2 rule 4); otherwise the user chooses among his write branches.
 */
export async function writableBranches(ctx: MyContext | null): Promise<Array<Row<'branches'>>> {
  if (!ctx) return [];
  const scope = ctx.scopes.write;
  const all = await listBranches();
  if (scope.all) return all;
  return all.filter((b) => scope.branches.includes(b.id) || scope.countries.includes(b.country_id));
}

/** True when the server can default the scope of a new person (one branch, nothing else). */
export function serverDefaultsScope(ctx: MyContext | null): boolean {
  const w = ctx?.scopes.write;
  return !!w && !w.all && w.countries.length === 0 && w.branches.length === 1;
}

// ---------------------------------------------------------------------------------------
// Merge requests (reviewers pull `person_merge_requests`)
// ---------------------------------------------------------------------------------------

const STATE_RANK: Record<MergeRequest['state'], number> = {
  pending: 0,
  merged: 1,
  rejected: 2,
  reverted: 3,
};

/** Pending first, then the decided ones; newest first inside each group. */
export async function listMergeRequests(limit = 200): Promise<MergeRequest[]> {
  const rows = (await db.person_merge_requests.toArray()).filter((r) => !r.deleted_at);
  rows.sort(
    (a, b) =>
      Number(a.state !== 'pending') - Number(b.state !== 'pending') ||
      (b.decided_at ?? b.created_at).localeCompare(a.decided_at ?? a.created_at) ||
      STATE_RANK[a.state] - STATE_RANK[b.state],
  );
  return rows.slice(0, limit).map(plain);
}

export async function mergeRequestsOf(personId: string): Promise<MergeRequest[]> {
  const [asSource, asTarget] = await Promise.all([
    db.person_merge_requests.where('source_person_id').equals(personId).toArray(),
    db.person_merge_requests.where('target_person_id').equals(personId).toArray(),
  ]);
  const byId = new Map<string, MergeRequest>();
  for (const r of [...asSource, ...asTarget]) if (!r.deleted_at) byId.set(r.id, plain(r));
  return [...byId.values()].sort((a, b) =>
    (b.decided_at ?? b.created_at).localeCompare(a.decided_at ?? a.created_at),
  );
}

export async function countPendingRequests(): Promise<number> {
  return db.person_merge_requests.where('state').equals('pending').count();
}

// ---------------------------------------------------------------------------------------
// Names of persons that left the device (merged duplicates)
// ---------------------------------------------------------------------------------------

export type PersonNames = { name_ar: string | null; name_latin: string | null };

/** Names seen in this session; the duplicate of a merge disappears from the device. */
const nameCache = new Map<string, PersonNames>();

export function rememberNames(rows: ReadonlyArray<{ id: string } & PersonNames>): void {
  for (const r of rows) nameCache.set(r.id, { name_ar: r.name_ar, name_latin: r.name_latin });
}

export function cachedNames(id: string): PersonNames | undefined {
  return nameCache.get(id);
}

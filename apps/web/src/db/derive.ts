/**
 * Local derived fields. They exist only in IndexedDB (names start with `_`), feed the
 * indexes of `dexie.ts`, and are recomputed on every local write and every pulled row.
 * They never travel to the server.
 */
import { completenessScore, type CompletenessChildren } from '../lib/completeness';
import { gridCell, isValidLonLat } from '../lib/geo';
import { db } from './dexie';
import { tokenize } from './tokens';
import { COMPLETENESS_CHILD_TABLES } from './tables';
import { OPEN_MAINTENANCE_STATES, type MaintenancePriority, type Row, type TableName } from './types';

// ---------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------

export interface ProjectDerived {
  /** Normalised search words: names, code, locality names. */
  _tokens: string[];
  /** Grid cell of the point (absent without coordinates). */
  _cell?: number;
  /** `[facet, name_ar, id]` — list sorted by name, one entry per facet the row belongs to. */
  _fn: Array<[string, string, string]>;
  /** `[facet, _u, id]` — list sorted by last change. */
  _fu: Array<[string, number, string]>;
  /** Sort key "updated": server `updated_at`, or the time of the last local edit (ms). */
  _u: number;
  /** Completeness shown locally: the server value, or the local estimate for unsynced work. */
  _cmp: number;
  /** 1 while the project has an open / in-progress maintenance entry. */
  _om?: 1;
  /** Admin area of the project followed by its ancestors. */
  _areas: string[];
  /** Photo used as thumbnail in lists: the cover, else the first photo. */
  _cover?: string | null;
  _cover_thumb?: string | null;
}

export type StoredProject = Row<'projects'> & Partial<ProjectDerived>;
export type StoredPerson = Row<'persons'> & { _tokens?: string[]; _name?: string };
export type StoredDonor = Row<'donors'> & { _tokens?: string[] };
export type StoredLocality = Row<'localities'> & { _tokens?: string[]; _cell?: number };
export type StoredMaintenance = Row<'project_maintenance'> & { _mk?: [number, number, string] };
export type StoredNotification = Row<'notifications'> & { _unread?: 1 };

// ---------------------------------------------------------------------------------------
// Facets: the single-filter dimensions of the project list
// ---------------------------------------------------------------------------------------

export const FACET_ALL = '*';
export const FACET_INCOMPLETE = 'i';
export const FACET_OPEN_MAINTENANCE = 'm';
export const facetOf = {
  type: (v: string): string => 't:' + v,
  status: (v: string): string => 's:' + v,
  recordState: (v: string): string => 'r:' + v,
  country: (id: string): string => 'c:' + id,
  branch: (id: string): string => 'b:' + id,
  area: (id: string): string => 'a:' + id,
  creator: (id: string): string => 'u:' + id,
  /** Incomplete AND created by the user: the per-user "incomplete records" list. */
  creatorIncomplete: (id: string): string => 'x:' + id,
};

export function projectFacets(p: StoredProject): string[] {
  const f = [FACET_ALL, facetOf.type(p.type), facetOf.status(p.status), facetOf.recordState(p.record_state)];
  if (p.country_id) f.push(facetOf.country(p.country_id));
  if (p.branch_id) f.push(facetOf.branch(p.branch_id));
  for (const a of p._areas ?? []) f.push(facetOf.area(a));
  if (p.created_by) f.push(facetOf.creator(p.created_by));
  const incomplete = (p._cmp ?? p.completeness ?? 0) < 100;
  if (incomplete) {
    f.push(FACET_INCOMPLETE);
    if (p.created_by) f.push(facetOf.creatorIncomplete(p.created_by));
  }
  if (p._om === 1) f.push(FACET_OPEN_MAINTENANCE);
  return f;
}

// ---------------------------------------------------------------------------------------
// Lookups (small reference rows, cached in memory)
// ---------------------------------------------------------------------------------------

const areaChains = new Map<string, string[]>();
const localityNames = new Map<string, { name_ar: string | null; name_latin: string | null }>();

/** Call after `admin_areas` / `localities` rows changed, after a reset and in tests. */
export function invalidateDeriveCaches(table?: 'admin_areas' | 'localities'): void {
  if (!table || table === 'admin_areas') areaChains.clear();
  if (!table || table === 'localities') localityNames.clear();
}

/** `[area, parent, grandparent]` from the local `admin_areas` rows. */
export async function areaChain(areaId: string | null | undefined): Promise<string[]> {
  if (!areaId) return [];
  const cached = areaChains.get(areaId);
  if (cached) return cached;
  const chain: string[] = [areaId];
  let complete = true;
  let current: string | null = areaId;
  for (let depth = 0; depth < 4 && current; depth++) {
    const row: Row<'admin_areas'> | undefined = await db.admin_areas.get(current);
    if (!row) {
      complete = false; // not pulled yet: do not cache a partial chain
      break;
    }
    current = row.parent_id;
    if (current && !chain.includes(current)) chain.push(current);
  }
  if (complete) areaChains.set(areaId, chain);
  return chain;
}

async function localityOf(
  id: string | null | undefined,
): Promise<{ name_ar: string | null; name_latin: string | null } | undefined> {
  if (!id) return undefined;
  const cached = localityNames.get(id);
  if (cached) return cached;
  const row = await db.localities.get(id);
  if (!row) return undefined;
  const names = { name_ar: row.name_ar, name_latin: row.name_latin };
  localityNames.set(id, names);
  return names;
}

// ---------------------------------------------------------------------------------------
// Per-table derivation
// ---------------------------------------------------------------------------------------

const PRIORITY_RANK: Record<MaintenancePriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

function parseMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function setCell(row: { lon?: number | null; lat?: number | null; _cell?: number }): void {
  if (isValidLonLat(row)) row._cell = gridCell(row);
  else delete row._cell;
}

/**
 * Fills the derived fields of a project in place. `_cmp`, `_om`, `_cover*` are inputs here
 * (the caller owns them); a dirty row keeps the `_u` given by the caller.
 */
export async function deriveProject(p: StoredProject): Promise<StoredProject> {
  const loc = await localityOf(p.locality_id);
  p._tokens = tokenize(p.name_ar, p.name_latin, p.code, loc?.name_ar, loc?.name_latin);
  p._areas = await areaChain(p.admin_area_id);
  setCell(p);
  if (!(p._dirty === 1 && typeof p._u === 'number')) p._u = parseMs(p.updated_at);
  if (typeof p._cmp !== 'number') p._cmp = p.completeness ?? 0;
  const facets = projectFacets(p);
  const name = p.name_ar ?? '';
  const u = p._u ?? 0;
  p._fn = facets.map((f) => [f, name, p.id]);
  p._fu = facets.map((f) => [f, u, p.id]);
  return p;
}

/** Adds / refreshes the derived fields of any row in place and returns it. */
export async function decorate<T extends TableName>(table: T, row: Row<T>): Promise<Row<T>> {
  switch (table) {
    case 'projects':
      await deriveProject(row as StoredProject);
      break;
    case 'localities': {
      const r = row as StoredLocality;
      r._tokens = tokenize(r.name_ar, r.name_latin);
      setCell(r);
      break;
    }
    case 'donors': {
      const r = row as StoredDonor;
      r._tokens = tokenize(r.name_ar, r.name_latin);
      break;
    }
    case 'persons': {
      const r = row as StoredPerson;
      r._tokens = tokenize(r.name_ar, r.name_latin);
      r._name = r.name_ar || r.name_latin || '';
      break;
    }
    case 'project_maintenance': {
      const r = row as StoredMaintenance;
      if (OPEN_MAINTENANCE_STATES.includes(r.state)) {
        const day = Math.floor(parseMs(r.reported_on) / 86400000);
        r._mk = [PRIORITY_RANK[r.priority] ?? 2, -day, r.id];
      } else {
        delete r._mk;
      }
      break;
    }
    case 'notifications': {
      const r = row as StoredNotification;
      if (r.read_at === null || r.read_at === undefined) r._unread = 1;
      else delete r._unread;
      break;
    }
    default:
      break;
  }
  return row;
}

/** A copy without local-only keys (`_…`): the row as it would travel on the wire. */
export function stripLocal<R extends object>(row: R): R {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!k.startsWith('_')) out[k] = v;
  }
  return out as R;
}

// ---------------------------------------------------------------------------------------
// Project state that depends on children
// ---------------------------------------------------------------------------------------

/** Which completeness-relevant children exist locally (index counts, no row reads). */
export async function completenessChildren(projectId: string): Promise<CompletenessChildren> {
  const counts = await Promise.all(
    COMPLETENESS_CHILD_TABLES.map((t) => db.table(t).where('project_id').equals(projectId).count()),
  );
  const has = (i: number): boolean => (counts[i] ?? 0) > 0;
  // order of COMPLETENESS_CHILD_TABLES: photos, land, facilities, staff, community
  return { photos: has(0), land: has(1), facilities: has(2), staff: has(3), community: has(4) };
}

async function hasOpenMaintenance(projectId: string): Promise<boolean> {
  const n = await db.project_maintenance
    .where('[project_id+state]')
    .anyOf(OPEN_MAINTENANCE_STATES.map((s) => [projectId, s]))
    .count();
  return n > 0;
}

async function coverOf(projectId: string): Promise<{ id: string; thumb: string } | null> {
  const photos = await db.project_photos.where('project_id').equals(projectId).toArray();
  if (photos.length === 0) return null;
  const cover =
    photos.find((ph) => ph.is_cover) ??
    photos.slice().sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))[0]!;
  return { id: cover.id, thumb: cover.storage_path_thumb };
}

export interface RefreshOptions {
  /** Recompute the completeness estimate from local rows (use for projects with unsynced work). */
  completeness?: boolean;
  maintenance?: boolean;
  cover?: boolean;
}

/**
 * Recomputes the child-dependent state of projects (open-maintenance flag, thumbnail,
 * completeness estimate) and rewrites the rows whose state changed. Must run inside a
 * transaction that includes the project stores (all write transactions do).
 */
export async function refreshProjects(projectIds: Iterable<string>, what: RefreshOptions): Promise<void> {
  for (const id of new Set(projectIds)) {
    const p = (await db.projects.get(id)) as StoredProject | undefined;
    if (!p) continue;
    let changed = false;
    if (what.maintenance) {
      const open = await hasOpenMaintenance(id);
      if (open !== (p._om === 1)) {
        if (open) p._om = 1;
        else delete p._om;
        changed = true;
      }
    }
    if (what.cover) {
      const cover = await coverOf(id);
      if ((p._cover ?? null) !== (cover?.id ?? null) || (p._cover_thumb ?? null) !== (cover?.thumb ?? null)) {
        p._cover = cover?.id ?? null;
        p._cover_thumb = cover?.thumb ?? null;
        changed = true;
      }
    }
    if (what.completeness) {
      const estimate = completenessScore(p, await completenessChildren(id));
      if (estimate !== p._cmp) {
        p._cmp = estimate;
        changed = true;
      }
    }
    if (changed) await db.projects.put(await deriveProject(p));
  }
}

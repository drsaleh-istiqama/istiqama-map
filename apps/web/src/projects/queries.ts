/**
 * Read-only queries of the projects module on top of the exported Dexie instance
 * (docs/contracts/web.md §5: feature modules never edit `src/db`). Every query is bounded:
 * index ranges, key-only reads, or one page of rows.
 */
import Dexie from 'dexie';
import {
  db,
  listFailedOps,
  loadProjectBundle,
  OPTION_LIST_KEYS,
  RESTRICTED_TABLES,
  type FailedOp,
  type ProjectBundle,
  type Row,
  type TableName,
} from '../db';
import { COMPLETENESS_WEIGHTS, completenessParts, type CompletenessKey } from '../lib/completeness';
import { norm } from '../lib/normalize';

// ---------------------------------------------------------------------------------------
// Reference data for filters and labels
// ---------------------------------------------------------------------------------------

export async function listCountries(): Promise<Array<Row<'countries'>>> {
  const rows = await db.countries.toArray();
  return rows.filter((c) => c.active !== false && !c.deleted_at);
}

export async function listBranches(countryId?: string): Promise<Array<Row<'branches'>>> {
  const rows = countryId
    ? await db.branches.where('country_id').equals(countryId).toArray()
    : await db.branches.toArray();
  return rows.filter((b) => b.active !== false && !b.deleted_at);
}

/** Level-1 areas of a country, or the direct children of an area. */
export async function listAreas(
  countryId: string,
  parentId?: string | null,
): Promise<Array<Row<'admin_areas'>>> {
  if (parentId) return db.admin_areas.where('parent_id').equals(parentId).toArray();
  return db.admin_areas.where('[country_id+level]').equals([countryId, 1]).toArray();
}

export async function getArea(id: string): Promise<Row<'admin_areas'> | undefined> {
  return db.admin_areas.get(id);
}

/** The area and its parents, level 1 first (at most three reads). */
export async function areaChain(areaId: string | null): Promise<Array<Row<'admin_areas'>>> {
  const chain: Array<Row<'admin_areas'>> = [];
  let id: string | null = areaId;
  for (let guard = 0; id && guard < 5; guard++) {
    const area: Row<'admin_areas'> | undefined = await db.admin_areas.get(id);
    if (!area) break;
    chain.unshift(area);
    id = area.parent_id;
  }
  return chain;
}

/** Number of projects on the device (the "of total" part of the counter). */
export function countAllProjects(): Promise<number> {
  return db.projects.count();
}

/** The USD value of one unit of `currency` in force on `onDate` (latest rate when none before). */
export async function fxRate(
  currency: string,
  onDate?: string | null,
): Promise<Row<'fx_rates'> | undefined> {
  if (currency === 'USD') return undefined;
  const upper = onDate && /^\d{4}-\d{2}-\d{2}$/.test(onDate) ? onDate : Dexie.maxKey;
  const before = await db.fx_rates
    .where('[currency+effective_date]')
    .between([currency, Dexie.minKey], [currency, upper], true, true)
    .last();
  if (before) return before;
  return db.fx_rates
    .where('[currency+effective_date]')
    .between([currency, Dexie.minKey], [currency, Dexie.maxKey], true, true)
    .first();
}

// ---------------------------------------------------------------------------------------
// Details card
// ---------------------------------------------------------------------------------------

export interface ProjectSyncState {
  /** Queued operations of the project and its children. */
  pendingOps: number;
  /** Rejected operations waiting for a decision ("needs attention"). */
  failedOps: number;
  /** Open field conflicts known on this device (reviewer devices). */
  openConflicts: number;
}

export interface ProjectDetails {
  bundle: ProjectBundle;
  country?: Row<'countries'>;
  branch?: Row<'branches'>;
  areas: Array<Row<'admin_areas'>>;
  locality?: Row<'localities'>;
  /** Option values referenced by the community profile, by id. */
  options: Map<string, Row<'option_values'>>;
  /** Rate per staff compensation id (restricted readers only). */
  fx: Map<string, Row<'fx_rates'>>;
  sync: ProjectSyncState;
}

const OPTION_KEYS = [
  'daawa_activities',
  'social_features',
  'livelihoods',
  'religious_issues',
  'religious_challenges',
  'social_challenges',
  'proposed_activities',
] as const;

export async function projectSyncState(projectId: string): Promise<ProjectSyncState> {
  const [pendingOps, failedOps, conflicts] = await Promise.all([
    db.outbox.where('project_id').equals(projectId).count(),
    db.failed_ops.where('project_id').equals(projectId).count(),
    db.sync_conflicts.where('project_id').equals(projectId).toArray(),
  ]);
  return {
    pendingOps,
    failedOps,
    openConflicts: conflicts.filter((c) => c.state === 'open').length,
  };
}

/**
 * Everything the details card shows, from local data only (brief §5: open in < 300 ms).
 * `undefined` when the project is not on this device.
 */
export async function loadProjectDetails(id: string): Promise<ProjectDetails | undefined> {
  const bundle = await loadProjectBundle(id);
  if (!bundle) return undefined;
  const p = bundle.project;
  const optionIds = new Set<string>();
  const community = bundle.community as
    (Record<string, unknown> & Row<'community_profiles'>) | undefined;
  if (community) {
    for (const key of OPTION_KEYS) {
      const ids = community[key];
      if (Array.isArray(ids))
        for (const oid of ids) if (typeof oid === 'string') optionIds.add(oid);
    }
  }
  const [country, branch, areas, locality, optionRows, sync] = await Promise.all([
    p.country_id ? db.countries.get(p.country_id) : Promise.resolve(undefined),
    p.branch_id ? db.branches.get(p.branch_id) : Promise.resolve(undefined),
    areaChain(p.admin_area_id),
    p.locality_id ? db.localities.get(p.locality_id) : Promise.resolve(undefined),
    optionIds.size > 0 ? db.option_values.bulkGet([...optionIds]) : Promise.resolve([]),
    projectSyncState(id),
  ]);
  const options = new Map<string, Row<'option_values'>>();
  for (const o of optionRows) if (o) options.set(o.id, o);
  const fx = new Map<string, Row<'fx_rates'>>();
  for (const s of bundle.staff) {
    const c = s.compensation;
    if (!c || c.currency === 'USD') continue;
    const rate = await fxRate(c.currency, c.effective_from);
    if (rate) fx.set(c.id, rate);
  }
  const details: ProjectDetails = { bundle, areas, options, fx, sync };
  if (country) details.country = country;
  if (branch) details.branch = branch;
  if (locality) details.locality = locality;
  return details;
}

// ---------------------------------------------------------------------------------------
// Cover thumbnail of a list row
// ---------------------------------------------------------------------------------------

/**
 * The cover photo row of a list item (`ProjectListItem.cover_photo_id`): one primary-key
 * read, so the thumbnail resolver knows whether the object is uploaded or only on this device.
 */
export async function coverPhoto(photoId: string): Promise<Row<'project_photos'> | undefined> {
  const row = await db.project_photos.get(photoId);
  return row && !row.deleted_at && !row.purged_at ? row : undefined;
}

// ---------------------------------------------------------------------------------------
// Maintenance badge
// ---------------------------------------------------------------------------------------

/** Open / in-progress maintenance entries on the device (sparse `_mk` index count, no rows). */
export function countOpenMaintenance(): Promise<number> {
  return db.project_maintenance.where('_mk').between([Dexie.minKey], [Dexie.maxKey]).count();
}

// ---------------------------------------------------------------------------------------
// Incomplete records: what is still missing
// ---------------------------------------------------------------------------------------

/** Children whose existence counts for completeness, by project (index keys only). */
async function projectsWith(
  table:
    | 'project_photos'
    | 'project_land'
    | 'project_facilities'
    | 'project_staff'
    | 'community_profiles',
  ids: string[],
): Promise<Set<string>> {
  const keys = (await db.table(table).where('project_id').anyOf(ids).keys()) as string[];
  return new Set(keys);
}

/** The missing completeness parts of each project, heaviest first. */
export async function missingParts(ids: string[]): Promise<Map<string, CompletenessKey[]>> {
  const out = new Map<string, CompletenessKey[]>();
  if (ids.length === 0) return out;
  const [projects, photos, land, facilities, staff, community] = await Promise.all([
    db.projects.bulkGet(ids),
    projectsWith('project_photos', ids),
    projectsWith('project_land', ids),
    projectsWith('project_facilities', ids),
    projectsWith('project_staff', ids),
    projectsWith('community_profiles', ids),
  ]);
  const order = (Object.keys(COMPLETENESS_WEIGHTS) as CompletenessKey[]).sort(
    (a, b) => COMPLETENESS_WEIGHTS[b] - COMPLETENESS_WEIGHTS[a],
  );
  ids.forEach((id, i) => {
    const p = projects[i];
    if (!p) return;
    const parts = completenessParts(p, {
      photos: photos.has(id),
      land: land.has(id),
      facilities: facilities.has(id),
      staff: staff.has(id),
      community: community.has(id),
    });
    out.set(
      id,
      order.filter((k) => !parts[k]),
    );
  });
  return out;
}

// ---------------------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------------------

export interface ProjectName {
  id: string;
  code: string | null;
  name_ar: string;
  name_latin: string | null;
  type: Row<'projects'>['type'];
}

export async function projectNames(ids: Array<string | null>): Promise<Map<string, ProjectName>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  const rows = wanted.length > 0 ? await db.projects.bulkGet(wanted) : [];
  const out = new Map<string, ProjectName>();
  for (const p of rows) {
    if (p)
      out.set(p.id, {
        id: p.id,
        code: p.code,
        name_ar: p.name_ar,
        name_latin: p.name_latin,
        type: p.type,
      });
  }
  return out;
}

/**
 * Open field conflicts pulled to this (reviewer) device, oldest first. Conflicts about the
 * restricted tables only for users with restricted access (the server sends them to nobody
 * else; this filter is a second line).
 */
export async function listOpenConflicts(
  seeRestricted: boolean,
): Promise<Array<Row<'sync_conflicts'>>> {
  const rows = await db.sync_conflicts.where('state').equals('open').toArray();
  const restricted = new Set<string>(RESTRICTED_TABLES as readonly string[]);
  return rows
    .filter((c) => !c.deleted_at && (seeRestricted || !restricted.has(c.table_name)))
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}

/** Anything `pickName()` can name (option values, areas, villages, people, donors…). */
export interface NamedRow {
  name_ar?: string | null;
  name_en?: string | null;
  name_sw?: string | null;
  name_latin?: string | null;
}

/** Columns whose value is the id of a row of another synced table. */
export const REFERENCE_COLUMNS = {
  country_id: 'countries',
  admin_area_id: 'admin_areas',
  home_admin_area_id: 'admin_areas',
  locality_id: 'localities',
  branch_id: 'branches',
  donor_id: 'donors',
  person_id: 'persons',
} as const satisfies Record<string, TableName>;

/** Table holding the rows a conflict value points to: option lists, references, or none. */
export function referenceTableOf(field: string): TableName | null {
  if ((OPTION_LIST_KEYS as readonly string[]).includes(field)) return 'option_values';
  return (REFERENCE_COLUMNS as Record<string, TableName>)[field] ?? null;
}

/**
 * The rows named by the values of these conflicts (option ids of the community lists,
 * people, donors, areas, villages…), by id — so the reviewer reads names, never ids.
 * One key lookup per referenced table.
 */
export async function conflictReferences(
  conflicts: ReadonlyArray<Pick<Row<'sync_conflicts'>, 'field' | 'server_value' | 'client_value'>>,
): Promise<Map<string, NamedRow>> {
  const wanted = new Map<TableName, Set<string>>();
  for (const c of conflicts) {
    const table = referenceTableOf(c.field);
    if (!table) continue;
    const ids = wanted.get(table) ?? new Set<string>();
    for (const value of [c.server_value, c.client_value]) {
      for (const id of Array.isArray(value) ? value : [value]) {
        if (typeof id === 'string' && id !== '') ids.add(id);
      }
    }
    wanted.set(table, ids);
  }
  const out = new Map<string, NamedRow>();
  await Promise.all(
    [...wanted].map(async ([table, ids]) => {
      if (ids.size === 0) return;
      const list = [...ids];
      const rows = (await db.table(table).bulkGet(list)) as Array<NamedRow | undefined>;
      rows.forEach((row, i) => {
        if (row) out.set(list[i]!, row);
      });
    }),
  );
  return out;
}

/** Remaining open conflicts of one row (to drop the row's conflict flag after the last one). */
export async function openConflictsOfRow(table: string, rowId: string): Promise<number> {
  const rows = await db.sync_conflicts
    .where('[table_name+row_id]')
    .equals([table, rowId])
    .toArray();
  return rows.filter((c) => c.state === 'open').length;
}

/**
 * Proposed localities waiting for a reviewer. `localities` has no `status` index, so this is
 * a bounded scan that stops after `limit` hits.
 */
export async function listProposedLocalities(limit = 200): Promise<Array<Row<'localities'>>> {
  return db.localities
    .filter((l) => l.status === 'proposed' && !l.deleted_at)
    .limit(limit)
    .toArray();
}

/** Approved localities of a country matching a name (merge target picker). */
export async function findLocalities(
  countryId: string,
  q: string,
  limit = 20,
): Promise<Array<Row<'localities'>>> {
  const needle = norm(q);
  if (needle.length < 2) return [];
  const words = needle.split(' ').filter(Boolean);
  const hits: Array<Row<'localities'>> = [];
  await db.localities
    .where('country_id')
    .equals(countryId)
    .until(() => hits.length >= limit)
    .each((l) => {
      if (l.status !== 'approved' || l.deleted_at) return;
      const hay = norm(`${l.name_ar ?? ''} ${l.name_latin ?? ''}`);
      if (words.every((w) => hay.includes(w))) hits.push(l);
    });
  return hits;
}

/** Ids of the projects that point to a locality (indexed). */
export async function projectsOfLocality(localityId: string): Promise<string[]> {
  return (await db.projects.where('locality_id').equals(localityId).primaryKeys()) as string[];
}

export interface FailedOpView {
  op: FailedOp;
  project?: ProjectName;
}

/** Rejected operations of this device with the project they belong to. */
export async function listFailedOpsWithContext(): Promise<FailedOpView[]> {
  const ops = await listFailedOps();
  const names = await projectNames(ops.map((o) => o.project_id));
  return ops.map((op) => {
    const project = op.project_id ? names.get(op.project_id) : undefined;
    return project ? { op, project } : { op };
  });
}

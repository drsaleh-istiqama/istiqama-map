/**
 * Read-only local queries the form needs that `src/db` does not offer (web.md §5: feature
 * queries live next to the feature, on top of the exported Dexie instance). Nothing here
 * writes.
 */
import { db, searchLocal, type FailedOp, type Row } from '../../db';
import { bboxAround, gridRangesForBBox, haversineMeters, type LonLat } from '../../lib/geo';
import { pickName } from '../../i18n';

const live = <T extends { deleted_at?: string | null }>(r: T | undefined): r is T =>
  !!r && (r.deleted_at === null || r.deleted_at === undefined);

const byName = <T extends Parameters<typeof pickName>[0]>(a: T, b: T): number =>
  pickName(a).localeCompare(pickName(b));

export async function listCountries(): Promise<Row<'countries'>[]> {
  const rows = (await db.countries.toArray()).filter((c) => live(c) && c.active !== false);
  return rows.sort(byName);
}

export async function getCountry(
  id: string | null | undefined,
): Promise<Row<'countries'> | undefined> {
  if (!id) return undefined;
  const row = await db.countries.get(id);
  return live(row) ? row : undefined;
}

export async function getBranch(
  id: string | null | undefined,
): Promise<Row<'branches'> | undefined> {
  if (!id) return undefined;
  const row = await db.branches.get(id);
  return live(row) ? row : undefined;
}

/** Areas of one level: level 1 of a country, deeper levels by parent. Sorted by name. */
export async function listAreas(
  countryId: string | null,
  level: 1 | 2 | 3,
  parentId: string | null,
): Promise<Row<'admin_areas'>[]> {
  if (!countryId) return [];
  let rows: Row<'admin_areas'>[];
  if (level === 1) {
    rows = await db.admin_areas.where('[country_id+level]').equals([countryId, 1]).toArray();
  } else {
    if (!parentId) return [];
    rows = await db.admin_areas.where('parent_id').equals(parentId).toArray();
  }
  return rows
    .filter((r) => live(r) && r.level === level && r.country_id === countryId)
    .sort(byName);
}

export async function getArea(
  id: string | null | undefined,
): Promise<Row<'admin_areas'> | undefined> {
  if (!id) return undefined;
  const row = await db.admin_areas.get(id);
  return live(row) ? row : undefined;
}

/** `[level 1, level 2, level 3]` ids of the chain that ends at `areaId` (missing levels null). */
export async function areaPathOf(
  areaId: string | null | undefined,
): Promise<[string | null, string | null, string | null]> {
  const path: [string | null, string | null, string | null] = [null, null, null];
  let current = await getArea(areaId);
  let guard = 0;
  while (current && guard++ < 4) {
    const level = current.level;
    if (level >= 1 && level <= 3) path[level - 1] = current.id;
    current = current.parent_id ? await getArea(current.parent_id) : undefined;
  }
  return path;
}

export interface LocalityChoice {
  id: string;
  name_ar: string | null;
  name_latin: string | null;
  status: Row<'localities'>['status'];
  admin_area_id: string | null;
  distance_m: number | null;
}

/**
 * Most rows one locality lookup reads from each index (brief §5 / §12.2: bounded, indexed reads
 * on 2 GB phones — never the whole country).
 */
export const LOCALITY_SCAN_LIMIT = 1000;

/**
 * Localities to offer for a project: approved and proposed localities of the country that lie
 * in one of `areaIds` or within `radiusM` of the point; nearest first, else by name.
 *
 * Two bounded index reads: `admin_area_id` for the chosen areas, and the `_cell` grid for the
 * box around the point (the same spatial index `findLocalDuplicates` uses).
 */
export async function listLocalities(opts: {
  countryId: string | null;
  areaIds: ReadonlyArray<string | null>;
  point: LonLat | null;
  radiusM?: number;
  limit?: number;
}): Promise<LocalityChoice[]> {
  if (!opts.countryId) return [];
  const radius = opts.radiusM ?? 10_000;
  const areas = new Set(opts.areaIds.filter((a): a is string => !!a));
  const found = new Map<string, Row<'localities'>>();
  if (areas.size > 0) {
    const inAreas = await db.localities
      .where('admin_area_id')
      .anyOf([...areas])
      .limit(LOCALITY_SCAN_LIMIT)
      .toArray();
    for (const r of inAreas) found.set(r.id, r);
  }
  const ranges = opts.point ? gridRangesForBBox(bboxAround(opts.point, radius)) : null;
  if (ranges) {
    const near = await db.localities
      .where('_cell')
      .inAnyRange(ranges, { includeLowers: true, includeUppers: true })
      .limit(LOCALITY_SCAN_LIMIT)
      .toArray();
    for (const r of near) found.set(r.id, r);
  }
  const out: LocalityChoice[] = [];
  for (const r of found.values()) {
    if (r.country_id !== opts.countryId) continue;
    if (!live(r)) continue;
    const distance =
      opts.point && typeof r.lon === 'number' && typeof r.lat === 'number'
        ? haversineMeters(opts.point, { lon: r.lon, lat: r.lat })
        : null;
    const inArea = r.admin_area_id !== null && areas.has(r.admin_area_id);
    if (!inArea && !(distance !== null && distance <= radius)) continue;
    out.push({
      id: r.id,
      name_ar: r.name_ar,
      name_latin: r.name_latin,
      status: r.status,
      admin_area_id: r.admin_area_id,
      distance_m: distance === null ? null : Math.round(distance),
    });
  }
  out.sort((a, b) =>
    a.distance_m !== null && b.distance_m !== null
      ? a.distance_m - b.distance_m
      : a.distance_m !== null
        ? -1
        : b.distance_m !== null
          ? 1
          : pickName(a).localeCompare(pickName(b)),
  );
  return out.slice(0, opts.limit ?? 50);
}

export async function getLocality(
  id: string | null | undefined,
): Promise<Row<'localities'> | undefined> {
  if (!id) return undefined;
  const row = await db.localities.get(id);
  return live(row) ? row : undefined;
}

/** Active options of one community list, in their configured order. */
export async function listOptions(listKey: string): Promise<Row<'option_values'>[]> {
  const rows = await db.option_values.where('list_key').equals(listKey).toArray();
  return rows
    .filter((r) => live(r) && r.active !== false)
    .sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code));
}

/** Option rows by id (also inactive ones, so a stored choice keeps its label). */
export async function getOptions(ids: readonly string[]): Promise<Row<'option_values'>[]> {
  if (ids.length === 0) return [];
  const rows = await db.option_values.bulkGet([...ids]);
  return rows.filter((r): r is Row<'option_values'> => !!r);
}

export interface DonorChoice {
  id: string;
  name_ar: string | null;
  name_latin: string | null;
}

/** Donors on the device matching `q` (local search index). */
export async function searchDonors(q: string, limit = 10): Promise<DonorChoice[]> {
  const hits = await searchLocal(q, limit, ['donor']);
  return hits
    .filter((h) => h.kind === 'donor')
    .map((h) => ({ id: h.id, name_ar: h.name_ar, name_latin: h.name_latin }));
}

export async function getDonor(id: string | null | undefined): Promise<Row<'donors'> | undefined> {
  if (!id) return undefined;
  const row = await db.donors.get(id);
  return live(row) ? row : undefined;
}

export async function getPerson(
  id: string | null | undefined,
): Promise<Row<'persons'> | undefined> {
  if (!id) return undefined;
  const row = await db.persons.get(id);
  return live(row) ? row : undefined;
}

/** Operations of this project the server rejected ("needs attention"). */
export async function failedOpsOfProject(projectId: string): Promise<FailedOp[]> {
  return db.failed_ops.where('project_id').equals(projectId).toArray();
}

/** True when a project row with this id is stored on the device (also a soft-deleted one). */
export async function projectStored(id: string): Promise<boolean> {
  return (await db.projects.get(id)) !== undefined;
}

/**
 * Ids (of `ids`) of projects the server has never stored: no code yet (the server assigns it)
 * and never acknowledged (version 0). Unknown ids are not reported.
 */
export async function localOnlyProjectIds(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.projects.bulkGet([...ids]);
  const out = new Set<string>();
  for (const r of rows) {
    if (r && !r.code && !((r.version ?? 0) > 0)) out.add(r.id);
  }
  return out;
}

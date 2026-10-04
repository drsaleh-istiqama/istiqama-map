/**
 * Read-only queries of the map module over the local database (docs/contracts/web.md §5:
 * feature queries live next to the feature, on top of the exported Dexie instance).
 */
import {
  db,
  listProjects,
  projectsInBounds,
  type ListCursor,
  type MapPackRow,
  type ProjectFilter,
  type ProjectListItem,
  type Row,
} from '../db';
import type { Feature, FeatureCollection, Point } from 'geojson';
import type { BBox } from '../lib/geo';

/** Properties of a project feature on the local layer (same names as the tile attributes). */
export interface LocalProjectProps {
  id: string;
  code: string | null;
  name_ar: string;
  name_latin: string | null;
  type: string;
  status: string;
  record_state: string;
  /** Saved on this device and not acknowledged by the server yet. */
  dirty: boolean;
}

type ProjectLike = Pick<
  ProjectListItem,
  'id' | 'code' | 'name_ar' | 'name_latin' | 'type' | 'status' | 'record_state' | 'lon' | 'lat'
> & { dirty?: boolean };

export function toFeature(p: ProjectLike): Feature<Point, LocalProjectProps> | null {
  if (typeof p.lon !== 'number' || typeof p.lat !== 'number') return null;
  return {
    type: 'Feature',
    id: p.id,
    properties: {
      id: p.id,
      code: p.code,
      name_ar: p.name_ar,
      name_latin: p.name_latin,
      type: p.type,
      status: p.status,
      record_state: p.record_state,
      dirty: Boolean(p.dirty),
    },
    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
  };
}

function matchesTileFilter(p: Row<'projects'>, filter: ProjectFilter): boolean {
  if (filter.type && p.type !== filter.type) return false;
  if (filter.status && p.status !== filter.status) return false;
  if (filter.recordState && p.record_state !== filter.recordState) return false;
  if (filter.countryId && p.country_id !== filter.countryId) return false;
  if (filter.branchId && p.branch_id !== filter.branchId) return false;
  return true;
}

/**
 * Projects created on this device that the server has not acknowledged yet (no code). The
 * server clusters cannot know them, so they are drawn at every zoom — a collector sees the
 * mosque she just entered offline on the map at once.
 */
export async function pendingNewProjects(
  filter: ProjectFilter,
  limit = 500,
): Promise<ProjectLike[]> {
  const rows = (await db.projects.where('_dirty').equals(1).limit(limit).toArray()) as Array<
    Row<'projects'> & { _dirty?: 1 }
  >;
  return rows
    .filter((p) => !p.code && !p.deleted_at && matchesTileFilter(p, filter))
    .map((p) => ({ ...p, dirty: true }));
}

/** Local projects in the viewport (z ≥ 14), for the local point layer. */
export async function localProjectsInView(
  bbox: BBox,
  filter: ProjectFilter,
  limit = 2000,
): Promise<ProjectListItem[]> {
  return projectsInBounds(bbox, filter, limit);
}

/** One FeatureCollection for the local layer, without duplicates. */
export function localCollection(
  inView: readonly ProjectLike[],
  pending: readonly ProjectLike[],
): FeatureCollection<Point, LocalProjectProps> {
  const seen = new Set<string>();
  const features: Array<Feature<Point, LocalProjectProps>> = [];
  for (const p of [...inView, ...pending]) {
    if (seen.has(p.id)) continue;
    const f = toFeature(p);
    if (!f) continue;
    seen.add(p.id);
    features.push(f);
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Bounding box of the projects matching a filter (v2 parity 1.5: fit the map to the filtered
 * projects). Read page by page from the local indexes and capped, so a broad filter on a
 * country manager's device never reads 100,000 rows at once.
 */
export async function boundsOfFilter(filter: ProjectFilter, cap = 5000): Promise<BBox | null> {
  let cursor: ListCursor | null = null;
  let seen = 0;
  let box: BBox | null = null;
  do {
    const page = await listProjects({ ...filter }, cursor, 200);
    for (const p of page.rows) {
      if (typeof p.lon !== 'number' || typeof p.lat !== 'number') continue;
      box = box
        ? [
            Math.min(box[0], p.lon),
            Math.min(box[1], p.lat),
            Math.max(box[2], p.lon),
            Math.max(box[3], p.lat),
          ]
        : [p.lon, p.lat, p.lon, p.lat];
    }
    seen += page.rows.length;
    cursor = page.next;
  } while (cursor && seen < cap);
  return box;
}

export interface ProjectSummary {
  id: string;
  code: string | null;
  name_ar: string;
  name_latin: string | null;
  type: string;
  status: string;
  record_state: string;
  capacity: number | null;
  lon: number | null;
  lat: number | null;
  area: Pick<Row<'admin_areas'>, 'name_ar' | 'name_en' | 'name_sw'> | null;
  dirty: boolean;
  /** False when the project is not on this device (summary built from the tile). */
  local: boolean;
}

/** Card shown when a project is tapped on the map (from local data, brief §5: < 300 ms). */
export async function projectSummary(id: string): Promise<ProjectSummary | null> {
  const p = (await db.projects.get(id)) as (Row<'projects'> & { _dirty?: 1 }) | undefined;
  if (!p || p.deleted_at) return null;
  const area = p.admin_area_id ? await db.admin_areas.get(p.admin_area_id) : undefined;
  return {
    id: p.id,
    code: p.code,
    name_ar: p.name_ar,
    name_latin: p.name_latin,
    type: p.type,
    status: p.status,
    record_state: p.record_state,
    capacity: p.capacity,
    lon: p.lon,
    lat: p.lat,
    area: area ? { name_ar: area.name_ar, name_en: area.name_en, name_sw: area.name_sw } : null,
    dirty: p._dirty === 1,
    local: true,
  };
}

/** Countries on the device (filter choices). */
export async function localCountries(): Promise<Array<Row<'countries'>>> {
  return (await db.countries.toArray()).filter((c) => !c.deleted_at && c.active);
}

/** Packs offered for download (synced `map_packs`, active only), by name. */
export async function availablePacks(): Promise<MapPackRow[]> {
  const rows = await db.map_packs.toArray();
  return rows
    .filter((r) => r.active && !r.deleted_at)
    .sort((a, b) => (a.name_ar < b.name_ar ? -1 : a.name_ar > b.name_ar ? 1 : 0));
}

/**
 * Areas → packs: finding the administrative area, its GeoJSON outline (the extract region) and
 * the `map_packs` row. Database access goes through a tiny query interface so the pure parts
 * are unit-tested.
 */
import type { PmtilesHeader } from './header.ts';

export interface AreaRow {
  id: string;
  country_id: string;
  iso2: string;
  level: number;
  code: string;
  short_code: string | null;
  parent_short_code: string | null;
  name_ar: string | null;
  name_en: string | null;
  name_sw: string | null;
  min_lon: number;
  min_lat: number;
  max_lon: number;
  max_lat: number;
}

export interface Queryable {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const AREA_COLUMNS = `
  a.id, a.country_id, c.iso2, a.level, a.code, a.short_code,
  p.short_code as parent_short_code, a.name_ar, a.name_en, a.name_sw,
  st_xmin(e.box) as min_lon, st_ymin(e.box) as min_lat,
  st_xmax(e.box) as max_lon, st_ymax(e.box) as max_lat`;

const AREA_FROM = `
  from public.admin_areas a
  join public.countries c on c.id = a.country_id
  left join public.admin_areas p on p.id = a.parent_id
  cross join lateral (select st_envelope(coalesce(a.geom_simple, a.geom))::box2d as box) e
  where a.deleted_at is null and coalesce(a.geom_simple, a.geom) is not null
    and c.iso2 = $1 and a.level between 1 and 2`;

/** Areas matching `value` (id, code, short code or a name, case-insensitive), best first. */
export async function findAreas(
  db: Queryable,
  iso2: string,
  value: string,
  level: number | null,
): Promise<AreaRow[]> {
  const { rows } = await db.query<AreaRow>(
    `select ${AREA_COLUMNS} ${AREA_FROM}
       and ($3::int is null or a.level = $3)
       and (a.id::text = $2 or lower(a.code) = lower($2) or lower(a.short_code) = lower($2)
            or lower(a.name_en) = lower($2) or a.name_ar = $2 or lower(a.name_sw) = lower($2))
     order by a.level, a.name_en`,
    [iso2, value, level],
  );
  return rows.map(numericBox);
}

export async function listAreas(
  db: Queryable,
  iso2: string,
  level: number | null,
): Promise<AreaRow[]> {
  const { rows } = await db.query<AreaRow>(
    `select ${AREA_COLUMNS} ${AREA_FROM}
       and ($2::int is null or a.level = $2)
     order by a.level, a.name_en`,
    [iso2, level],
  );
  return rows.map(numericBox);
}

/** The simplified outline (5 decimals, as `admin_area_shapes` serves it) as a GeoJSON Feature. */
export async function areaGeoJson(db: Queryable, areaId: string): Promise<string> {
  const { rows } = await db.query<{ geojson: string }>(
    `select json_build_object('type', 'Feature', 'properties', json_build_object(),
              'geometry', st_asgeojson(coalesce(geom_simple, geom), 5)::json)::text as geojson
       from public.admin_areas where id = $1`,
    [areaId],
  );
  const geojson = rows[0]?.geojson;
  if (!geojson) throw new Error(`area ${areaId} has no outline`);
  return geojson;
}

function numericBox(row: AreaRow): AreaRow {
  return {
    ...row,
    level: Number(row.level),
    min_lon: Number(row.min_lon),
    min_lat: Number(row.min_lat),
    max_lon: Number(row.max_lon),
    max_lat: Number(row.max_lat),
  };
}

function slug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase()
    .slice(0, 24);
}

/** `TZ-PN` for a level-1 area with a short code, `TZ-PN-WETE` for a district, else from the name. */
export function packCode(area: AreaRow): string {
  const iso = area.iso2.toUpperCase();
  if (area.level === 1 && area.short_code) return `${iso}-${area.short_code.toUpperCase()}`;
  const name = slug(area.name_en ?? area.code) || area.code.slice(0, 12);
  if (area.level === 2 && area.parent_short_code)
    return `${iso}-${area.parent_short_code.toUpperCase()}-${name}`;
  return `${iso}-${name}`;
}

/** Object name in the bucket `tiles`: `packs/<ISO2>/<code>.pmtiles`. */
export function packStoragePath(iso2: string, code: string): string {
  return `packs/${iso2.toUpperCase()}/${code}.pmtiles`;
}

export interface PackRowInput {
  area: AreaRow;
  code: string;
  storagePath: string;
  bytes: number;
  sha256: string;
  header: PmtilesHeader;
  tilesVersion: string | null;
}

export interface MapPackRowValues {
  code: string;
  name_ar: string;
  name_en: string | null;
  name_sw: string | null;
  country_id: string;
  admin_area_id: string;
  storage_path: string;
  bytes: number;
  min_zoom: number;
  max_zoom: number;
  min_lon: number;
  min_lat: number;
  max_lon: number;
  max_lat: number;
  tiles_version: string | null;
  sha256: string;
  active: boolean;
}

const round = (n: number): number => Math.round(n * 1e5) / 1e5;

/** The `map_packs` row of a built pack. `name_ar` is NOT NULL: falls back to the English name. */
export function mapPackRow(input: PackRowInput): MapPackRowValues {
  const { area, header } = input;
  return {
    code: input.code,
    name_ar: area.name_ar ?? area.name_en ?? area.name_sw ?? input.code,
    name_en: area.name_en,
    name_sw: area.name_sw ?? area.name_en,
    country_id: area.country_id,
    admin_area_id: area.id,
    storage_path: input.storagePath,
    bytes: input.bytes,
    min_zoom: header.minZoom,
    max_zoom: header.maxZoom,
    // The area's own box: what the device uses to decide whether a pack covers a tile.
    min_lon: round(area.min_lon),
    min_lat: round(area.min_lat),
    max_lon: round(area.max_lon),
    max_lat: round(area.max_lat),
    tiles_version: input.tilesVersion,
    sha256: input.sha256,
    active: true,
  };
}

/** Insert or update by `code` (sync_xid / version triggers publish the change to devices). */
export async function upsertMapPack(db: Queryable, row: MapPackRowValues): Promise<string> {
  const columns = Object.keys(row) as Array<keyof MapPackRowValues>;
  const values = columns.map((c) => row[c]);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const updates = columns
    .filter((c) => c !== 'code')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  const { rows } = await db.query<{ id: string }>(
    `insert into public.map_packs (${columns.join(', ')}) values (${placeholders})
     on conflict (code) do update set ${updates}, deleted_at = null
     returning id`,
    values,
  );
  return rows[0]!.id;
}

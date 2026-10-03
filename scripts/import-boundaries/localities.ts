/**
 * Imports the towns and villages of the v2 location tree (localities.v2.json) as approved
 * localities. Idempotent: ids are deterministic and existing rows are never overwritten.
 */
import fs from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { SCRIPT_DIR } from './cli.ts';
import type { CountryRow } from './load.ts';
import { nameKey } from './names.ts';
import { refUuid, v2LocalityKey } from './ref-uuid.ts';

interface AreaMatch {
  level: number;
  name: string;
}

interface V2Locality {
  key: string;
  name_ar: string;
  name_latin: string;
  lon: number | null;
  lat: number | null;
}

interface V2Region {
  key: string;
  region_ar: string;
  match: AreaMatch[];
  localities: V2Locality[];
}

interface LocalitiesFile {
  countries: Record<string, V2Region[]>;
}

export interface LocalitiesResult {
  inserted: number;
  /** Existing localities without an area that now received one. */
  attached: number;
  total: number;
  /** v2 regions (Arabic names) for which no administrative area was found. */
  unmatchedRegions: string[];
}

let cache: LocalitiesFile | null = null;

function loadFile(): LocalitiesFile {
  cache ??= JSON.parse(
    fs.readFileSync(path.join(SCRIPT_DIR, 'localities.v2.json'), 'utf8'),
  ) as LocalitiesFile;
  return cache;
}

export function hasV2Localities(iso2: string): boolean {
  return (loadFile().countries[iso2]?.length ?? 0) > 0;
}

/** Must run inside a transaction. */
export async function importV2Localities(
  client: pg.Client,
  country: CountryRow,
): Promise<LocalitiesResult> {
  const regions = loadFile().countries[country.iso2] ?? [];
  const result: LocalitiesResult = { inserted: 0, attached: 0, total: 0, unmatchedRegions: [] };
  if (regions.length === 0) return result;

  // Live areas of the levels the regions refer to, by level + normalised English/Swahili name.
  const levels = [...new Set(regions.flatMap((r) => r.match.map((m) => m.level)))];
  const { rows: areas } = await client.query<{
    id: string;
    level: number;
    name_en: string | null;
    name_sw: string | null;
  }>(
    `select a.id, a.level, a.name_en, a.name_sw
       from public.admin_areas a
      where a.country_id = $1::uuid and a.level = any ($2::smallint[]) and a.deleted_at is null`,
    [country.id, levels],
  );
  const byName = new Map<string, string | null>();
  for (const area of areas) {
    for (const name of new Set([area.name_en, area.name_sw])) {
      if (!name) continue;
      const key = `${area.level}|${nameKey(name)}`;
      // The same name twice on one level is ambiguous: such a name matches nothing.
      byName.set(key, byName.has(key) && byName.get(key) !== area.id ? null : area.id);
    }
  }

  const ids: string[] = [];
  const areaIds: (string | null)[] = [];
  const namesAr: string[] = [];
  const namesLatin: string[] = [];
  const lons: (number | null)[] = [];
  const lats: (number | null)[] = [];

  for (const region of regions) {
    let areaId: string | null = null;
    for (const candidate of region.match) {
      areaId = byName.get(`${candidate.level}|${nameKey(candidate.name)}`) ?? null;
      if (areaId !== null) break;
    }
    if (areaId === null) result.unmatchedRegions.push(region.region_ar);
    for (const locality of region.localities) {
      const located = locality.lon !== null && locality.lat !== null;
      ids.push(refUuid(v2LocalityKey(country.iso2, region.key, locality.key)));
      areaIds.push(areaId);
      namesAr.push(locality.name_ar);
      namesLatin.push(locality.name_latin);
      lons.push(located ? locality.lon : null);
      lats.push(located ? locality.lat : null);
    }
  }
  result.total = ids.length;

  // The localities trigger replaces admin_area_id by the deepest area containing the point
  // when there is one; the matched region is the fallback (decision D5).
  const inserted = await client.query(
    `insert into public.localities (id, country_id, admin_area_id, name_ar, name_latin, geom, status)
     select t.id, $1::uuid, t.area_id, t.name_ar, t.name_latin,
            case when t.lon is null or t.lat is null then null
                 else st_setsrid(st_makepoint(t.lon, t.lat), 4326) end,
            'approved'
       from unnest($2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::float8[], $7::float8[])
            as t (id, area_id, name_ar, name_latin, lon, lat)
      where not exists (select 1 from public.localities l where l.id = t.id)`,
    [country.id, ids, areaIds, namesAr, namesLatin, lons, lats],
  );
  result.inserted = inserted.rowCount ?? 0;

  const attached = await client.query(
    `update public.localities l
        set admin_area_id = t.area_id
       from unnest($1::uuid[], $2::uuid[]) as t (id, area_id)
      where l.id = t.id
        and l.deleted_at is null
        and l.admin_area_id is null
        and t.area_id is not null`,
    [ids, areaIds],
  );
  result.attached = attached.rowCount ?? 0;
  return result;
}

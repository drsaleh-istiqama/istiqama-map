/**
 * Database side of the boundary importer: staging, upsert into public.admin_areas, parent
 * links, retirement of superseded areas and re-derivation of the admin area of projects and
 * localities.
 *
 * Everything is state based (no bookkeeping tables), so an interrupted run is repaired by
 * simply running the importer again.
 */
import type pg from 'pg';
import type { RelocateMode } from './cli.ts';
import { adminAreaKey } from './ref-uuid.ts';

export interface CountryRow {
  id: string;
  iso2: string;
  iso3: string | null;
  name_en: string;
  active: boolean;
}

export interface PreparedFeature {
  code: string;
  nameEn: string;
  nameAr: string | null;
  nameSw: string | null;
  shortCode: string | null;
  geometry: string;
}

export interface LevelResult {
  features: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Features whose geometry was empty after ST_MakeValid. */
  dropped: number;
  /** Rows of the same country and level that are not in the file any more (soft-deleted). */
  retired: number;
}

/** Same tolerances (degrees) as the admin_areas trigger of migration 0007. */
const SIMPLIFY_TOLERANCE: Record<number, number> = { 1: 0.005, 2: 0.002, 3: 0.0005 };
const MAX_BATCH_ROWS = 200;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;

export async function prepareSession(client: pg.Client): Promise<void> {
  // PostGIS lives in schema "extensions" on Supabase; private holds ref_uuid().
  await client.query(`select set_config('search_path', 'public, extensions, private', false)`);
  await client.query(`set statement_timeout = 0`);
  await client.query(`set application_name = 'import-boundaries'`);
  await client.query(`
    create temp table if not exists _ib_stage (
      code       text primary key,
      name_en    text not null,
      name_ar    text,
      name_sw    text,
      short_code text,
      geom       geometry(MultiPolygon, 4326)
    )`);
}

/** Countries to import: the ones named on the command line, else every active country. */
export async function listCountries(client: pg.Client, wanted: string[]): Promise<CountryRow[]> {
  const { rows } = await client.query<CountryRow>(
    `select c.id, c.iso2::text as iso2, c.iso3::text as iso3, c.name_en, c.active
       from public.countries c
      where c.deleted_at is null
        and case when cardinality($1::text[]) = 0 then c.active
                 else c.iso3::text = any ($1::text[]) or c.iso2::text = any ($1::text[]) end
      order by c.iso2`,
    [wanted],
  );
  return rows;
}

/** short_code of the live level-1 areas of a country, by code. */
export async function existingShortCodes(
  client: pg.Client,
  countryId: string,
): Promise<Map<string, string>> {
  const { rows } = await client.query<{ code: string; short_code: string }>(
    `select a.code, a.short_code
       from public.admin_areas a
      where a.country_id = $1 and a.level = 1 and a.deleted_at is null and a.short_code is not null`,
    [countryId],
  );
  return new Map(rows.map((r) => [r.code, r.short_code]));
}

async function stage(client: pg.Client, features: PreparedFeature[]): Promise<number> {
  await client.query(`truncate _ib_stage`);
  let batch: PreparedFeature[] = [];
  let bytes = 0;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await client.query(
      `insert into _ib_stage (code, name_en, name_ar, name_sw, short_code, geom)
       select t.code, t.name_en, t.name_ar, t.name_sw, t.short_code,
              st_multi(st_collectionextract(st_makevalid(st_force2d(
                st_setsrid(st_geomfromgeojson(t.gj), 4326))), 3))
         from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
              as t (code, name_en, name_ar, name_sw, short_code, gj)`,
      [
        batch.map((f) => f.code),
        batch.map((f) => f.nameEn),
        batch.map((f) => f.nameAr),
        batch.map((f) => f.nameSw),
        batch.map((f) => f.shortCode),
        batch.map((f) => f.geometry),
      ],
    );
    batch = [];
    bytes = 0;
  };
  for (const feature of features) {
    batch.push(feature);
    bytes += feature.geometry.length;
    if (batch.length >= MAX_BATCH_ROWS || bytes >= MAX_BATCH_BYTES) await flush();
  }
  await flush();
  const dropped = await client.query(
    `delete from _ib_stage where geom is null or st_isempty(geom)`,
  );
  return dropped.rowCount ?? 0;
}

/**
 * Loads one level of one country. Must run inside a transaction.
 *
 * - upsert by (country_id, level, code); the id is private.ref_uuid('admin_area:<ISO3>:<level>:<code>')
 * - name_en and the shapes always follow the source; name_ar, name_sw and short_code are only
 *   filled where empty (so edits made in the admin screens survive), unless overwriteNames
 * - parent_id: the area one level up that contains ST_PointOnSurface of the shape
 * - rows that changed nothing are not written (no new version, no re-sync to devices)
 * - unless keepMissing, live rows of the same country and level that are not in the file are
 *   soft-deleted: a (country, level) set is replaced as a whole. This is what retires the
 *   fallback squares of the staging seed and the shapes of an older geoBoundaries release.
 */
export async function loadLevel(
  client: pg.Client,
  country: CountryRow,
  level: number,
  features: PreparedFeature[],
  opts: { overwriteNames: boolean; keepMissing: boolean; allowShrink: boolean },
): Promise<LevelResult> {
  const dropped = await stage(client, features);
  const idPrefix = adminAreaKey(country.iso3 ?? country.iso2, level, '');

  const upsert = await client.query<{ inserted: boolean }>(
    `insert into public.admin_areas as a
       (id, country_id, parent_id, level, code, short_code, name_ar, name_en, name_sw, geom, geom_simple)
     select private.ref_uuid($2::text || s.code), $1::uuid, par.id, $3::smallint, s.code,
            s.short_code, s.name_ar, s.name_en, s.name_sw, s.geom,
            case when simp.g is null or st_isempty(simp.g) then s.geom else simp.g end
       from _ib_stage s
      cross join lateral (
        select st_multi(st_collectionextract(st_makevalid(
                 st_simplifypreservetopology(s.geom, $4::float8)), 3)) as g
      ) simp
       left join lateral (
        select p.id
          from public.admin_areas p
         where $3::smallint > 1
           and p.country_id = $1::uuid
           and p.level = $3::smallint - 1
           and p.deleted_at is null
           and p.geom && st_pointonsurface(s.geom)
           and st_contains(p.geom, st_pointonsurface(s.geom))
         order by p.id
         limit 1
      ) par on true
     on conflict (country_id, level, code) do update
        set name_en     = excluded.name_en,
            name_ar     = case when $5::boolean then coalesce(excluded.name_ar, a.name_ar)
                               else coalesce(a.name_ar, excluded.name_ar) end,
            name_sw     = case when $5::boolean then coalesce(excluded.name_sw, a.name_sw)
                               else coalesce(a.name_sw, excluded.name_sw) end,
            short_code  = case when $5::boolean then coalesce(excluded.short_code, a.short_code)
                               else coalesce(a.short_code, excluded.short_code) end,
            parent_id   = coalesce(excluded.parent_id, a.parent_id),
            geom        = excluded.geom,
            geom_simple = excluded.geom_simple,
            deleted_at  = null
      where a.deleted_at is not null
         or a.name_en is distinct from excluded.name_en
         or (excluded.name_ar is not null
             and (a.name_ar is null or ($5::boolean and a.name_ar <> excluded.name_ar)))
         or (excluded.name_sw is not null
             and (a.name_sw is null or ($5::boolean and a.name_sw <> excluded.name_sw)))
         or (excluded.short_code is not null
             and (a.short_code is null or ($5::boolean and a.short_code <> excluded.short_code)))
         or (excluded.parent_id is not null and a.parent_id is distinct from excluded.parent_id)
         or a.geom is distinct from excluded.geom
         or a.geom_simple is distinct from excluded.geom_simple
     returning (a.xmax = 0) as inserted`,
    [country.id, idPrefix, level, SIMPLIFY_TOLERANCE[level] ?? 0.0005, opts.overwriteNames],
  );
  const inserted = upsert.rows.filter((r) => r.inserted).length;
  const updated = upsert.rows.length - inserted;

  let retired = 0;
  const staged = features.length - dropped;
  if (!opts.keepMissing && staged > 0) {
    // A truncated or wrong file must not wipe a level: refuse when it holds fewer than half
    // as many shapes as the areas it would retire.
    const { rows } = await client.query<{ n: number }>(
      `select count(*)::int as n
         from public.admin_areas a
        where a.country_id = $1::uuid
          and a.level = $2::smallint
          and a.deleted_at is null
          and not exists (select 1 from _ib_stage s where s.code = a.code)`,
      [country.id, level],
    );
    const leaving = rows[0]?.n ?? 0;
    if (!opts.allowShrink && staged * 2 < leaving) {
      throw new Error(
        `ADM${level}: the file has ${staged} shape(s) but would retire ${leaving} existing ` +
          `area(s); nothing was changed for this country (use --allow-shrink if this is intended)`,
      );
    }
    const res = await client.query(
      `update public.admin_areas a
          set deleted_at = now()
        where a.country_id = $1::uuid
          and a.level = $2::smallint
          and a.deleted_at is null
          and not exists (select 1 from _ib_stage s where s.code = a.code)`,
      [country.id, level],
    );
    retired = res.rowCount ?? 0;
  }

  return {
    features: features.length,
    inserted,
    updated,
    unchanged: features.length - dropped - inserted - updated,
    dropped,
    retired,
  };
}

/**
 * Gives every area of level 2-3 that has no (live) parent the area one level up that contains
 * its interior point, or else the nearest one. Covers levels imported out of order and parents
 * that were retired. Returns the number of rows changed.
 */
export async function linkParents(client: pg.Client, countryId: string): Promise<number> {
  const res = await client.query(
    `update public.admin_areas c
        set parent_id = x.parent_id
       from (
         select c2.id,
                coalesce(
                  (select p.id
                     from public.admin_areas p
                    where p.country_id = c2.country_id
                      and p.level = c2.level - 1
                      and p.deleted_at is null
                      and p.geom && pt.g
                      and st_contains(p.geom, pt.g)
                    order by p.id
                    limit 1),
                  (select p.id
                     from public.admin_areas p
                    where p.country_id = c2.country_id
                      and p.level = c2.level - 1
                      and p.deleted_at is null
                      and p.geom is not null
                    order by p.geom <-> pt.g, p.id
                    limit 1)
                ) as parent_id
           from public.admin_areas c2
          cross join lateral (select st_pointonsurface(c2.geom) as g) pt
          where c2.country_id = $1::uuid
            and c2.level > 1
            and c2.deleted_at is null
            and c2.geom is not null
            and (c2.parent_id is null
                 or exists (select 1 from public.admin_areas d
                             where d.id = c2.parent_id and d.deleted_at is not null))
       ) x
      where c.id = x.id
        and x.parent_id is not null
        and c.parent_id is distinct from x.parent_id`,
    [countryId],
  );
  return res.rowCount ?? 0;
}

export interface RelocateResult {
  projects: number;
  localities: number;
  persons: number;
  mapPacks: number;
  branches: number;
}

/**
 * The replacement of a retired area "dead": the live area of the same country and level with
 * the same English name, else the one containing its interior point.
 */
const REPLACEMENT = `
  select a.id
    from public.admin_areas a
   where a.country_id = dead.country_id
     and a.level = dead.level
     and a.deleted_at is null
     and (lower(a.name_en) = lower(dead.name_en)
          or (a.geom && st_pointonsurface(dead.geom)
              and st_contains(a.geom, st_pointonsurface(dead.geom))))
   order by (lower(a.name_en) = lower(dead.name_en)) desc, a.id
   limit 1`;

/** Same rule as the projects/localities triggers: the deepest live area containing the point. */
function relocateSql(table: 'projects' | 'localities'): string {
  return `
    with cand as (
      select q.id,
             hit.id as hit_area,
             hit.country_id as hit_country,
             dead.id is not null as was_dead,
             repl.id as mapped
        from public.${table} q
        left join public.admin_areas dead
               on dead.id = q.admin_area_id and dead.deleted_at is not null
        left join lateral (${REPLACEMENT}) repl on dead.id is not null
        left join lateral (
          select a.id, a.country_id
            from public.admin_areas a
           where q.geom is not null
             and a.deleted_at is null
             and a.geom && q.geom
             and st_contains(a.geom, q.geom)
           order by a.level desc, a.id
           limit 1
        ) hit on true
       where q.deleted_at is null
         and (dead.id is not null
              or ($1::text = 'missing' and q.admin_area_id is null and q.geom is not null)
              or ($1::text = 'all' and q.geom is not null))
    )
    update public.${table} t
       set admin_area_id = coalesce(c.hit_area, c.mapped),
           country_id = coalesce(c.hit_country, t.country_id)
      from cand c
     where t.id = c.id
       and (c.hit_area is not null or c.was_dead)
       and t.admin_area_id is distinct from coalesce(c.hit_area, c.mapped)`;
}

/**
 * Re-derives admin_area_id (and country_id) of projects and localities:
 *   always     rows that point at a retired (soft-deleted) area
 *   'missing'  + located rows without an area
 *   'all'      + every located row (use after loading deeper levels)
 * A row whose point lies in no polygon keeps its manually chosen area (decision D5).
 * Also re-points persons.home_admin_area_id, map_packs.admin_area_id and
 * branches.admin_area_ids away from retired areas.
 */
export async function relocate(client: pg.Client, mode: RelocateMode): Promise<RelocateResult> {
  const projects = await client.query(relocateSql('projects'), [mode]);
  const localities = await client.query(relocateSql('localities'), [mode]);

  const persons = await client.query(
    `update public.persons t
        set home_admin_area_id = x.new_id
       from (
         select dead.id as old_id, repl.id as new_id
           from public.admin_areas dead
           left join lateral (${REPLACEMENT}) repl on true
          where dead.deleted_at is not null
            and exists (select 1 from public.persons p where p.home_admin_area_id = dead.id)
       ) x
      where t.home_admin_area_id = x.old_id`,
  );
  const mapPacks = await client.query(
    `update public.map_packs t
        set admin_area_id = x.new_id
       from (
         select dead.id as old_id, repl.id as new_id
           from public.admin_areas dead
           left join lateral (${REPLACEMENT}) repl on true
          where dead.deleted_at is not null
            and exists (select 1 from public.map_packs m where m.admin_area_id = dead.id)
       ) x
      where t.admin_area_id = x.old_id`,
  );
  const branches = await client.query(
    `update public.branches b
        set admin_area_ids = coalesce((
              select array_agg(k.id order by k.ord)
                from (
                  select distinct on (coalesce(repl.id, u.id)) coalesce(repl.id, u.id) as id, u.ord
                    from unnest(b.admin_area_ids) with ordinality as u (id, ord)
                    left join public.admin_areas dead
                           on dead.id = u.id and dead.deleted_at is not null
                    left join lateral (${REPLACEMENT}) repl on dead.id is not null
                   where dead.id is null or repl.id is not null
                   order by coalesce(repl.id, u.id), u.ord
                ) k), '{}'::uuid[])
      where exists (
        select 1
          from unnest(b.admin_area_ids) as u (id)
          join public.admin_areas dead on dead.id = u.id and dead.deleted_at is not null)`,
  );

  return {
    projects: projects.rowCount ?? 0,
    localities: localities.rowCount ?? 0,
    persons: persons.rowCount ?? 0,
    mapPacks: mapPacks.rowCount ?? 0,
    branches: branches.rowCount ?? 0,
  };
}

export interface SourceInfo {
  release: string;
  variant: string;
  boundary_id: string | null;
  source: string | null;
  license: string | null;
  license_source: string | null;
  source_url: string | null;
  build_date: string | null;
  year_represented: string | null;
  features: number;
  imported_at: string;
}

export interface SourceRecord {
  level: number;
  info: SourceInfo;
  /** False when the import of that level wrote nothing. */
  changed: boolean;
}

/**
 * Records where the shapes of a country came from in app_settings 'boundaries.sources'
 * (public), so that the app can show the attribution the data licences require.
 * Shape: { "<ISO3>": { "ADM1": SourceInfo, "ADM2": …, "ADM3": … }, … }.
 */
export async function recordSources(
  client: pg.Client,
  iso3: string,
  records: SourceRecord[],
): Promise<void> {
  if (records.length === 0) return;
  const { rows } = await client.query<{ value: Record<string, Record<string, SourceInfo>> | null }>(
    `select value from public.app_settings where key = 'boundaries.sources' and deleted_at is null`,
  );
  const current = rows[0]?.value ?? {};
  const country: Record<string, SourceInfo> = { ...(current[iso3] ?? {}) };
  for (const { level, info, changed } of records) {
    const previous = country[`ADM${level}`];
    // Keep the earlier timestamp when nothing changed, so that a repeated import writes nothing.
    country[`ADM${level}`] =
      !changed && previous ? { ...info, imported_at: previous.imported_at } : info;
  }
  const next = { ...current, [iso3]: country };
  await client.query(
    `insert into public.app_settings as s (id, key, value, description, is_public)
     values (private.ref_uuid('setting:boundaries.sources'), 'boundaries.sources', $1::jsonb,
             'Source, licence and build date of the imported administrative boundaries per country and level (written by scripts/import-boundaries). Show it as map attribution.',
             true)
     on conflict (key) do update
        set value = excluded.value, deleted_at = null
      where s.value is distinct from excluded.value or s.deleted_at is not null`,
    [JSON.stringify(next)],
  );
}

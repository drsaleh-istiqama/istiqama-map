-- =============================================================================
-- 0031  locate_point + admin_area_shapes (brief §7.1–7.2, ARCHITECTURE §2.4)
--
-- Both functions return reference geography (official boundaries), which is not
-- scoped per country: the form must be able to tell a Kenyan collector that the
-- GPS fix lies in Tanzania. Localities, on the other hand, are user-entered and
-- are filtered to the countries the caller can read.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- locate_point(lon, lat)
--   {
--     "country":       {id, iso2, name_ar, name_en, name_sw, active} | null,
--     "admin_area_id": uuid | null,          -- deepest area containing the point
--     "areas":         [{id, level, code, parent_id, name_ar, name_en, name_sw}],   -- level 1..3, ascending
--     "localities":    [{id, name_ar, name_latin, status, admin_area_id, country_id,
--                        lon, lat, distance_m}]   -- <= 10 nearest within 10 km
--   }
-- -----------------------------------------------------------------------------
create or replace function public.locate_point(p_lon double precision, p_lat double precision)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  c_radius_m constant double precision := 10000;   -- nearby localities radius
  c_max_localities constant integer := 10;
  v_pt geometry(Point, 4326);
  v_all boolean;
  v_geo_countries uuid[];
  v_dx double precision;
  v_dy double precision;
  v_areas jsonb;
  v_country_id uuid;
  v_deepest uuid;
  v_country jsonb;
  v_localities jsonb;
begin
  if not private.session_ok() then
    raise exception 'session is not valid' using errcode = 'PT403';
  end if;

  -- NaN compares greater than every number, so it is rejected here as well.
  if p_lon is null or p_lat is null
     or p_lon < -180 or p_lon > 180 or p_lat < -90 or p_lat > 90 then
    raise exception 'invalid coordinates' using errcode = 'PT422';
  end if;

  v_pt := st_setsrid(st_makepoint(p_lon, p_lat), 4326);

  -- Administrative chain. The deepest polygon containing the point wins (same
  -- rule as the projects trigger); its ancestors come from parent_id so that
  -- the chain is always consistent, and levels without a parent link fall back
  -- to the polygon that contains the point at that level.
  with recursive hit as (
    select distinct on (aa.level)
           aa.id, aa.level, aa.parent_id, aa.country_id, aa.code,
           aa.name_ar, aa.name_en, aa.name_sw
    from public.admin_areas aa
    where aa.deleted_at is null
      and st_contains(aa.geom, v_pt)
    order by aa.level, aa.id
  ),
  chain as (
    select h.id, h.level, h.parent_id, h.country_id, h.code,
           h.name_ar, h.name_en, h.name_sw, 1 as depth
    from hit h
    where h.level = (select max(h2.level) from hit h2)
    union all
    select pa.id, pa.level, pa.parent_id, pa.country_id, pa.code,
           pa.name_ar, pa.name_en, pa.name_sw, c.depth + 1
    from chain c
    join public.admin_areas pa on pa.id = c.parent_id and pa.deleted_at is null
    where c.depth < 4
  ),
  merged as (
    select distinct on (m.level) m.*
    from (
      select c.id, c.level, c.parent_id, c.country_id, c.code,
             c.name_ar, c.name_en, c.name_sw, 0 as pref
      from chain c
      union all
      select h.id, h.level, h.parent_id, h.country_id, h.code,
             h.name_ar, h.name_en, h.name_sw, 1 as pref
      from hit h
    ) m
    order by m.level, m.pref
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id,
      'level', m.level,
      'code', m.code,
      'parent_id', m.parent_id,
      'name_ar', m.name_ar,
      'name_en', m.name_en,
      'name_sw', m.name_sw) order by m.level), '[]'::jsonb),
    (array_agg(m.country_id order by m.level desc))[1],
    (array_agg(m.id order by m.level desc))[1]
  into v_areas, v_country_id, v_deepest
  from merged m;

  if v_country_id is not null then
    select jsonb_build_object(
             'id', c.id,
             'iso2', c.iso2,
             'name_ar', c.name_ar,
             'name_en', c.name_en,
             'name_sw', c.name_sw,
             'active', c.active)
    into v_country
    from public.countries c
    where c.id = v_country_id
      and c.deleted_at is null;
  end if;

  -- Localities are scoped: global readers see all, others only the countries
  -- they can read (a branch role reads its branch's country).
  v_all := private.read_all();
  if not v_all then
    select coalesce(array_agg(distinct s.country_id), '{}'::uuid[])
    into v_geo_countries
    from (
      select unnest(private.read_countries()) as country_id
      union
      select b.country_id
      from public.branches b
      where b.id = any (private.read_branches())
    ) s
    where s.country_id is not null;
  end if;

  if v_all or cardinality(v_geo_countries) > 0 then
    -- Bounding box of the search radius in degrees (index pre-filter); the exact
    -- geodesic distance is checked afterwards.
    v_dy := c_radius_m / 111320.0;
    v_dx := v_dy / greatest(cos(radians(p_lat)), 0.01);

    select coalesce(jsonb_agg(jsonb_build_object(
             'id', n.id,
             'name_ar', n.name_ar,
             'name_latin', n.name_latin,
             'status', n.status,
             'admin_area_id', n.admin_area_id,
             'country_id', n.country_id,
             'lon', st_x(n.geom),
             'lat', st_y(n.geom),
             'distance_m', round(n.distance_m::numeric, 1)) order by n.distance_m, n.id), '[]'::jsonb)
    into v_localities
    from (
      select k.*
      from (
        select l.id, l.name_ar, l.name_latin, l.status, l.admin_area_id, l.country_id, l.geom,
               st_distance(l.geom::geography, v_pt::geography) as distance_m
        from (
          select l0.id, l0.name_ar, l0.name_latin, l0.status, l0.admin_area_id, l0.country_id, l0.geom
          from public.localities l0
          where l0.deleted_at is null
            and l0.geom && st_expand(v_pt, v_dx, v_dy)
            and (v_all or l0.country_id = any (v_geo_countries))
          order by l0.geom <-> v_pt
          limit 40
        ) l
      ) k
      where k.distance_m <= c_radius_m
      order by k.distance_m, k.id
      limit c_max_localities
    ) n;
  end if;

  return jsonb_build_object(
    'country', v_country,
    'admin_area_id', v_deepest,
    'areas', coalesce(v_areas, '[]'::jsonb),
    'localities', coalesce(v_localities, '[]'::jsonb));
end;
$$;

comment on function public.locate_point(double precision, double precision) is
  'Country + administrative chain (levels 1..3) containing a WGS84 point, plus the nearest localities within 10 km. Reference geography is not scope-filtered; localities are.';

-- -----------------------------------------------------------------------------
-- admin_area_shapes(country, level)
--   GeoJSON FeatureCollection of one level of one country for offline geofill.
--   Levels 1–2 carry the simplified geometry (5 decimals ~ 1 m); level 3 carries
--   names only ("geometry": null) because ward polygons are too heavy for 3G.
-- -----------------------------------------------------------------------------
create or replace function public.admin_area_shapes(p_country_id uuid, p_level integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_features jsonb;
begin
  if not private.session_ok() then
    raise exception 'session is not valid' using errcode = 'PT403';
  end if;

  if p_country_id is null or p_level is null or p_level < 1 or p_level > 3 then
    raise exception 'country and level (1..3) are required' using errcode = 'PT422';
  end if;

  select coalesce(jsonb_agg(f.feature order by f.sort_name, f.id), '[]'::jsonb)
  into v_features
  from (
    select
      a.id,
      coalesce(a.name_en, a.name_sw, a.name_ar, a.code) collate "C" as sort_name,
      jsonb_build_object(
        'type', 'Feature',
        'id', a.id,
        'geometry',
          case when p_level <= 2 then
            st_asgeojson(
              coalesce(a.geom_simple, st_multi(st_simplifypreservetopology(a.geom, 0.002))),
              5)::jsonb
          end,
        'properties', jsonb_build_object(
          'id', a.id,
          'parent_id', a.parent_id,
          'level', a.level,
          'code', a.code,
          'short_code', a.short_code,
          'name_ar', a.name_ar,
          'name_en', a.name_en,
          'name_sw', a.name_sw)) as feature
    from public.admin_areas a
    where a.country_id = p_country_id
      and a.level = p_level
      and a.deleted_at is null
  ) f;

  return jsonb_build_object('type', 'FeatureCollection', 'features', v_features);
end;
$$;

comment on function public.admin_area_shapes(uuid, integer) is
  'Simplified GeoJSON FeatureCollection of one administrative level of a country (geometry only for levels 1-2) for offline geofill on the device.';

-- -----------------------------------------------------------------------------
-- Privileges (Supabase grants EXECUTE on new public functions to anon by default)
-- -----------------------------------------------------------------------------
revoke execute on function public.locate_point(double precision, double precision) from public, anon;
revoke execute on function public.admin_area_shapes(uuid, integer) from public, anon;
grant execute on function public.locate_point(double precision, double precision) to authenticated, service_role;
grant execute on function public.admin_area_shapes(uuid, integer) to authenticated, service_role;

-- =============================================================================
-- 0036  tile_projects: Mapbox Vector Tiles for the project map (brief §5)
--
-- public.tile_projects(z, x, y, p_filters default '{}') -> bytea domain (MVT, extent 4096)
--
-- Layers
--   z < 14  "clusters": one point per grid cell (8 x 8 cells per tile) at the
--                       centroid of the visible projects of that cell.
--                       count, capacity, mosque, school, combined,
--                       st_active, st_maintenance, st_building, st_inactive,
--                       and for single-project cells: id, type, status.
--   z >= 14 "points":   one point per project.
--                       id, code, name_ar, name_latin, type, status, record_state, capacity.
--   all z   "needs":    heat-map weights, only where at least one weight is > 0.
--                       maintenance (open entries), quran_need, housing, transport
--                       (+ id on z >= 14).
--
-- p_filters (all optional): country_id, branch_id, type, status, record_state
--   (each a string or an array of strings) and layers (subset of
--   ["clusters","points","needs"]; default: all).
--
-- STABLE, so PostgREST accepts GET /rpc/tile_projects?z=..&x=..&y=.. (the `tiles`
-- Edge Function adds the cache headers; see docs/contracts/geo-search-tiles.md).
--
-- Raw binary over PostgREST: since PostgREST 12 a function is only served as raw
-- bytes when its return type is a domain named after the media type ("media type
-- handler"). The function therefore returns the domain
-- public."application/vnd.mapbox-vector-tile" (a plain bytea for SQL callers) and
-- HTTP callers send `Accept: application/vnd.mapbox-vector-tile`.
--
-- Security: SECURITY DEFINER. The cluster pyramid is a materialized view (no RLS),
-- therefore every row is filtered here by the caller's read scope; a caller
-- without any readable scope gets an empty tile.
-- =============================================================================

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_type t
    join pg_catalog.pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'application/vnd.mapbox-vector-tile'
  ) then
    create domain public."application/vnd.mapbox-vector-tile" as bytea;
  end if;
end
$$;

comment on domain public."application/vnd.mapbox-vector-tile" is
  'PostgREST media type handler: functions returning this domain are served as raw vector-tile bytes.';

create or replace function public.tile_projects(
  z integer,
  x integer,
  y integer,
  p_filters jsonb default '{}'::jsonb
)
returns public."application/vnd.mapbox-vector-tile"
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
-- Hot path: every statement below is driven by one index condition (pyramid key
-- or GiST box) whatever the filters are, so a cached generic plan is always the
-- right plan and nothing is re-planned per tile.
set plan_cache_mode = force_generic_plan
set max_parallel_workers_per_gather = 0
as $$
declare
  c_cluster_max_zoom constant integer := 13;   -- deepest zoom of the pyramid
  c_extent constant integer := 4096;
  -- Never reference the parameters z / x / y inside SQL below (they would clash
  -- with column names); use these copies.
  v_z integer := z;
  v_x integer := x;
  v_y integer := y;
  v_filters jsonb := case when jsonb_typeof(p_filters) = 'object' then p_filters else '{}'::jsonb end;
  v_all boolean;
  v_countries uuid[];
  v_branches uuid[];
  v_f_countries uuid[] := private.jsonb_text_array(v_filters -> 'country_id')::uuid[];
  v_f_branches uuid[] := private.jsonb_text_array(v_filters -> 'branch_id')::uuid[];
  v_types text[] := private.jsonb_text_array(v_filters -> 'type');
  v_statuses text[] := private.jsonb_text_array(v_filters -> 'status');
  v_states text[] := private.jsonb_text_array(v_filters -> 'record_state');
  v_layers text[] := private.jsonb_text_array(v_filters -> 'layers');
  v_want_main boolean;
  v_want_needs boolean;
  v_env geometry;
  v_env_4326 geometry;
  v_tile bytea;
begin
  if v_z is null or v_x is null or v_y is null
     or v_z < 0 or v_z > 22
     or v_x < 0 or v_y < 0
     or v_x >= (1 << v_z) or v_y >= (1 << v_z) then
    raise exception 'invalid tile coordinates' using errcode = 'PT422';
  end if;

  v_all := private.read_all();
  v_countries := private.read_countries();
  v_branches := private.read_branches();
  if not v_all and cardinality(v_countries) = 0 and cardinality(v_branches) = 0 then
    return ''::bytea;
  end if;

  v_want_needs := v_layers is null or 'needs' = any (v_layers);
  v_env := st_tileenvelope(v_z, v_x, v_y);

  if v_z <= c_cluster_max_zoom then
    -- ------------------------------------------------------------------------
    -- Clusters from the pyramid: merge the groups the caller may see per cell.
    -- ------------------------------------------------------------------------
    v_want_main := v_layers is null or 'clusters' = any (v_layers);

    with cells as materialized (
      select
        m.cx,
        m.cy,
        sum(m.n)::bigint as n,
        sum(m.capacity)::bigint as capacity,
        sum(m.sum_mx) / sum(m.n) as mx,
        sum(m.sum_my) / sum(m.n) as my,
        coalesce(sum(m.n) filter (where m.type = 'mosque'), 0)::bigint as mosque,
        coalesce(sum(m.n) filter (where m.type = 'school'), 0)::bigint as school,
        coalesce(sum(m.n) filter (where m.type = 'combined'), 0)::bigint as combined,
        coalesce(sum(m.n) filter (where m.status = 'active'), 0)::bigint as st_active,
        coalesce(sum(m.n) filter (where m.status = 'maintenance'), 0)::bigint as st_maintenance,
        coalesce(sum(m.n) filter (where m.status = 'building'), 0)::bigint as st_building,
        coalesce(sum(m.n) filter (where m.status = 'inactive'), 0)::bigint as st_inactive,
        sum(m.maint_open)::bigint as maint_open,
        sum(m.quran_need)::bigint as quran_need,
        sum(m.housing_gaps)::bigint as housing_gaps,
        sum(m.transport_needs)::bigint as transport_needs,
        max(m.single_id::text) as single_id,
        max(m.type) as single_type,
        max(m.status) as single_status
      from private.mv_project_clusters m
      where m.zoom = v_z
        and m.tx = v_x
        and m.ty = v_y
        and (v_all or m.country_id = any (v_countries) or m.branch_id = any (v_branches))
        and (v_f_countries is null or m.country_id = any (v_f_countries))
        and (v_f_branches is null or m.branch_id = any (v_f_branches))
        and (v_types is null or m.type = any (v_types))
        and (v_statuses is null or m.status = any (v_statuses))
        and (v_states is null or m.record_state = any (v_states))
      group by m.cx, m.cy
    ),
    feat as materialized (
      select
        c.*,
        ((c.cy::bigint << (v_z + 3)) | c.cx::bigint) as fid,
        st_asmvtgeom(st_setsrid(st_makepoint(c.mx, c.my), 3857), v_env, c_extent, 0, false) as geom
      from cells c
    )
    select
      case when v_want_main then
        coalesce((
          select st_asmvt(q, 'clusters', c_extent, 'geom', 'fid')
          from (
            select
              ft.fid,
              ft.geom,
              ft.n as count,
              ft.capacity,
              ft.mosque,
              ft.school,
              ft.combined,
              ft.st_active,
              ft.st_maintenance,
              ft.st_building,
              ft.st_inactive,
              case when ft.n = 1 then ft.single_id end as id,
              case when ft.n = 1 then ft.single_type end as type,
              case when ft.n = 1 then ft.single_status end as status
            from feat ft
            where ft.geom is not null
          ) q), ''::bytea)
      else ''::bytea end
      ||
      case when v_want_needs then
        coalesce((
          select st_asmvt(q, 'needs', c_extent, 'geom', 'fid')
          from (
            select
              ft.fid,
              ft.geom,
              ft.maint_open as maintenance,
              ft.quran_need,
              ft.housing_gaps as housing,
              ft.transport_needs as transport
            from feat ft
            where ft.geom is not null
              and (ft.maint_open > 0 or ft.quran_need > 0
                   or ft.housing_gaps > 0 or ft.transport_needs > 0)
          ) q), ''::bytea)
      else ''::bytea end
    into v_tile;
  else
    -- ------------------------------------------------------------------------
    -- Individual points straight from the projects table (live data).
    -- ------------------------------------------------------------------------
    v_want_main := v_layers is null or 'points' = any (v_layers);
    v_env_4326 := st_transform(v_env, 4326);

    with pts as materialized (
      select
        p.id,
        p.code,
        p.name_ar,
        p.name_latin,
        p.type,
        p.status,
        p.record_state,
        p.capacity,
        -- Clipped to the tile without buffer: every project is in exactly one tile.
        st_asmvtgeom(st_transform(p.geom, 3857), v_env, c_extent, 0, true) as geom
      from public.projects p
      where p.deleted_at is null
        and p.geom && v_env_4326
        and (v_all or p.country_id = any (v_countries) or p.branch_id = any (v_branches))
        and (v_f_countries is null or p.country_id = any (v_f_countries))
        and (v_f_branches is null or p.branch_id = any (v_f_branches))
        and (v_types is null or p.type = any (v_types))
        and (v_statuses is null or p.status = any (v_statuses))
        and (v_states is null or p.record_state = any (v_states))
    )
    select
      case when v_want_main then
        coalesce((
          select st_asmvt(q, 'points', c_extent, 'geom')
          from (
            select
              pt.geom,
              pt.id::text as id,
              pt.code,
              pt.name_ar,
              pt.name_latin,
              pt.type,
              pt.status,
              pt.record_state,
              pt.capacity
            from pts pt
            where pt.geom is not null
          ) q), ''::bytea)
      else ''::bytea end
      ||
      case when v_want_needs then
        coalesce((
          select st_asmvt(q, 'needs', c_extent, 'geom')
          from (
            select
              pt.geom,
              pt.id::text as id,
              coalesce(mo.open_count, 0) as maintenance,
              greatest(coalesce(f.quran_need, 0), 0) as quran_need,
              ((f.teacher_housing is false)::int + (f.imam_housing is false)::int) as housing,
              (f.student_transport is not distinct from 'needed')::int as transport
            from pts pt
            left join public.project_facilities f
              on f.project_id = pt.id and f.deleted_at is null
            left join lateral (
              select count(*)::int as open_count
              from public.project_maintenance m
              where m.project_id = pt.id
                and m.deleted_at is null
                and m.state in ('open', 'in_progress')
            ) mo on true
            where pt.geom is not null
              and (coalesce(mo.open_count, 0) > 0
                   or coalesce(f.quran_need, 0) > 0
                   or f.teacher_housing is false
                   or f.imam_housing is false
                   or f.student_transport is not distinct from 'needed')
          ) q), ''::bytea)
      else ''::bytea end
    into v_tile;
  end if;

  return coalesce(v_tile, ''::bytea);
end;
$$;

comment on function public.tile_projects(integer, integer, integer, jsonb) is
  'Scope-filtered MVT tile of projects: layers "clusters" (z<14, from the cluster pyramid), "points" (z>=14, live) and "needs" (heat-map weights).';

revoke execute on function public.tile_projects(integer, integer, integer, jsonb) from public, anon;
grant execute on function public.tile_projects(integer, integer, integer, jsonb) to authenticated, service_role;

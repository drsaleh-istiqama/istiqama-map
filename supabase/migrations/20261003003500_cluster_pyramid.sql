-- =============================================================================
-- 0035  Cluster pyramid for server-side map clustering (brief §5: "vector tiles
--       via ST_AsMVT with clustering done inside the server")
--
-- private.mv_project_clusters holds, for every zoom 0..13, one row per
--   (grid cell, country, branch, type, status, record_state)
-- with the project count, capacity sum, sum of Web-Mercator coordinates (so the
-- centroid of any merge of groups is sum/count) and the need aggregates used by
-- the heat maps. tile_projects() (0036) merges the groups a caller may see.
--
-- Grid: at zoom Z a cell is a tile of zoom Z+3, i.e. every map tile is split
-- into 8 x 8 cells (64 px on a 512 px tile). (tx, ty) is the map tile the cell
-- belongs to, (cx, cy) the cell itself.
--
-- Grouping keys are never NULL (missing country / branch -> nil UUID, missing
-- type / status / record_state -> 'unspecified') so that the UNIQUE index covers
-- every row and the view can be refreshed CONCURRENTLY (readers never block).
--
-- Materialized views have no row level security: the view lives in `private`
-- (not exposed), nobody but the owner can select from it, and tile_projects()
-- applies the caller's read scope on country_id / branch_id.
-- =============================================================================

create materialized view if not exists private.mv_project_clusters as
with base as materialized (
  -- One row per live, located project. MATERIALIZED so that the position maths
  -- runs once per project and not once per project and zoom level.
  select
    p.id,
    coalesce(p.country_id, '00000000-0000-0000-0000-000000000000'::uuid) as country_id,
    coalesce(p.branch_id, '00000000-0000-0000-0000-000000000000'::uuid) as branch_id,
    coalesce(p.type, 'unspecified')::text as type,
    coalesce(p.status, 'unspecified')::text as status,
    coalesce(p.record_state, 'unspecified')::text as record_state,
    coalesce(p.capacity, 0)::bigint as capacity,
    -- Spherical (Web) Mercator position as a fraction of the world square:
    -- fx 0..1 from the west edge, fy 0..1 from the north edge. Plain arithmetic
    -- (identical to EPSG:3857) instead of ST_Transform: ~100x cheaper per row.
    least(greatest((extensions.st_x(p.geom) + 180.0) / 360.0, 0), 0.999999999999) as fx,
    least(greatest(
      (1.0 - ln(tan(radians(extensions.st_y(p.geom)))
                + 1.0 / cos(radians(extensions.st_y(p.geom)))) / pi()) / 2.0,
      0), 0.999999999999) as fy,
    coalesce(mo.open_count, 0)::bigint as maint_open,
    greatest(coalesce(f.quran_need, 0), 0)::bigint as quran_need,
    ((f.teacher_housing is false)::int + (f.imam_housing is false)::int)::bigint as housing_gaps,
    (f.student_transport is not distinct from 'needed')::int::bigint as transport_needs
  from public.projects p
  left join public.project_facilities f
    on f.project_id = p.id and f.deleted_at is null
  left join (
    select m.project_id, count(*) as open_count
    from public.project_maintenance m
    where m.deleted_at is null
      and m.state in ('open', 'in_progress')
    group by m.project_id
  ) mo on mo.project_id = p.id
  where p.deleted_at is null
    and p.geom is not null
    and extensions.st_x(p.geom) between -180 and 180
    and extensions.st_y(p.geom) between -85.0511 and 85.0511
)
select
  zs.zoom::smallint as zoom,
  (floor(b.fx * (1 << zs.zoom)))::integer as tx,
  (floor(b.fy * (1 << zs.zoom)))::integer as ty,
  (floor(b.fx * (1 << (zs.zoom + 3))))::integer as cx,
  (floor(b.fy * (1 << (zs.zoom + 3))))::integer as cy,
  b.country_id,
  b.branch_id,
  b.type,
  b.status,
  b.record_state,
  count(*)::bigint as n,
  sum(b.capacity)::bigint as capacity,
  -- EPSG:3857 metres (world width 40075016.685578488 m), summed for the centroid.
  sum((b.fx - 0.5) * 40075016.685578488)::double precision as sum_mx,
  sum((0.5 - b.fy) * 40075016.685578488)::double precision as sum_my,
  sum(b.maint_open)::bigint as maint_open,
  (count(*) filter (where b.maint_open > 0))::bigint as maint_projects,
  sum(b.quran_need)::bigint as quran_need,
  sum(b.housing_gaps)::bigint as housing_gaps,
  sum(b.transport_needs)::bigint as transport_needs,
  -- Lets the map open the project card directly when a "cluster" is one project.
  case when count(*) = 1 then (min(b.id::text))::uuid end as single_id
from base b
cross join generate_series(0, 13) as zs(zoom)
group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
with data;

comment on materialized view private.mv_project_clusters is
  'Cluster pyramid (zoom 0..13, 8x8 cells per tile) grouped by country/branch/type/status/record_state; refreshed by private.refresh_clusters(). Read only through public.tile_projects().';

-- UNIQUE on plain columns (required by REFRESH ... CONCURRENTLY); leading
-- (zoom, tx, ty) makes it the lookup index of a tile request as well.
create unique index if not exists mv_project_clusters_key
  on private.mv_project_clusters (zoom, tx, ty, cx, cy, country_id, branch_id, type, status, record_state);

revoke all on private.mv_project_clusters from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Refresh. Called by public.refresh_reports() every 15 minutes (pg_cron in
-- production, gateway timer locally) and by seed / load-data scripts after bulk
-- loads. CONCURRENTLY keeps tile requests running during the refresh.
-- -----------------------------------------------------------------------------
create or replace function private.refresh_clusters()
returns void
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  if (select c.relispopulated
      from pg_catalog.pg_class c
      where c.oid = 'private.mv_project_clusters'::regclass) then
    refresh materialized view concurrently private.mv_project_clusters;
  else
    refresh materialized view private.mv_project_clusters;
  end if;
end;
$$;

comment on function private.refresh_clusters() is
  'Rebuilds the map cluster pyramid (private.mv_project_clusters) without blocking readers.';

revoke execute on function private.refresh_clusters() from public, anon, authenticated;
grant execute on function private.refresh_clusters() to service_role;

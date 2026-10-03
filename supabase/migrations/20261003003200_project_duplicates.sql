-- =============================================================================
-- 0032  project_duplicates (brief §7.3: duplicate detection before saving)
--
-- A candidate is reported when, inside the caller's read scope,
--   * "nearby":       a project of the same type lies within 150 m of the point
--                     (`combined` overlaps with both `mosque` and `school`), or
--   * "similar_name": a project in the same locality (or, when no locality is
--                     chosen, in the same level-3 area that contains the point)
--                     has a trigram similarity >= 0.6 on the normalised Arabic
--                     or Latin name.
-- The function never merges anything; the user decides ("same project, open it
-- for editing" or "different project").
--
-- Result: jsonb array (max 20), best candidates first:
--   [{ id, code, name_ar, name_latin, type, status, record_state, lon, lat,
--      locality_id, admin_area_id, created_by_me,
--      distance_m (number|null), similarity (number|null),
--      reason: "nearby" | "similar_name" | "both" }]
-- =============================================================================

create or replace function public.project_duplicates(
  p_type text,
  p_lon double precision,
  p_lat double precision,
  p_name text,
  p_locality_id uuid,
  p_exclude_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
-- Planned for the actual arguments: the "same locality or same village" rule and
-- the scope test then fold into plain index conditions.
set plan_cache_mode = force_custom_plan
set max_parallel_workers_per_gather = 0
as $$
declare
  c_radius_m constant double precision := 150;
  c_min_similarity constant real := 0.6;
  c_max_results constant integer := 20;
  v_uid uuid := auth.uid();
  v_all boolean := private.read_all();
  v_countries uuid[] := private.read_countries();
  v_branches uuid[] := private.read_branches();
  v_name text := nullif(btrim(private.norm(coalesce(p_name, ''))), '');
  v_pt geometry(Point, 4326);
  v_box geometry;
  v_dx double precision;
  v_dy double precision;
  v_area3 uuid;
  v_result jsonb;
begin
  if p_type is not null and p_type not in ('mosque', 'school', 'combined') then
    raise exception 'invalid project type' using errcode = 'PT422';
  end if;

  if (p_lon is null) <> (p_lat is null)
     or p_lon < -180 or p_lon > 180 or p_lat < -90 or p_lat > 90 then
    raise exception 'invalid coordinates' using errcode = 'PT422';
  end if;

  -- No readable scope (no role, revoked session, ...): nothing can be a duplicate.
  if not v_all and cardinality(v_countries) = 0 and cardinality(v_branches) = 0 then
    return '[]'::jsonb;
  end if;

  if p_lon is not null then
    v_pt := st_setsrid(st_makepoint(p_lon, p_lat), 4326);
    -- Degree box slightly larger than the radius: GiST pre-filter on projects.geom;
    -- the exact geodesic test follows.
    v_dy := (c_radius_m * 1.05) / 111320.0;
    v_dx := v_dy / greatest(cos(radians(p_lat)), 0.01);
    v_box := st_expand(v_pt, v_dx, v_dy);

    -- "Same village" fallback for the name rule when no locality was picked.
    if v_name is not null and p_locality_id is null then
      select aa.id
      into v_area3
      from public.admin_areas aa
      where aa.deleted_at is null
        and aa.level = 3
        and st_contains(aa.geom, v_pt)
      order by aa.id
      limit 1;
    end if;
  end if;

  with near as (
    select p.id,
           st_distance(p.geom::geography, v_pt::geography) as distance_m
    from public.projects p
    where v_pt is not null
      and p_type is not null
      and p.deleted_at is null
      and p.geom && v_box
      and (p.type = p_type or p.type = 'combined' or p_type = 'combined')
      and (p_exclude_id is null or p.id <> p_exclude_id)
      and (v_all or p.country_id = any (v_countries) or p.branch_id = any (v_branches))
      and st_dwithin(p.geom::geography, v_pt::geography, c_radius_m)
  ),
  named as (
    select s.id
    from (
      select p.id,
             greatest(
               similarity(private.norm(coalesce(p.name_ar, '')), v_name),
               similarity(private.norm(coalesce(p.name_latin, '')), v_name)) as sim
      from public.projects p
      where v_name is not null
        and p.deleted_at is null
        and ((p_locality_id is not null and p.locality_id = p_locality_id)
             or (v_area3 is not null and p.admin_area_id = v_area3))
        and (p_exclude_id is null or p.id <> p_exclude_id)
        and (v_all or p.country_id = any (v_countries) or p.branch_id = any (v_branches))
    ) s
    where s.sim >= c_min_similarity
  ),
  hits as (
    select coalesce(n.id, m.id) as id,
           n.distance_m,
           (n.id is not null) as is_near,
           (m.id is not null) as is_named
    from near n
    full join named m on m.id = n.id
  ),
  detail as (
    select p.id, p.code, p.name_ar, p.name_latin, p.type, p.status, p.record_state,
           p.locality_id, p.admin_area_id, p.geom, p.created_by,
           h.is_near, h.is_named,
           coalesce(h.distance_m,
                    case when v_pt is not null and p.geom is not null
                         then st_distance(p.geom::geography, v_pt::geography) end) as distance_m,
           case when v_name is not null then
             greatest(
               similarity(private.norm(coalesce(p.name_ar, '')), v_name),
               similarity(private.norm(coalesce(p.name_latin, '')), v_name))
           end as sim
    from hits h
    join public.projects p on p.id = h.id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id,
           'code', d.code,
           'name_ar', d.name_ar,
           'name_latin', d.name_latin,
           'type', d.type,
           'status', d.status,
           'record_state', d.record_state,
           'lon', st_x(d.geom),
           'lat', st_y(d.geom),
           'locality_id', d.locality_id,
           'admin_area_id', d.admin_area_id,
           'created_by_me', (d.created_by is not null and d.created_by = v_uid),
           'distance_m', round(d.distance_m::numeric, 1),
           'similarity', round(d.sim::numeric, 3),
           'reason', case when d.is_near and d.is_named then 'both'
                          when d.is_near then 'nearby'
                          else 'similar_name' end)
           order by d.ord), '[]'::jsonb)
  into v_result
  from (
    select d0.*,
           row_number() over (
             order by (d0.is_near and d0.is_named) desc,
                      d0.is_near desc,
                      d0.distance_m nulls last,
                      d0.sim desc nulls last,
                      d0.id) as ord
    from detail d0
  ) d
  where d.ord <= c_max_results;

  return v_result;
end;
$$;

comment on function public.project_duplicates(text, double precision, double precision, text, uuid, uuid) is
  'Possible duplicates of a project being entered: same type within 150 m, or similar name (trigram >= 0.6) in the same locality / village; limited to the caller''s read scope.';

revoke execute on function
  public.project_duplicates(text, double precision, double precision, text, uuid, uuid)
from public, anon;
grant execute on function
  public.project_duplicates(text, double precision, double precision, text, uuid, uuid)
to authenticated, service_role;

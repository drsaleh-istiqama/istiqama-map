-- =============================================================================
-- 0034  projects_page (brief §5: lists are fetched in pages of 50 ordered by a
--       keyset cursor, never by OFFSET; ARCHITECTURE §2.4)
--
-- public.projects_page(p_filters jsonb, p_after jsonb, p_limit int default 50) -> jsonb
--   { "rows": [...], "next": <cursor> | null, "total": <int> }   -- "total" only on the first page
--
-- p_filters (every key optional):
--   sort                  "name" (default: name_ar, id) | "updated" (updated_at desc, id desc)
--   country_id, branch_id uuid
--   admin_area_id         uuid of any level; descendants are included
--   locality_id, donor_id uuid
--   type, status, record_state   string or array of strings
--   q                     text; every word must occur in the project's search text
--                         (Arabic/Latin names + code), same normalisation as search()
--   incomplete            true -> completeness < 100
--   created_by_me         true -> rows created by the caller
--   has_open_maintenance  true -> at least one open / in-progress maintenance entry
--
-- p_after: null for the first page, afterwards the "next" value of the previous
-- page (opaque to the client; it carries the sort key and id of the last row).
--
-- rows: { id, code, name_ar, name_latin, type, status, record_state, completeness,
--         capacity, lon, lat, country_id, branch_id, admin_area_id, locality_id,
--         area_level, area_name_ar, area_name_en, area_name_sw,
--         locality_name_ar, locality_name_latin, cover_thumb, updated_at, version }
--
-- The WHERE clause is assembled from fixed fragments for the filters that are
-- actually present (all values are bound parameters, nothing user-supplied is
-- concatenated), so the planner always sees the smallest possible query and the
-- keyset index (projects_page_name_idx / projects_page_updated_idx) stays usable.
-- =============================================================================

create or replace function public.projects_page(
  p_filters jsonb,
  p_after jsonb,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
-- Interactive lookups: never pay for starting parallel workers.
set max_parallel_workers_per_gather = 0
as $$
declare
  c_max_limit constant integer := 200;
  c_max_tokens constant integer := 6;
  f jsonb := case when jsonb_typeof(p_filters) = 'object' then p_filters else '{}'::jsonb end;
  v_after jsonb := case when jsonb_typeof(p_after) = 'object' then p_after end;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), c_max_limit);
  c_rate_per_minute constant integer := 300;
  v_uid uuid := auth.uid();
  v_sort text := coalesce(nullif(f ->> 'sort', ''), 'name');
  v_all boolean;
  v_countries uuid[];
  v_branches uuid[];
  v_p_all boolean;
  v_p_countries uuid[];
  v_p_branches uuid[];
  v_rev_all boolean;
  v_country uuid := nullif(f ->> 'country_id', '')::uuid;
  v_branch uuid := nullif(f ->> 'branch_id', '')::uuid;
  v_area uuid := nullif(f ->> 'admin_area_id', '')::uuid;
  v_locality uuid := nullif(f ->> 'locality_id', '')::uuid;
  v_donor uuid := nullif(f ->> 'donor_id', '')::uuid;
  v_types text[] := private.jsonb_text_array(f -> 'type');
  v_statuses text[] := private.jsonb_text_array(f -> 'status');
  v_states text[] := private.jsonb_text_array(f -> 'record_state');
  v_incomplete boolean := coalesce((f ->> 'incomplete')::boolean, false);
  v_mine boolean := coalesce((f ->> 'created_by_me')::boolean, false);
  v_open_maint boolean := coalesce((f ->> 'has_open_maintenance')::boolean, false);
  v_q text := nullif(btrim(coalesce(private.norm(f ->> 'q'), '')), '');
  v_area_ids uuid[];
  v_main text;
  v_p1 text;
  v_pats text[];
  v_after_id uuid;
  v_after_name text;
  v_after_ts timestamptz;
  v_where text;
  v_sql text;
  v_ids uuid[];
  v_last_name text;
  v_last_ts timestamptz;
  v_more boolean := false;
  v_total bigint;
  v_rows jsonb;
  v_next jsonb;
begin
  perform private.rate_limit('projects_page', c_rate_per_minute, interval '1 minute');

  if v_sort not in ('name', 'updated') then
    raise exception 'invalid sort' using errcode = 'PT422';
  end if;

  v_all := private.read_all();
  v_countries := private.read_countries();
  v_branches := private.read_branches();
  if not v_all and cardinality(v_countries) = 0 and cardinality(v_branches) = 0 then
    return jsonb_build_object('rows', '[]'::jsonb, 'next', null, 'total', 0);
  end if;
  -- Unreviewed records (migration 0013, owner decision ح): outside the people
  -- scope (i.e. where the caller reads as a viewer only) approved projects only.
  v_p_all := private.people_all();
  v_p_countries := private.people_countries();
  v_p_branches := private.people_branches();
  v_rev_all := v_p_all
    or (not v_all and v_countries <@ v_p_countries and v_branches <@ v_p_branches);

  -- Cursor of the previous page.
  if v_after is not null then
    if coalesce(v_after ->> 's', '') <> v_sort or (v_after ->> 'id') is null then
      raise exception 'cursor does not belong to this sort order' using errcode = 'PT422';
    end if;
    v_after_id := (v_after ->> 'id')::uuid;
    if v_sort = 'name' then
      v_after_name := coalesce(v_after ->> 'k', '');
    else
      v_after_ts := (v_after ->> 'k')::timestamptz;
      if v_after_ts is null then
        raise exception 'cursor does not belong to this sort order' using errcode = 'PT422';
      end if;
    end if;
  end if;

  -- admin_area_id of any level: the area itself plus all its descendants
  -- (UNION, not UNION ALL, so a broken parent cycle cannot loop forever).
  if v_area is not null then
    with recursive tree as (
      select a.id from public.admin_areas a where a.id = v_area
      union
      select c.id
      from public.admin_areas c
      join tree t on c.parent_id = t.id
      where c.deleted_at is null
    )
    select array_agg(t.id) into v_area_ids from tree t;
  end if;

  -- Text filter: every word must occur; the longest word drives the trigram index.
  if v_q is not null then
    select array_agg('%' || private.like_escape(t.tok) || '%' order by t.ord),
           (array_agg(t.tok order by char_length(t.tok) desc, t.ord))[1]
    into v_pats, v_main
    from (
      select w.tok, w.ord
      from unnest(string_to_array(v_q, ' ')) with ordinality as w(tok, ord)
      where w.tok <> ''
      order by w.ord
      limit c_max_tokens
    ) t;
    v_p1 := '%' || private.like_escape(v_main) || '%';
  end if;

  -- Parameters (fixed positions):
  --   $1 countries  $2 branches  $3 country  $4 branch  $5 area ids  $6 types
  --   $7 statuses   $8 states    $9 like pattern  $10 like patterns  $11 uid
  --   $12 donor     $13 locality $14 after name   $15 after ts       $16 after id
  --   $17 limit     $18 people countries          $19 people branches
  v_where := 'p.deleted_at is null';
  if not v_all then
    -- Only the non-empty id lists are mentioned: a plain index condition for the
    -- usual "one branch" / "one country" caller.
    v_where := v_where || case
      when cardinality(v_branches) = 0 then ' and p.country_id = any ($1)'
      when cardinality(v_countries) = 0 then ' and p.branch_id = any ($2)'
      else ' and (p.country_id = any ($1) or p.branch_id = any ($2))' end;
  end if;
  if not v_rev_all then
    v_where := v_where || case
      when cardinality(v_p_countries) = 0 and cardinality(v_p_branches) = 0
        then ' and p.record_state = ''approved'''
      else ' and (p.record_state = ''approved'' or p.country_id = any ($18) or p.branch_id = any ($19))' end;
  end if;
  if v_country is not null then
    v_where := v_where || ' and p.country_id = $3';
  end if;
  if v_branch is not null then
    v_where := v_where || ' and p.branch_id = $4';
  end if;
  if v_area is not null then
    v_where := v_where || ' and p.admin_area_id = any ($5)';
  end if;
  if v_types is not null then
    v_where := v_where || ' and p.type = any ($6)';
  end if;
  if v_statuses is not null then
    v_where := v_where || ' and p.status = any ($7)';
  end if;
  if v_states is not null then
    v_where := v_where || ' and p.record_state = any ($8)';
  end if;
  if v_q is not null then
    v_where := v_where || ' and p.search_norm like $9 and p.search_norm like all ($10)';
  end if;
  if v_incomplete then
    v_where := v_where || ' and p.completeness < 100';
  end if;
  if v_mine then
    v_where := v_where || ' and p.created_by = $11';
  end if;
  if v_open_maint then
    v_where := v_where
      || ' and exists (select 1 from public.project_maintenance m'
      || ' where m.project_id = p.id and m.deleted_at is null'
      || ' and m.state in (''open'', ''in_progress''))';
  end if;
  if v_donor is not null then
    v_where := v_where
      || ' and exists (select 1 from public.project_donors pd'
      || ' where pd.donor_id = $12 and pd.project_id = p.id and pd.deleted_at is null)';
  end if;
  if v_locality is not null then
    v_where := v_where || ' and p.locality_id = $13';
  end if;

  -- One extra row tells whether another page exists.
  if v_sort = 'name' then
    v_sql :=
      'select array_agg(s.id order by s.k, s.id), (array_agg(s.k order by s.k, s.id))[$17]'
      || ' from (select p.id, p.name_ar collate "C" as k'
      || ' from public.projects p where ' || v_where
      || case when v_after_id is not null
           then ' and (p.name_ar collate "C", p.id) > ($14 collate "C", $16)'
           else '' end
      || ' order by p.name_ar collate "C", p.id limit $17 + 1) s';
    execute v_sql
      into v_ids, v_last_name
      using v_countries, v_branches, v_country, v_branch, v_area_ids, v_types,
            v_statuses, v_states, v_p1, v_pats, v_uid,
            v_donor, v_locality, v_after_name, v_after_ts, v_after_id,
            v_limit, v_p_countries, v_p_branches;
  else
    v_sql :=
      'select array_agg(s.id order by s.k desc, s.id desc), (array_agg(s.k order by s.k desc, s.id desc))[$17]'
      || ' from (select p.id, p.updated_at as k'
      || ' from public.projects p where ' || v_where
      || case when v_after_id is not null
           then ' and (p.updated_at, p.id) < ($15, $16)'
           else '' end
      || ' order by p.updated_at desc, p.id desc limit $17 + 1) s';
    execute v_sql
      into v_ids, v_last_ts
      using v_countries, v_branches, v_country, v_branch, v_area_ids, v_types,
            v_statuses, v_states, v_p1, v_pats, v_uid,
            v_donor, v_locality, v_after_name, v_after_ts, v_after_id,
            v_limit, v_p_countries, v_p_branches;
  end if;

  v_ids := coalesce(v_ids, '{}'::uuid[]);
  if cardinality(v_ids) > v_limit then
    v_more := true;
    v_ids := v_ids[1:v_limit];
  end if;

  if v_more then
    v_next := jsonb_build_object(
      's', v_sort,
      'k', case when v_sort = 'name' then to_jsonb(v_last_name) else to_jsonb(v_last_ts::text) end,
      'id', v_ids[v_limit]);
  end if;

  -- Total for the "showing N of M" counter: first page only.
  if v_after is null then
    execute 'select count(*) from public.projects p where ' || v_where
      into v_total
      using v_countries, v_branches, v_country, v_branch, v_area_ids, v_types,
            v_statuses, v_states, v_p1, v_pats, v_uid,
            v_donor, v_locality, v_after_name, v_after_ts, v_after_id,
            v_limit, v_p_countries, v_p_branches;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id,
           'code', p.code,
           'name_ar', p.name_ar,
           'name_latin', p.name_latin,
           'type', p.type,
           'status', p.status,
           'record_state', p.record_state,
           'completeness', p.completeness,
           'capacity', p.capacity,
           'lon', st_x(p.geom),
           'lat', st_y(p.geom),
           'country_id', p.country_id,
           'branch_id', p.branch_id,
           'admin_area_id', p.admin_area_id,
           'locality_id', p.locality_id,
           'area_level', a.level,
           'area_name_ar', a.name_ar,
           'area_name_en', a.name_en,
           'area_name_sw', a.name_sw,
           'locality_name_ar', l.name_ar,
           'locality_name_latin', l.name_latin,
           'cover_thumb', c.storage_path_thumb,
           'updated_at', p.updated_at,
           'version', p.version) order by u.ord), '[]'::jsonb)
  into v_rows
  from unnest(v_ids) with ordinality as u(id, ord)
  join public.projects p on p.id = u.id
  left join public.admin_areas a on a.id = p.admin_area_id
  left join public.localities l on l.id = p.locality_id and l.deleted_at is null
  left join lateral (
    select ph.storage_path_thumb
    from public.project_photos ph
    where ph.project_id = p.id
      and ph.deleted_at is null
      and ph.purged_at is null
      and ph.upload_state = 'uploaded'
      and ph.storage_path_thumb is not null
    order by ph.is_cover desc nulls last, ph.created_at, ph.id
    limit 1
  ) c on true;

  if v_after is null then
    return jsonb_build_object('rows', v_rows, 'next', v_next, 'total', v_total);
  end if;
  return jsonb_build_object('rows', v_rows, 'next', v_next);
end;
$$;

comment on function public.projects_page(jsonb, jsonb, integer) is
  'Keyset-paged, scope-filtered project list (light rows). Filters and sort travel in p_filters; p_after is the "next" cursor of the previous page.';

revoke execute on function public.projects_page(jsonb, jsonb, integer) from public, anon;
grant execute on function public.projects_page(jsonb, jsonb, integer) to authenticated, service_role;

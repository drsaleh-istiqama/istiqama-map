-- Asynchronous server-side export (brief §9).
--
-- Flow (the `export` Edge Function drives it; the file itself is built there):
--   1. client      export_request(format, lang, filters)      -> job (state queued)
--   2. function    export_columns(lang)  [caller's JWT]       -> ordered columns + enum labels
--   3. function    export_rows(job, after, limit) [caller's JWT], repeated until done
--   4. function    export_finish(job, 'done'|'failed', ...) [service role] -> notification
--
-- Visibility is always the CALLER's: export_rows returns only projects inside the caller's
-- read scope; people columns and restricted columns exist only for callers who may see them
-- (omitted otherwise, never null-filled). Every page that contains restricted data is written
-- to restricted_access_log.

-- ---------------------------------------------------------------------------------------------
-- export_columns(p_lang)
-- ---------------------------------------------------------------------------------------------

create or replace function public.export_columns(p_lang text default 'ar')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_lang text := coalesce(nullif(btrim(p_lang), ''), 'ar');
  v_people boolean;
  v_restricted boolean;
  v_columns jsonb;
  v_enums jsonb;
begin
  perform private.require_session();   -- PT401 no user, PT403 session_revoked
  if v_lang not in ('ar', 'sw', 'en') then
    raise exception 'unsupported language: %', v_lang using errcode = 'PT422';
  end if;

  v_people := private.people_all()
              or cardinality(private.people_countries()) > 0
              or cardinality(private.people_branches()) > 0;
  v_restricted := private.restricted_all() or cardinality(private.restricted_countries()) > 0;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'key', d.key,
             'header', case v_lang when 'ar' then d.ar when 'sw' then d.sw else d.en end,
             'kind', d.kind,
             'enum', d.enum_key))
           order by d.position), '[]'::jsonb)
    into v_columns
  from private.export_column_defs d
  where d.capability = 'all'
     or (d.capability = 'people' and v_people)
     or (d.capability = 'restricted' and v_restricted);

  select coalesce(jsonb_object_agg(e.enum_key, e.labels), '{}'::jsonb)
    into v_enums
  from (
    select l.enum_key,
           jsonb_object_agg(l.code, case v_lang when 'ar' then l.ar when 'sw' then l.sw else l.en end) as labels
    from private.enum_labels l
    group by l.enum_key
  ) e;

  return jsonb_build_object(
    'lang', v_lang,
    'dir', case when v_lang = 'ar' then 'rtl' else 'ltr' end,
    'list_separator', ' | ',
    'capabilities', jsonb_build_object('people', v_people, 'restricted', v_restricted),
    'columns', v_columns,
    'enums', v_enums);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- export_request(p_format, p_lang, p_filters)
-- ---------------------------------------------------------------------------------------------

create or replace function public.export_request(
  p_format text,
  p_lang text default 'ar',
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_format text := lower(coalesce(btrim(p_format), ''));
  v_lang text := coalesce(nullif(btrim(p_lang), ''), 'ar');
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_active integer;
  v_job public.export_jobs%rowtype;
begin
  perform private.require_session();   -- PT401 no user, PT403 session_revoked
  if v_format not in ('csv', 'xlsx') then
    raise exception 'unsupported export format: %', v_format using errcode = 'PT422';
  end if;
  if v_lang not in ('ar', 'sw', 'en') then
    raise exception 'unsupported language: %', v_lang using errcode = 'PT422';
  end if;
  if jsonb_typeof(v_filters) <> 'object' then
    raise exception 'filters must be a JSON object' using errcode = 'PT422';
  end if;
  if not private.read_all()
     and cardinality(private.read_countries()) = 0
     and cardinality(private.read_branches()) = 0 then
    raise exception 'no read access' using errcode = 'PT403';
  end if;

  perform private.rate_limit('export_request', 20, interval '1 hour');

  select count(*) into v_active
  from public.export_jobs j
  where j.user_id = v_uid and j.deleted_at is null and j.state in ('queued', 'running')
    and j.created_at > now() - interval '1 day';
  if v_active >= 3 then
    raise exception 'too many exports in progress' using errcode = 'PT429';
  end if;

  insert into public.export_jobs (user_id, format, lang, filters, state)
  values (v_uid, v_format, v_lang, v_filters, 'queued')
  returning * into v_job;

  return to_jsonb(v_job) - 'deleted_at';
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- export_cancel(p_job_id): the owner gives up a queued / running job
-- ---------------------------------------------------------------------------------------------

create or replace function public.export_cancel(p_job_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_job public.export_jobs%rowtype;
begin
  -- an "own rows" RPC that uses no scope helper: the session gate is the only check
  perform private.require_session();   -- PT401 no user, PT403 session_revoked

  update public.export_jobs j
  set state = 'cancelled', finished_at = now()
  where j.id = p_job_id and j.user_id = auth.uid() and j.deleted_at is null
    and j.state in ('queued', 'running')
  returning * into v_job;

  if not found then
    raise exception 'export job not found or not active' using errcode = 'PT404';
  end if;
  return to_jsonb(v_job) - 'deleted_at';
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- export_rows(p_job_id, p_after, p_limit): next keyset page of flat project rows
-- ---------------------------------------------------------------------------------------------

create or replace function public.export_rows(
  p_job_id uuid,
  p_after jsonb default null,
  p_limit integer default 1000
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  c_max_limit constant integer := 2000;
  c_max_tokens constant integer := 6;
  v_uid uuid := auth.uid();
  v_job public.export_jobs%rowtype;
  f jsonb;
  v_lang text;
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), c_max_limit);
  -- caller scope
  v_all boolean;
  v_countries uuid[];
  v_branches uuid[];
  v_p_all boolean;
  v_p_countries uuid[];
  v_p_branches uuid[];
  v_r_all boolean;
  v_r_countries uuid[];
  v_people boolean;
  v_restricted boolean;
  -- filters (same keys as projects_page)
  v_country uuid;
  v_branch uuid;
  v_area uuid;
  v_locality uuid;
  v_donor uuid;
  v_types text[];
  v_statuses text[];
  v_states text[];
  v_incomplete boolean;
  v_mine boolean;
  v_open_maint boolean;
  v_q text;
  v_ids_filter uuid[];
  v_area_ids uuid[];
  v_main text;
  v_p1 text;
  v_pats text[];
  v_after_id uuid;
  v_where text;
  v_ids uuid[];
  v_more boolean := false;
  v_rows jsonb;
  v_next jsonb;
  v_comp_ids uuid[];
  v_sens_ids uuid[];
begin
  -- A revoked session must fail the job (PT403), not page through an empty scope as "done".
  perform private.require_session();   -- PT401 no user, PT403 session_revoked

  select * into v_job
  from public.export_jobs j
  where j.id = p_job_id and j.deleted_at is null;
  if not found or v_job.user_id <> v_uid then
    raise exception 'export job not found' using errcode = 'PT404';
  end if;
  if v_job.state not in ('queued', 'running') then
    raise exception 'export job is %', v_job.state using errcode = 'PT409';
  end if;

  -- 100,000 projects are 100 pages of 1,000 rows; this only stops runaway loops.
  perform private.rate_limit('export_rows', 600, interval '1 minute');

  f := case when jsonb_typeof(v_job.filters) = 'object' then v_job.filters else '{}'::jsonb end;
  v_lang := v_job.lang;

  v_all := private.read_all();
  v_countries := private.read_countries();
  v_branches := private.read_branches();
  v_p_all := private.people_all();
  v_p_countries := private.people_countries();
  v_p_branches := private.people_branches();
  v_r_all := private.restricted_all();
  v_r_countries := private.restricted_countries();
  v_people := v_p_all or cardinality(v_p_countries) > 0 or cardinality(v_p_branches) > 0;
  v_restricted := v_r_all or cardinality(v_r_countries) > 0;

  if not v_all and cardinality(v_countries) = 0 and cardinality(v_branches) = 0 then
    return jsonb_build_object('job_id', p_job_id, 'rows', '[]'::jsonb, 'count', 0,
                              'next', null, 'done', true);
  end if;

  v_country := nullif(f ->> 'country_id', '')::uuid;
  v_branch := nullif(f ->> 'branch_id', '')::uuid;
  v_area := nullif(f ->> 'admin_area_id', '')::uuid;
  v_locality := nullif(f ->> 'locality_id', '')::uuid;
  v_donor := nullif(f ->> 'donor_id', '')::uuid;
  v_types := private.jsonb_text_array(f -> 'type');
  v_statuses := private.jsonb_text_array(f -> 'status');
  v_states := private.jsonb_text_array(f -> 'record_state');
  v_incomplete := coalesce((f ->> 'incomplete')::boolean, false);
  v_mine := coalesce((f ->> 'created_by_me')::boolean, false);
  v_open_maint := coalesce((f ->> 'has_open_maintenance')::boolean, false);
  v_q := nullif(btrim(coalesce(private.norm(f ->> 'q'), '')), '');
  if jsonb_typeof(f -> 'ids') = 'array' then
    select array_agg(e.v::uuid) into v_ids_filter from jsonb_array_elements_text(f -> 'ids') e(v);
  end if;

  if jsonb_typeof(p_after) = 'object' then
    v_after_id := nullif(p_after ->> 'id', '')::uuid;
  end if;

  if v_area is not null then
    with recursive tree as (
      select a.id from public.admin_areas a where a.id = v_area
      union
      select c.id from public.admin_areas c join tree t on c.parent_id = t.id
      where c.deleted_at is null
    )
    select array_agg(t.id) into v_area_ids from tree t;
  end if;

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

  -- WHERE assembled from fixed fragments (values are bound parameters only), exactly like
  -- projects_page, so the planner sees the smallest possible query.
  --   $1 countries  $2 branches  $3 country  $4 branch  $5 area ids  $6 types  $7 statuses
  --   $8 states  $9 like pattern  $10 like patterns  $11 uid  $12 donor  $13 locality
  --   $14 explicit ids  $15 after id  $16 limit  $17 people countries  $18 people branches
  v_where := 'p.deleted_at is null';
  if not v_all then
    v_where := v_where || ' and (p.country_id = any ($1) or p.branch_id = any ($2))';
  end if;
  -- Unreviewed records (migration 0013, owner decision ح): where the caller reads as a viewer
  -- only, approved projects only. Nothing is added when his people scope covers his read scope.
  if not private.reads_unreviewed_everywhere(v_all, v_countries, v_branches,
                                             v_p_all, v_p_countries, v_p_branches) then
    v_where := v_where || case
      when not v_people then ' and p.record_state = ''approved'''
      else ' and (p.record_state = ''approved'' or p.country_id = any ($17) or p.branch_id = any ($18))' end;
  end if;
  if v_country is not null then v_where := v_where || ' and p.country_id = $3'; end if;
  if v_branch is not null then v_where := v_where || ' and p.branch_id = $4'; end if;
  if v_area is not null then v_where := v_where || ' and p.admin_area_id = any ($5)'; end if;
  if v_types is not null then v_where := v_where || ' and p.type = any ($6)'; end if;
  if v_statuses is not null then v_where := v_where || ' and p.status = any ($7)'; end if;
  if v_states is not null then v_where := v_where || ' and p.record_state = any ($8)'; end if;
  if v_q is not null then
    v_where := v_where || ' and p.search_norm like $9 and p.search_norm like all ($10)';
  end if;
  if v_incomplete then v_where := v_where || ' and coalesce(p.completeness, 0) < 100'; end if;
  if v_mine then v_where := v_where || ' and p.created_by = $11'; end if;
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
  if v_locality is not null then v_where := v_where || ' and p.locality_id = $13'; end if;
  if v_ids_filter is not null then v_where := v_where || ' and p.id = any ($14)'; end if;
  if v_after_id is not null then v_where := v_where || ' and p.id > $15'; end if;

  execute 'select array_agg(s.id order by s.id) from (select p.id from public.projects p where '
          || v_where || ' order by p.id limit $16 + 1) s'
    into v_ids
    using v_countries, v_branches, v_country, v_branch, v_area_ids, v_types, v_statuses,
          v_states, v_p1, v_pats, v_uid, v_donor, v_locality, v_ids_filter, v_after_id, v_limit,
          v_p_countries, v_p_branches;

  v_ids := coalesce(v_ids, '{}'::uuid[]);
  if cardinality(v_ids) > v_limit then
    v_more := true;
    v_ids := v_ids[1:v_limit];
  end if;
  if v_more then
    v_next := jsonb_build_object('id', v_ids[v_limit]);
  end if;

  -- Flat rows -----------------------------------------------------------------------------------
  with fx as materialized (
    select distinct on (r.currency) r.currency::text as currency, r.usd_per_unit
    from public.fx_rates r
    where r.deleted_at is null and r.effective_date <= current_date
    order by r.currency, r.effective_date desc, r.created_at desc
  )
  select coalesce(jsonb_agg(x.j order by x.ord), '[]'::jsonb)
    into v_rows
  from (
    select
      u.ord,
      jsonb_build_object(
        'code', p.code,
        'name_ar', p.name_ar,
        'name_latin', p.name_latin,
        'type', p.type,
        'status', p.status,
        'record_state', p.record_state,
        'capacity', p.capacity,
        'country', case v_lang when 'ar' then coalesce(c.name_ar, c.name_en, c.name_sw)
                               when 'sw' then coalesce(c.name_sw, c.name_en, c.name_ar)
                               else coalesce(c.name_en, c.name_sw, c.name_ar) end,
        'country_iso2', c.iso2,
        'area_level1', ar.l1,
        'area_level2', ar.l2,
        'area_level3', ar.l3,
        'admin_area_code', a.code,
        'locality', case when v_lang = 'ar' then coalesce(l.name_ar, l.name_latin)
                         else coalesce(l.name_latin, l.name_ar) end,
        'branch', case v_lang when 'ar' then coalesce(b.name_ar, b.name_en, b.name_sw)
                              when 'sw' then coalesce(b.name_sw, b.name_en, b.name_ar)
                              else coalesce(b.name_en, b.name_sw, b.name_ar) end,
        'lat', st_y(p.geom),
        'lon', st_x(p.geom),
        'gps_accuracy_m', p.gps_accuracy_m,
        'location_source', p.location_source,
        'builder', p.builder,
        'build_year', p.build_year,
        'build_date', p.build_date,
        'completeness', p.completeness,
        'review_note', p.review_note)
      || jsonb_build_object(
        'land_ownership', pl.ownership,
        'land_area_m2', pl.area_m2,
        'land_utilization_pct', pl.utilization_pct,
        'land_expandable', pl.expandable,
        'land_notes', pl.notes,
        'teacher_housing', pf.teacher_housing,
        'imam_housing', pf.imam_housing,
        'guest_housing', pf.guest_housing,
        'library', pf.library,
        'quran_count', pf.quran_count,
        'quran_need', pf.quran_need,
        'hall', pf.hall,
        'hall_capacity', pf.hall_capacity,
        'student_transport', pf.student_transport,
        'students_origin', pf.students_origin)
      || jsonb_build_object(
        'community_branch_name', cp.branch_name,
        'population', cp.population,
        'muslim_pct', cp.muslim_pct,
        'daawa_activities', ol.daawa_activities,
        'social_features', ol.social_features,
        'livelihoods', ol.livelihoods,
        'religious_issues', ol.religious_issues,
        'religious_challenges', ol.religious_challenges,
        'social_challenges', ol.social_challenges,
        'proposed_activities', ol.proposed_activities)
      || jsonb_build_object(
        'donors', dn.txt,
        'maintenance_open', coalesce(mt.open_n, 0),
        'maintenance_total', coalesce(mt.total_n, 0),
        'maintenance_last_reported', mt.last_reported,
        'maintenance_open_details', mt.open_details,
        'maintenance_open_cost', mc.txt,
        'photo_count', coalesce(phc.n, 0),
        'staff_count', coalesce(stc.n, 0),
        'external_id', p.external_id,
        'id', p.id,
        'created_at', p.created_at,
        'updated_at', p.updated_at)
      || case when v_people then jsonb_build_object(
           -- a private landowner is a person: people data whatever ownership says
           'land_owner_name', case when v_p_all or p.country_id = any (v_p_countries)
                                        or p.branch_id = any (v_p_branches)
                                   then pl.owner_name end,
           'manager_name', st.manager_name,
           'manager_phone', st.manager_phone,
           'staff_list', st.staff_list,
           'entered_by', st.entered_by)
         else '{}'::jsonb end
      || case when v_restricted then jsonb_build_object(
           'monthly_payroll', pay.txt,
           'monthly_payroll_usd', pay.usd,
           'ibadi_families', cs.ibadi_families,
           'omani_families', cs.omani_families,
           'omani_student_pct', cs.omani_student_pct,
           'ibadi_student_pct', cs.ibadi_student_pct,
           'omani_teacher_pct', cs.omani_teacher_pct,
           'ibadi_teacher_pct', cs.ibadi_teacher_pct,
           'guest_financial_capacity', cs.guest_financial_capacity)
         else '{}'::jsonb end as j
    from unnest(v_ids) with ordinality as u(id, ord)
    join public.projects p on p.id = u.id
    left join public.countries c on c.id = p.country_id
    left join public.admin_areas a on a.id = p.admin_area_id
    left join public.admin_areas ap on ap.id = a.parent_id
    left join public.admin_areas ag on ag.id = ap.parent_id
    left join public.localities l on l.id = p.locality_id and l.deleted_at is null
    left join public.branches b on b.id = p.branch_id
    left join public.project_land pl on pl.project_id = p.id and pl.deleted_at is null
    left join public.project_facilities pf on pf.project_id = p.id and pf.deleted_at is null
    left join public.community_profiles cp on cp.project_id = p.id and cp.deleted_at is null
    -- admin chain: one localised name per level
    left join lateral (
      select max(n.nm) filter (where n.level = 1) as l1,
             max(n.nm) filter (where n.level = 2) as l2,
             max(n.nm) filter (where n.level = 3) as l3
      from (
        select v.level,
               case v_lang when 'ar' then coalesce(v.name_ar, v.name_en, v.name_sw)
                           when 'sw' then coalesce(v.name_sw, v.name_en, v.name_ar)
                           else coalesce(v.name_en, v.name_sw, v.name_ar) end as nm
        from (values (a.level, a.name_ar, a.name_en, a.name_sw),
                     (ap.level, ap.name_ar, ap.name_en, ap.name_sw),
                     (ag.level, ag.name_ar, ag.name_en, ag.name_sw)) v(level, name_ar, name_en, name_sw)
      ) n
    ) ar on true
    -- community multi-select lists: option names in the job language + the free "other" text
    left join lateral (
      select max(t.txt) filter (where t.k = 'daawa_activities') as daawa_activities,
             max(t.txt) filter (where t.k = 'social_features') as social_features,
             max(t.txt) filter (where t.k = 'livelihoods') as livelihoods,
             max(t.txt) filter (where t.k = 'religious_issues') as religious_issues,
             max(t.txt) filter (where t.k = 'religious_challenges') as religious_challenges,
             max(t.txt) filter (where t.k = 'social_challenges') as social_challenges,
             max(t.txt) filter (where t.k = 'proposed_activities') as proposed_activities
      from (
        select v.k,
               nullif(concat_ws(' | ',
                 (select string_agg(
                           case v_lang when 'ar' then coalesce(o.name_ar, o.name_en, o.name_sw)
                                       when 'sw' then coalesce(o.name_sw, o.name_en, o.name_ar)
                                       else coalesce(o.name_en, o.name_sw, o.name_ar) end,
                           ' | ' order by o.sort_order, o.code)
                  from public.option_values o
                  where o.id = any (v.ids)),
                 nullif(btrim(v.other), '')), '') as txt
        from (values
          ('daawa_activities', cp.daawa_activities, cp.daawa_activities_other),
          ('social_features', cp.social_features, cp.social_features_other),
          ('livelihoods', cp.livelihoods, cp.livelihoods_other),
          ('religious_issues', cp.religious_issues, cp.religious_issues_other),
          ('religious_challenges', cp.religious_challenges, cp.religious_challenges_other),
          ('social_challenges', cp.social_challenges, cp.social_challenges_other),
          ('proposed_activities', cp.proposed_activities, cp.proposed_activities_other)
        ) v(k, ids, other)
        where cp.id is not null
      ) t
    ) ol on true
    left join lateral (
      select string_agg(
               coalesce(case when v_lang = 'ar' then coalesce(d.name_ar, d.name_latin)
                             else coalesce(d.name_latin, d.name_ar) end, '?')
               || coalesce(' (' || nullif(concat_ws(', ',
                    pd.year::text,
                    case when pd.amount is not null
                         then trim_scale(pd.amount)::text || coalesce(' ' || pd.currency, '') end), '') || ')', ''),
               ' | ' order by pd.year nulls last, d.name_ar, d.id) as txt
      from public.project_donors pd
      join public.donors d on d.id = pd.donor_id and d.deleted_at is null
      where pd.project_id = p.id and pd.deleted_at is null
    ) dn on true
    left join lateral (
      select count(*) filter (where m.state in ('open', 'in_progress')) as open_n,
             count(*) as total_n,
             max(m.reported_on) as last_reported,
             string_agg('[' || coalesce(el.label, m.priority) || '] ' || m.description, ' | '
                        order by case m.priority when 'urgent' then 1 when 'high' then 2
                                   when 'medium' then 3 else 4 end, m.reported_on, m.id)
               filter (where m.state in ('open', 'in_progress')) as open_details
      from public.project_maintenance m
      left join lateral (
        select case v_lang when 'ar' then e.ar when 'sw' then e.sw else e.en end as label
        from private.enum_labels e
        where e.enum_key = 'maintenance_priority' and e.code = m.priority
      ) el on true
      where m.project_id = p.id and m.deleted_at is null
    ) mt on true
    left join lateral (
      select string_agg(y.currency || ' ' || trim_scale(y.amount)::text, ' | ' order by y.currency) as txt
      from (
        select coalesce(m.currency::text, '?') as currency, sum(m.estimated_cost) as amount
        from public.project_maintenance m
        where m.project_id = p.id and m.deleted_at is null
          and m.state in ('open', 'in_progress') and m.estimated_cost is not null
        group by 1
      ) y
    ) mc on true
    left join lateral (
      select count(*) as n
      from public.project_photos ph
      where ph.project_id = p.id and ph.deleted_at is null
    ) phc on true
    left join lateral (
      select count(*) as n
      from public.project_staff s
      where s.project_id = p.id and s.deleted_at is null
        and (s.end_date is null or s.end_date >= current_date)
    ) stc on true
    -- people columns: only for rows inside the caller's people scope, and person names / phones
    -- only for persons inside it too (persons keep their own scope when a project moves, sync.md
    -- §5.3; the persons_select rule). A person outside it is listed as "?" with the role and is
    -- never the manager_name / manager_phone.
    left join lateral (
      select
        string_agg(q.nm || ' (' || q.role_label || ')', ' | ' order by q.role_rank, q.nm, q.pid) as staff_list,
        (array_agg(q.nm order by q.nm, q.pid) filter (where q.role = 'manager' and q.vis))[1] as manager_name,
        (array_agg(q.phone order by q.nm, q.pid) filter (where q.role = 'manager' and q.vis))[1] as manager_phone,
        (select pr.full_name from public.profiles pr where pr.id = p.created_by) as entered_by
      from (
        select s.role,
               pe.id as pid,
               pv.ok as vis,
               coalesce(case when not pv.ok then null
                             when v_lang = 'ar' then coalesce(pe.name_ar, pe.name_latin)
                             else coalesce(pe.name_latin, pe.name_ar) end, '?') as nm,
               case when pv.ok then pe.phone_e164 end as phone,
               coalesce(case v_lang when 'ar' then e.ar when 'sw' then e.sw else e.en end, s.role) as role_label,
               case s.role when 'manager' then 1 when 'imam' then 2 when 'teacher' then 3
                           when 'agent' then 4 when 'administrator' then 5 else 6 end as role_rank
        from public.project_staff s
        join public.persons pe on pe.id = s.person_id and pe.deleted_at is null
        cross join lateral (
          select coalesce(v_p_all or pe.country_id = any (v_p_countries)
                          or pe.branch_id = any (v_p_branches), false) as ok
        ) pv
        left join private.enum_labels e on e.enum_key = 'staff_role' and e.code = s.role
        where s.project_id = p.id and s.deleted_at is null
          and (s.end_date is null or s.end_date >= current_date)
      ) q
    ) st on v_people
        and (v_p_all or p.country_id = any (v_p_countries) or p.branch_id = any (v_p_branches))
    -- restricted columns: only for rows inside the caller's restricted scope
    left join lateral (
      select string_agg(y.currency || ' ' || trim_scale(y.amount)::text, ' | ' order by y.currency) as txt,
             case when bool_or(y.usd is null) then null else round(sum(y.usd), 2) end as usd
      from (
        select lc.currency,
               sum(lc.monthly_amount) as amount,
               sum(lc.monthly_amount)
                 * max(case when lc.currency = 'USD' then 1::numeric else fx.usd_per_unit end) as usd
        from public.project_staff s
        join lateral (
          select sc.monthly_amount, sc.currency::text as currency
          from public.staff_compensation sc
          where sc.project_staff_id = s.id and sc.deleted_at is null
            and sc.effective_from <= current_date
          order by sc.effective_from desc, sc.created_at desc, sc.id desc
          limit 1
        ) lc on true
        left join fx on fx.currency = lc.currency
        where s.project_id = p.id and s.deleted_at is null
          and (s.end_date is null or s.end_date >= current_date)
        group by lc.currency
      ) y
    ) pay on v_restricted and (v_r_all or p.country_id = any (v_r_countries))
    left join public.community_sensitive cs
      on cs.project_id = p.id and cs.deleted_at is null
     and v_restricted and (v_r_all or p.country_id = any (v_r_countries))
  ) x;

  -- Restricted reads are logged once per page and per table --------------------------------------
  if v_restricted and cardinality(v_ids) > 0 then
    select array_agg(lc.id)
      into v_comp_ids
    from unnest(v_ids) as u(id)
    join public.projects p on p.id = u.id and (v_r_all or p.country_id = any (v_r_countries))
    join public.project_staff s on s.project_id = p.id and s.deleted_at is null
      and (s.end_date is null or s.end_date >= current_date)
    join lateral (
      select sc.id
      from public.staff_compensation sc
      where sc.project_staff_id = s.id and sc.deleted_at is null
        and sc.effective_from <= current_date
      order by sc.effective_from desc, sc.created_at desc, sc.id desc
      limit 1
    ) lc on true;

    select array_agg(cs.id)
      into v_sens_ids
    from unnest(v_ids) as u(id)
    join public.projects p on p.id = u.id and (v_r_all or p.country_id = any (v_r_countries))
    join public.community_sensitive cs on cs.project_id = p.id and cs.deleted_at is null;

    if v_comp_ids is not null then
      perform private.log_restricted('staff_compensation', v_comp_ids, 'export:' || p_job_id::text);
    end if;
    if v_sens_ids is not null then
      perform private.log_restricted('community_sensitive', v_sens_ids, 'export:' || p_job_id::text);
    end if;
  end if;

  -- Progress: the job is running, and its cursor lets a worker resume after a crash.
  update public.export_jobs j
  set state = 'running',
      started_at = coalesce(j.started_at, now()),
      "cursor" = v_next
  where j.id = p_job_id;

  return jsonb_build_object(
    'job_id', p_job_id,
    'rows', v_rows,
    'count', cardinality(v_ids),
    'next', v_next,
    'done', not v_more);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- export_finish(...): Edge Function (service role) reports the outcome and notifies the user
-- ---------------------------------------------------------------------------------------------

create or replace function public.export_finish(
  p_job_id uuid,
  p_state text,
  p_storage_path text default null,
  p_row_count integer default null,
  p_error text default null,
  p_file_name text default null,
  p_bytes bigint default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  c_keep constant interval := interval '7 days';
  v_job public.export_jobs%rowtype;
begin
  perform private.require_service_role();

  if p_state is null or p_state not in ('running', 'done', 'failed') then
    raise exception 'invalid export state: %', coalesce(p_state, 'null') using errcode = 'PT422';
  end if;

  select * into v_job
  from public.export_jobs j
  where j.id = p_job_id and j.deleted_at is null
  for update;
  if not found then
    raise exception 'export job not found' using errcode = 'PT404';
  end if;
  if v_job.state not in ('queued', 'running') then
    raise exception 'export job is already %', v_job.state using errcode = 'PT409';
  end if;

  if p_state = 'running' then
    update public.export_jobs j
    set state = 'running',
        started_at = coalesce(j.started_at, now()),
        attempts = j.attempts + 1
    where j.id = p_job_id
    returning * into v_job;

  elsif p_state = 'done' then
    -- Result files live under the owner's folder: exports/{user_id}/...
    if p_storage_path is null or p_storage_path not like v_job.user_id::text || '/%' then
      raise exception 'storage path must be inside the owner''s folder' using errcode = 'PT422';
    end if;
    update public.export_jobs j
    set state = 'done',
        storage_path = p_storage_path,
        file_name = coalesce(p_file_name, regexp_replace(p_storage_path, '^.*/', '')),
        bytes = p_bytes,
        row_count = p_row_count,
        error = null,
        "cursor" = null,
        finished_at = now(),
        expires_at = now() + c_keep
    where j.id = p_job_id
    returning * into v_job;

    insert into public.notifications (user_id, kind, payload)
    values (v_job.user_id, 'export.ready', jsonb_build_object(
      'job_id', v_job.id, 'format', v_job.format, 'lang', v_job.lang,
      'bucket', 'exports', 'storage_path', v_job.storage_path, 'file_name', v_job.file_name,
      'bytes', v_job.bytes, 'row_count', v_job.row_count, 'expires_at', v_job.expires_at));

  else
    update public.export_jobs j
    set state = 'failed',
        error = jsonb_build_object('message', left(coalesce(p_error, 'export failed'), 2000)),
        row_count = coalesce(p_row_count, j.row_count),
        finished_at = now()
    where j.id = p_job_id
    returning * into v_job;

    insert into public.notifications (user_id, kind, payload)
    values (v_job.user_id, 'export.failed', jsonb_build_object(
      'job_id', v_job.id, 'format', v_job.format, 'lang', v_job.lang,
      'error', v_job.error ->> 'message'));
  end if;

  return to_jsonb(v_job) - 'deleted_at';
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Housekeeping (cron): finished exports expire after 7 days, stuck jobs fail after one day.
-- The bookkeeping row is kept; state 'expired' tells the storage purge to remove the file.
-- ---------------------------------------------------------------------------------------------

create or replace function private.expire_export_jobs()
returns integer
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_a integer;
  v_b integer;
begin
  update public.export_jobs j
  set state = 'expired'
  where j.state = 'done' and j.expires_at is not null and j.expires_at < now();
  get diagnostics v_a = row_count;

  update public.export_jobs j
  set state = 'failed',
      finished_at = now(),
      error = jsonb_build_object('message', 'timed out')
  where j.state in ('queued', 'running') and j.created_at < now() - interval '1 day';
  get diagnostics v_b = row_count;

  return v_a + v_b;
end;
$$;

-- Privileges ----------------------------------------------------------------------------------

revoke execute on function public.export_columns(text) from public, anon;
revoke execute on function public.export_request(text, text, jsonb) from public, anon;
revoke execute on function public.export_cancel(uuid) from public, anon;
revoke execute on function public.export_rows(uuid, jsonb, integer) from public, anon;
grant execute on function public.export_columns(text) to authenticated;
grant execute on function public.export_request(text, text, jsonb) to authenticated;
grant execute on function public.export_cancel(uuid) to authenticated;
grant execute on function public.export_rows(uuid, jsonb, integer) to authenticated;

revoke execute on function public.export_finish(uuid, text, text, integer, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.export_finish(uuid, text, text, integer, text, text, bigint)
  to service_role;

revoke execute on function private.expire_export_jobs() from public, anon, authenticated;
grant execute on function private.expire_export_jobs() to service_role;

comment on function public.export_columns(text) is
  'Ordered export columns with localised headers plus localised labels of enumerated values; people / restricted columns are listed only for callers who may see them.';
comment on function public.export_request(text, text, jsonb) is
  'Creates an export job (queued) for the caller. Filters use the projects_page keys plus "ids".';
comment on function public.export_rows(uuid, jsonb, integer) is
  'Next keyset page of flat project rows for the caller''s own export job, limited to the caller''s read scope; restricted reads are logged.';
comment on function public.export_finish(uuid, text, text, integer, text, text, bigint) is
  'Service role only. Marks an export job running / done / failed and notifies the owner.';

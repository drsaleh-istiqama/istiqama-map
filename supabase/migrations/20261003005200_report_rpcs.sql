-- Print / PDF report data (brief §9): project card, donor report, periodic country report.
-- Each function returns one JSON document with everything the print page needs, filtered by
-- the CALLER's scope. Shapes: docs/contracts/reports-import-export.md.

-- Columns that never leave the database in report payloads.
create or replace function private.report_strip(p_row jsonb)
returns jsonb
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select p_row - array['geom', 'geom_simple', 'search_norm', 'name_norm', 'name_normalized',
                       'sync_xid', 'deleted_at', 'import_batch_id']
$$;

revoke execute on function private.report_strip(jsonb) from public, anon, authenticated;

-- Is a donor visible to the caller? Exactly the rule of the RLS policy donors_select (migration
-- 0013), sync_pull and sync_push (private.sync_donor_visible): a global reader sees every donor,
-- everybody else the donors he created and the donors linked by a project_donors row (live or
-- soft-deleted) to a project (live or soft-deleted) in his read scope. Donors have no country of
-- their own, so this is the only thing that keeps a donor known only in Tanzania away from a
-- Kenyan user (brief §14.5). The caller passes its read triple (fetched once, authz.md §3 b);
-- used by report_donor and by the import (donor look-up and link, migration 0055).
-- Unreviewed records (migration 0013, owner decision ح): a link to a project that is not approved
-- counts only inside the caller's people scope — p_rev_all (the caller has no viewer-only area,
-- the default) or the people arrays.
create or replace function private.donor_visible(
  p_donor_id uuid,
  p_created_by uuid,
  p_uid uuid,
  p_read_all boolean,
  p_read_countries uuid[],
  p_read_branches uuid[],
  p_rev_all boolean default true,
  p_people_countries uuid[] default '{}'::uuid[],
  p_people_branches uuid[] default '{}'::uuid[]
)
returns boolean
language sql
stable
set search_path = public, extensions, private, pg_temp
as $$
  select coalesce(p_read_all, false)
      or coalesce(p_created_by = p_uid, false)
      or exists (
           select 1
           from public.project_donors pd
           join public.projects p on p.id = pd.project_id
           where pd.donor_id = p_donor_id
             and (p.country_id = any (p_read_countries) or p.branch_id = any (p_read_branches))
             and (coalesce(p_rev_all, true) or p.record_state = 'approved'
                  or p.country_id = any (p_people_countries) or p.branch_id = any (p_people_branches)))
$$;

revoke execute on function private.donor_visible(uuid, uuid, uuid, boolean, uuid[], uuid[], boolean, uuid[], uuid[])
  from public, anon, authenticated;

-- Does the caller read anything as a viewer only? false = his people scope covers his read
-- scope (no viewer grant reaching further), so unreviewed projects need no extra filter.
create or replace function private.reads_unreviewed_everywhere(
  p_read_all boolean, p_read_countries uuid[], p_read_branches uuid[],
  p_people_all boolean, p_people_countries uuid[], p_people_branches uuid[])
returns boolean
language sql
immutable
parallel safe
set search_path = public, extensions, private, pg_temp
as $$
  select coalesce(p_people_all, false)
      or (not coalesce(p_read_all, false)
          and coalesce(p_read_countries, '{}'::uuid[]) <@ coalesce(p_people_countries, '{}'::uuid[])
          and coalesce(p_read_branches, '{}'::uuid[]) <@ coalesce(p_people_branches, '{}'::uuid[]))
$$;

revoke execute on function private.reads_unreviewed_everywhere(boolean, uuid[], uuid[], boolean, uuid[], uuid[])
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- report_project(p_id): illustrated project card
-- ---------------------------------------------------------------------------------------------

create or replace function public.report_project(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_p public.projects%rowtype;
  v_people boolean;
  v_p_all boolean;
  v_p_countries uuid[];
  v_p_branches uuid[];
  v_restricted boolean;
  v_result jsonb;
  v_country jsonb;
  v_areas jsonb;
  v_locality jsonb;
  v_branch jsonb;
  v_land jsonb;
  v_facilities jsonb;
  v_cp jsonb;
  v_community jsonb;
  v_photos jsonb;
  v_donors jsonb;
  v_maintenance jsonb;
  v_staff jsonb;
  v_staff_count bigint;
  v_comp_ids uuid[];
  v_sensitive jsonb;
  v_sensitive_id uuid;
  v_entered_by jsonb;
begin
  perform private.require_session();   -- PT401 no user, PT403 session_revoked
  perform private.rate_limit('report:' || auth.uid()::text, 120, interval '1 minute');

  select * into v_p from public.projects p where p.id = p_id and p.deleted_at is null;
  -- Same answer for "does not exist" and "not yours": never reveal existence.
  if not found or not private.can_read_project(v_p.country_id, v_p.branch_id) then
    raise exception 'project not found' using errcode = 'PT404';
  end if;

  v_people := private.can_see_people(v_p.country_id, v_p.branch_id);
  -- an unreviewed record is not there for a viewer (migration 0013, owner decision ح)
  if v_p.record_state is distinct from 'approved' and not v_people then
    raise exception 'project not found' using errcode = 'PT404';
  end if;
  v_restricted := private.can_see_restricted(v_p.country_id);

  select jsonb_build_object('id', c.id, 'iso2', c.iso2, 'name_ar', c.name_ar,
           'name_en', c.name_en, 'name_sw', c.name_sw)
    into v_country
  from public.countries c where c.id = v_p.country_id;

  -- Admin chain, level 1 first
  with recursive chain as (
    select a.id, a.parent_id, a.level, a.code, a.name_ar, a.name_en, a.name_sw, 1 as depth
    from public.admin_areas a where a.id = v_p.admin_area_id
    union all
    select a.id, a.parent_id, a.level, a.code, a.name_ar, a.name_en, a.name_sw, ch.depth + 1
    from public.admin_areas a join chain ch on a.id = ch.parent_id
    where ch.depth < 5
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', ch.id, 'level', ch.level, 'code', ch.code,
             'name_ar', ch.name_ar, 'name_en', ch.name_en, 'name_sw', ch.name_sw)
           order by ch.level), '[]'::jsonb)
    into v_areas
  from chain ch;

  select jsonb_build_object('id', l.id, 'name_ar', l.name_ar, 'name_latin', l.name_latin,
           'status', l.status)
    into v_locality
  from public.localities l where l.id = v_p.locality_id and l.deleted_at is null;

  select jsonb_build_object('id', b.id, 'code', b.code, 'name_ar', b.name_ar,
           'name_en', b.name_en, 'name_sw', b.name_sw)
    into v_branch
  from public.branches b where b.id = v_p.branch_id;

  select private.report_strip(to_jsonb(l)) into v_land
  from public.project_land l where l.project_id = p_id and l.deleted_at is null limit 1;
  -- a private landowner is a person: the name is people data (schema.md, brief §3)
  if not v_people then
    v_land := v_land - 'owner_name';
  end if;

  select private.report_strip(to_jsonb(f)) into v_facilities
  from public.project_facilities f where f.project_id = p_id and f.deleted_at is null limit 1;

  -- Community profile: multi-select lists resolved to option rows (names in all 3 languages)
  select private.report_strip(to_jsonb(cp)) into v_cp
  from public.community_profiles cp where cp.project_id = p_id and cp.deleted_at is null limit 1;

  if v_cp is not null then
    select v_cp || jsonb_build_object('lists', jsonb_object_agg(k.key, jsonb_build_object(
             'options', coalesce((
               select jsonb_agg(jsonb_build_object('id', o.id, 'code', o.code, 'name_ar', o.name_ar,
                          'name_en', o.name_en, 'name_sw', o.name_sw)
                        order by o.sort_order, o.code)
               from public.option_values o
               where o.id in (
                 select e.val::uuid
                 from jsonb_array_elements_text(
                   case when jsonb_typeof(v_cp -> k.key) = 'array' then v_cp -> k.key
                        else '[]'::jsonb end) e(val))), '[]'::jsonb),
             'other', v_cp ->> (k.key || '_other'))))
      into v_community
    from unnest(array['daawa_activities', 'social_features', 'livelihoods', 'religious_issues',
                      'religious_challenges', 'social_challenges', 'proposed_activities']) k(key);
  end if;

  -- Photos: uploaded, not purged; cover first. Lists use the thumbnail path only.
  select coalesce(jsonb_agg(jsonb_build_object(
             'id', ph.id,
             'storage_path_thumb', ph.storage_path_thumb,
             'storage_path_full', ph.storage_path_full,
             'is_cover', ph.is_cover,
             'category', ph.category,
             'caption', ph.caption,
             'taken_at', ph.taken_at,
             'width', ph.width,
             'height', ph.height)
           order by ph.is_cover desc nulls last, ph.taken_at nulls last, ph.id), '[]'::jsonb)
    into v_photos
  from public.project_photos ph
  where ph.project_id = p_id and ph.deleted_at is null and ph.purged_at is null
    and ph.upload_state = 'uploaded';

  select coalesce(jsonb_agg(jsonb_build_object(
             'id', pd.id, 'donor_id', d.id, 'name_ar', d.name_ar, 'name_latin', d.name_latin,
             'amount', pd.amount, 'currency', pd.currency, 'year', pd.year)
           order by pd.year nulls last, d.name_ar), '[]'::jsonb)
    into v_donors
  from public.project_donors pd
  join public.donors d on d.id = pd.donor_id and d.deleted_at is null
  where pd.project_id = p_id and pd.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
             'id', m.id, 'reported_on', m.reported_on, 'description', m.description,
             'priority', m.priority, 'state', m.state, 'estimated_cost', m.estimated_cost,
             'currency', m.currency, 'resolved_on', m.resolved_on)
           order by m.reported_on desc nulls last, m.created_at desc), '[]'::jsonb)
    into v_maintenance
  from public.project_maintenance m
  where m.project_id = p_id and m.deleted_at is null;

  select count(*) into v_staff_count
  from public.project_staff s
  join public.persons pe on pe.id = s.person_id and pe.deleted_at is null
  where s.project_id = p_id and s.deleted_at is null
    and (s.end_date is null or s.end_date >= current_date);

  if v_people then
    -- The assignment (project_staff) follows the project, the person row follows its own scope:
    -- persons keep their country / branch when a project moves (sync.md §5.3, known limit 2), so
    -- the persons_select rule is applied per person. A person outside the caller's people scope
    -- is listed without any person column (person_visible = false), as RLS and sync_pull show it.
    v_p_all := private.people_all();
    v_p_countries := private.people_countries();
    v_p_branches := private.people_branches();

    select coalesce(jsonb_agg(
               jsonb_build_object(
                 'project_staff_id', s.id, 'person_id', pe.id, 'person_visible', pv.ok,
                 'name_ar', case when pv.ok then pe.name_ar end,
                 'name_latin', case when pv.ok then pe.name_latin end,
                 'role', s.role, 'start_date', s.start_date, 'end_date', s.end_date,
                 'phone', case when pv.ok then pe.phone_e164 end,
                 'gender', case when pv.ok then pe.gender end,
                 'birth_year', case when pv.ok then pe.birth_year end,
                 'education_level', case when pv.ok then pe.education_level end,
                 'graduated_from', case when pv.ok then pe.graduated_from end)
               || case when v_restricted then jsonb_build_object(
                    'monthly_amount', comp.monthly_amount,
                    'currency', comp.currency,
                    'effective_from', comp.effective_from)
                  else '{}'::jsonb end
             order by case s.role when 'manager' then 1 when 'imam' then 2 when 'teacher' then 3
                        when 'agent' then 4 when 'administrator' then 5 else 6 end,
                      case when pv.ok then pe.name_ar end nulls last, s.id), '[]'::jsonb),
           array_agg(comp.id) filter (where comp.id is not null)
      into v_staff, v_comp_ids
    from public.project_staff s
    join public.persons pe on pe.id = s.person_id and pe.deleted_at is null
    cross join lateral (
      select coalesce(v_p_all or pe.country_id = any (v_p_countries)
                      or pe.branch_id = any (v_p_branches), false) as ok
    ) pv
    left join lateral (
      select c.id, c.monthly_amount, c.currency, c.effective_from
      from public.staff_compensation c
      where v_restricted
        and c.project_staff_id = s.id and c.deleted_at is null
        and (c.effective_from is null or c.effective_from <= current_date)
      order by c.effective_from desc nulls last, c.created_at desc, c.id desc
      limit 1
    ) comp on true
    where s.project_id = p_id and s.deleted_at is null;

    select jsonb_build_object('id', pr.id, 'full_name', pr.full_name)
      into v_entered_by
    from public.profiles pr where pr.id = v_p.created_by;
  end if;

  if v_restricted then
    select cs.id, private.report_strip(to_jsonb(cs))
      into v_sensitive_id, v_sensitive
    from public.community_sensitive cs
    where cs.project_id = p_id and cs.deleted_at is null
    limit 1;

    if v_comp_ids is not null and cardinality(v_comp_ids) > 0 then
      perform private.log_restricted('staff_compensation', v_comp_ids,
                                     'report_project:' || p_id::text);
    end if;
    if v_sensitive_id is not null then
      perform private.log_restricted('community_sensitive', array[v_sensitive_id],
                                     'report_project:' || p_id::text);
    end if;
  end if;

  v_result := jsonb_build_object(
    'generated_at', now(),
    'capabilities', jsonb_build_object('people', v_people, 'restricted', v_restricted),
    'project', private.report_strip(to_jsonb(v_p))
               || jsonb_build_object('lon', st_x(v_p.geom), 'lat', st_y(v_p.geom)),
    'country', v_country,
    'admin_areas', v_areas,
    'locality', v_locality,
    'branch', v_branch,
    'land', v_land,
    'facilities', v_facilities,
    'community', coalesce(v_community, v_cp),
    'photos', v_photos,
    'donors', v_donors,
    'maintenance', v_maintenance,
    'staff_count', v_staff_count
  );
  if v_people then
    v_result := v_result || jsonb_build_object('staff', v_staff, 'entered_by', v_entered_by);
  end if;
  if v_restricted then
    v_result := v_result || jsonb_build_object('sensitive', v_sensitive);
  end if;
  return v_result;
end;
$$;

revoke execute on function public.report_project(uuid) from public, anon;
grant execute on function public.report_project(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- report_donor(p_id): donor with the projects (inside the caller's read scope), photos, status
-- ---------------------------------------------------------------------------------------------

create or replace function public.report_donor(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  c_max_projects constant int := 500;
  v_all boolean;
  v_countries uuid[];
  v_branches uuid[];
  v_p_countries uuid[];
  v_p_branches uuid[];
  v_rev_all boolean;
  v_donor jsonb;
  v_creator uuid;
  v_summary jsonb;
  v_contrib jsonb;
  v_projects jsonb;
  v_total bigint;
begin
  perform private.require_session();   -- PT401 no user, PT403 session_revoked
  perform private.rate_limit('report:' || auth.uid()::text, 120, interval '1 minute');

  v_all := private.read_all();
  v_countries := private.read_countries();
  v_branches := private.read_branches();
  if not v_all and cardinality(v_countries) = 0 and cardinality(v_branches) = 0 then
    raise exception 'no read access' using errcode = 'PT403';
  end if;
  -- unreviewed records (migration 0013, owner decision ح): a viewer gets approved projects only
  v_p_countries := private.people_countries();
  v_p_branches := private.people_branches();
  v_rev_all := private.reads_unreviewed_everywhere(
    v_all, v_countries, v_branches, private.people_all(), v_p_countries, v_p_branches);

  select jsonb_build_object('id', d.id, 'name_ar', d.name_ar, 'name_latin', d.name_latin,
           'notes', d.notes),
         d.created_by
    into v_donor, v_creator
  from public.donors d where d.id = p_id and d.deleted_at is null;
  -- Same answer for "does not exist" and "not visible to you" (never reveal existence): the
  -- donor must be one the caller can see (donors_select / sync_pull rule, brief §14.5).
  if v_donor is null
     or not private.donor_visible(p_id, v_creator, auth.uid(), v_all, v_countries, v_branches,
                                  v_rev_all, v_p_countries, v_p_branches) then
    raise exception 'donor not found' using errcode = 'PT404';
  end if;

  -- Summary over ALL of the donor's projects visible to the caller
  select count(distinct p.id),
         jsonb_build_object(
           'projects', count(distinct p.id),
           'capacity', coalesce(sum(p.capacity), 0),
           'by_type', jsonb_build_object(
             'mosque', count(*) filter (where p.type = 'mosque'),
             'school', count(*) filter (where p.type = 'school'),
             'combined', count(*) filter (where p.type = 'combined')),
           'by_status', jsonb_build_object(
             'active', count(*) filter (where p.status = 'active'),
             'maintenance', count(*) filter (where p.status = 'maintenance'),
             'building', count(*) filter (where p.status = 'building'),
             'inactive', count(*) filter (where p.status = 'inactive')))
    into v_total, v_summary
  from (
    select distinct pd.project_id
    from public.project_donors pd
    where pd.donor_id = p_id and pd.deleted_at is null
  ) x
  join public.projects p on p.id = x.project_id
  where p.deleted_at is null
    and (v_all or p.country_id = any (v_countries) or p.branch_id = any (v_branches))
      and (v_rev_all or p.record_state = 'approved'
           or p.country_id = any (v_p_countries) or p.branch_id = any (v_p_branches));

  -- Contributions per currency (never added across currencies)
  select coalesce(jsonb_agg(jsonb_build_object('currency', y.currency, 'amount', y.amount)
           order by y.currency), '[]'::jsonb)
    into v_contrib
  from (
    select pd.currency::text as currency, sum(pd.amount) as amount
    from public.project_donors pd
    join public.projects p on p.id = pd.project_id
    where pd.donor_id = p_id and pd.deleted_at is null and p.deleted_at is null
      and pd.amount is not null and pd.currency is not null
      and (v_all or p.country_id = any (v_countries) or p.branch_id = any (v_branches))
      and (v_rev_all or p.record_state = 'approved'
           or p.country_id = any (v_p_countries) or p.branch_id = any (v_p_branches))
    group by pd.currency
  ) y;

  select coalesce(jsonb_agg(z.item order by z.sort_year nulls last, z.code nulls last, z.id), '[]'::jsonb)
    into v_projects
  from (
    select
      p.id, p.code, x.sort_year,
      jsonb_build_object(
        'id', p.id, 'code', p.code, 'name_ar', p.name_ar, 'name_latin', p.name_latin,
        'type', p.type, 'status', p.status, 'record_state', p.record_state,
        'capacity', p.capacity, 'build_year', p.build_year,
        'lon', st_x(p.geom), 'lat', st_y(p.geom),
        'country', (select jsonb_build_object('id', c.id, 'iso2', c.iso2, 'name_ar', c.name_ar,
                             'name_en', c.name_en, 'name_sw', c.name_sw)
                    from public.countries c where c.id = p.country_id),
        'admin_area', (select jsonb_build_object('id', a.id, 'level', a.level, 'name_ar', a.name_ar,
                                'name_en', a.name_en, 'name_sw', a.name_sw)
                       from public.admin_areas a where a.id = p.admin_area_id),
        'locality', (select jsonb_build_object('id', l.id, 'name_ar', l.name_ar, 'name_latin', l.name_latin)
                     from public.localities l where l.id = p.locality_id and l.deleted_at is null),
        'contributions', x.contributions,
        'open_maintenance', (select count(*) from public.project_maintenance m
                             where m.project_id = p.id and m.deleted_at is null
                               and m.state in ('open', 'in_progress')),
        'photos', coalesce((
          select jsonb_agg(jsonb_build_object(
                     'id', ph.id, 'storage_path_thumb', ph.storage_path_thumb,
                     'storage_path_full', ph.storage_path_full, 'is_cover', ph.is_cover,
                     'category', ph.category, 'caption', ph.caption, 'taken_at', ph.taken_at)
                   order by ph.is_cover desc nulls last, ph.taken_at nulls last, ph.id)
          from public.project_photos ph
          where ph.project_id = p.id and ph.deleted_at is null and ph.purged_at is null
            and ph.upload_state = 'uploaded'), '[]'::jsonb)
      ) as item
    from (
      select pd.project_id,
             min(pd.year) as sort_year,
             jsonb_agg(jsonb_build_object('amount', pd.amount, 'currency', pd.currency, 'year', pd.year)
                       order by pd.year nulls last) as contributions
      from public.project_donors pd
      where pd.donor_id = p_id and pd.deleted_at is null
      group by pd.project_id
    ) x
    join public.projects p on p.id = x.project_id
    where p.deleted_at is null
      and (v_all or p.country_id = any (v_countries) or p.branch_id = any (v_branches))
      and (v_rev_all or p.record_state = 'approved'
           or p.country_id = any (v_p_countries) or p.branch_id = any (v_p_branches))
    order by x.sort_year nulls last, p.code nulls last, p.id
    limit c_max_projects
  ) z;

  return jsonb_build_object(
    'generated_at', now(),
    'donor', v_donor,
    'summary', v_summary || jsonb_build_object('contributions', v_contrib),
    'projects', v_projects,
    'projects_total', v_total,
    'truncated', v_total > c_max_projects
  );
end;
$$;

revoke execute on function public.report_donor(uuid) from public, anon;
grant execute on function public.report_donor(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- report_country(p_id): periodic country report = dashboard sections + per-branch table
-- ---------------------------------------------------------------------------------------------

create or replace function public.report_country(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_nil constant uuid := private.nil_uuid();
  v_chk record;
  v_ao boolean;
  v_result jsonb;
  v_branches jsonb;
begin
  perform private.require_session();   -- PT401 no user, PT403 session_revoked
  perform private.rate_limit('report:' || auth.uid()::text, 120, interval '1 minute');

  select * into v_chk from private.report_scope_check('country', p_id);
  if not v_chk.allowed
     or not exists (select 1 from public.countries c where c.id = p_id and c.deleted_at is null) then
    raise exception 'no read access to this country' using errcode = 'PT403';
  end if;

  if v_chk.with_payroll then
    perform private.log_restricted('staff_compensation', '{}'::uuid[],
                                   'report_country.payroll:country:' || p_id::text);
  end if;

  -- without people scope on the country the caller reads it as a viewer: approved projects only
  -- (owner decision ح, migration 0013); every view carries the `approved` grouping key
  v_ao := not v_chk.with_names;
  v_result := private.dashboard_data('country', p_id, v_chk.with_payroll, v_chk.with_names, v_ao);

  with ids as (
    select t.branch_id from private.mv_project_totals t
    where t.country_id = p_id and (t.approved or not v_ao)
    union
    select b.id from public.branches b where b.country_id = p_id and b.deleted_at is null
  ),
  tot as (
    select t.branch_id,
           sum(t.project_count) as projects,
           sum(t.capacity_sum) as capacity,
           coalesce(sum(t.project_count) filter (where t.type = 'mosque'), 0) as mosque,
           coalesce(sum(t.project_count) filter (where t.type = 'school'), 0) as school,
           coalesce(sum(t.project_count) filter (where t.type = 'combined'), 0) as combined,
           coalesce(sum(t.project_count) filter (where t.status = 'active'), 0) as active,
           coalesce(sum(t.project_count) filter (where t.status = 'maintenance'), 0) as maintenance,
           coalesce(sum(t.project_count) filter (where t.status = 'building'), 0) as building,
           coalesce(sum(t.project_count) filter (where t.status = 'inactive'), 0) as inactive,
           coalesce(sum(t.approved_count), 0) as approved
    from private.mv_project_totals t
    where t.country_id = p_id and (t.approved or not v_ao)
    group by t.branch_id
  ),
  mt as (
    select m.branch_id, sum(m.open_count) as open_maintenance,
           coalesce(sum(m.open_count) filter (where m.priority = 'urgent'), 0) as urgent_maintenance
    from private.mv_maintenance_open m
    where m.country_id = p_id and (m.approved or not v_ao)
    group by m.branch_id
  ),
  st as (
    select s.branch_id, sum(s.assignment_count) as staff
    from private.mv_staff_roles s
    where s.country_id = p_id and (s.approved or not v_ao)
    group by s.branch_id
  ),
  -- mv_needs / mv_completeness hold one row per (branch, approved): summed per branch
  nd as (
    select n.branch_id, sum(n.quran_need) as quran_need,
           sum(n.teacher_housing_gaps) as teacher_housing_gaps, sum(n.imam_housing_gaps) as imam_housing_gaps,
           sum(n.transport_needed) as transport_needed, sum(n.expandable_sites) as expandable_sites
    from private.mv_needs n
    where n.country_id = p_id and (n.approved or not v_ao)
    group by n.branch_id
  ),
  cm as (
    select c.branch_id, sum(c.project_count) as project_count, sum(c.completeness_sum) as completeness_sum,
           sum(c.incomplete_count) as incomplete_count
    from private.mv_completeness c
    where c.country_id = p_id and (c.approved or not v_ao)
    group by c.branch_id
  ),
  pay as (
    select p.branch_id,
           jsonb_agg(jsonb_build_object('currency', p.currency, 'staff_paid', p.staff_paid,
                       'monthly_total', p.monthly_total, 'monthly_total_usd', p.monthly_total_usd)
                     order by p.currency) as by_currency,
           sum(p.monthly_total_usd) as monthly_total_usd
    from private.mv_payroll p
    where v_chk.with_payroll and p.country_id = p_id
    group by p.branch_id
  )
  select coalesce(jsonb_agg(
             jsonb_build_object(
               'branch_id', nullif(i.branch_id, v_nil),
               'code', b.code, 'name_ar', b.name_ar, 'name_en', b.name_en, 'name_sw', b.name_sw,
               'projects', coalesce(tot.projects, 0),
               'capacity', coalesce(tot.capacity, 0),
               'approved', coalesce(tot.approved, 0),
               'by_type', jsonb_build_object('mosque', coalesce(tot.mosque, 0),
                            'school', coalesce(tot.school, 0), 'combined', coalesce(tot.combined, 0)),
               'by_status', jsonb_build_object('active', coalesce(tot.active, 0),
                              'maintenance', coalesce(tot.maintenance, 0),
                              'building', coalesce(tot.building, 0),
                              'inactive', coalesce(tot.inactive, 0)),
               'open_maintenance', coalesce(mt.open_maintenance, 0),
               'urgent_maintenance', coalesce(mt.urgent_maintenance, 0),
               'staff', coalesce(st.staff, 0),
               'quran_need', coalesce(nd.quran_need, 0),
               'housing_gaps', coalesce(nd.teacher_housing_gaps + nd.imam_housing_gaps, 0),
               'transport_needed', coalesce(nd.transport_needed, 0),
               'expandable_sites', coalesce(nd.expandable_sites, 0),
               'completeness_average', case when coalesce(cm.project_count, 0) = 0 then null
                    else round(cm.completeness_sum::numeric / cm.project_count, 1) end,
               'incomplete', coalesce(cm.incomplete_count, 0))
             || case when v_chk.with_payroll then jsonb_build_object(
                  'payroll', jsonb_build_object(
                    'by_currency', coalesce(pay.by_currency, '[]'::jsonb),
                    'monthly_total_usd', coalesce(pay.monthly_total_usd, 0)))
                else '{}'::jsonb end
           order by (i.branch_id = v_nil), b.name_en nulls last, b.code), '[]'::jsonb)
    into v_branches
  from ids i
  left join public.branches b on b.id = i.branch_id
  left join tot on tot.branch_id = i.branch_id
  left join mt on mt.branch_id = i.branch_id
  left join st on st.branch_id = i.branch_id
  left join nd on nd.branch_id = i.branch_id
  left join cm on cm.branch_id = i.branch_id
  left join pay on pay.branch_id = i.branch_id;

  return v_result || jsonb_build_object('branches', v_branches);
end;
$$;

revoke execute on function public.report_country(uuid) from public, anon;
grant execute on function public.report_country(uuid) to authenticated;

comment on function public.report_project(uuid) is
  'Project card for print/PDF. Staff only for callers who may see people (person columns only for persons inside the caller''s people scope); salaries and sensitive community data only with restricted access (logged).';
comment on function public.report_donor(uuid) is
  'Donor report for a donor visible to the caller (donors_select rule, PT404 otherwise): donor, summary and up to 500 of its projects inside the caller''s read scope, with photo paths and status.';
comment on function public.report_country(uuid) is
  'Periodic country report: dashboard sections for the country plus a per-branch table. Callers without people scope on the country (viewers) get approved projects only.';

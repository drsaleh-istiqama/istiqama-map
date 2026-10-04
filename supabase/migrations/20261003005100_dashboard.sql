-- Dashboard RPC (brief §9): one JSON document per scope ('global' | 'country' | 'branch'),
-- built only from the report materialized views. Shape: docs/contracts/reports-import-export.md.

-- ---------------------------------------------------------------------------------------------
-- private.dashboard_data: pure builder, NO authorisation inside. Never granted to API roles;
-- it is called only from the SECURITY DEFINER functions below after they checked the caller.
-- ---------------------------------------------------------------------------------------------

-- p_approved_only: count approved projects (and what hangs below them) only — the caller has
-- no people scope on the requested scope, i.e. reads it as a viewer (owner decision ح,
-- migration 0013); every view carries the `approved` grouping key for this.
create or replace function private.dashboard_data(
  p_scope_type text,
  p_scope_id uuid,
  p_with_payroll boolean,
  p_with_names boolean,
  p_approved_only boolean default false
)
returns jsonb
language plpgsql
stable
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_nil constant uuid := private.nil_uuid();
  v_g constant boolean := (p_scope_type = 'global');
  v_c constant boolean := (p_scope_type = 'country');
  v_b constant boolean := (p_scope_type = 'branch');
  v_first_week constant date := date_trunc('week', (now() at time zone 'utc'))::date - 77;
  v_scope jsonb;
  v_totals jsonb;
  v_type_status jsonb;
  v_by_area jsonb;
  v_by_country jsonb;
  v_by_branch jsonb;
  v_maint jsonb;
  v_maint_cost jsonb;
  v_maint_items jsonb;
  v_staff jsonb;
  v_payroll jsonb;
  v_needs jsonb;
  v_completeness jsonb;
  v_weeks jsonb;
  v_week_totals jsonb;
  v_collectors jsonb;
  v_collector_count bigint;
  v_refreshed timestamptz;
  v_result jsonb;
begin
  -- Scope header -------------------------------------------------------------------------------
  if v_c then
    select jsonb_build_object('type', 'country', 'id', c.id, 'iso2', c.iso2,
             'name_ar', c.name_ar, 'name_en', c.name_en, 'name_sw', c.name_sw,
             'default_currency', c.default_currency)
      into v_scope
    from public.countries c where c.id = p_scope_id;
  elsif v_b then
    select jsonb_build_object('type', 'branch', 'id', b.id, 'code', b.code,
             'name_ar', b.name_ar, 'name_en', b.name_en, 'name_sw', b.name_sw,
             'country_id', b.country_id)
      into v_scope
    from public.branches b where b.id = p_scope_id;
  end if;
  v_scope := coalesce(v_scope, jsonb_build_object('type', p_scope_type, 'id', p_scope_id));

  -- Totals ----------------------------------------------------------------------------------------
  select jsonb_build_object(
           'projects', coalesce(sum(t.project_count), 0),
           'capacity', coalesce(sum(t.capacity_sum), 0),
           'areas_covered', count(distinct t.area1_id) filter (where t.area1_id <> v_nil),
           'by_type', jsonb_build_object(
             'mosque', coalesce(sum(t.project_count) filter (where t.type = 'mosque'), 0),
             'school', coalesce(sum(t.project_count) filter (where t.type = 'school'), 0),
             'combined', coalesce(sum(t.project_count) filter (where t.type = 'combined'), 0)),
           'by_status', jsonb_build_object(
             'active', coalesce(sum(t.project_count) filter (where t.status = 'active'), 0),
             'maintenance', coalesce(sum(t.project_count) filter (where t.status = 'maintenance'), 0),
             'building', coalesce(sum(t.project_count) filter (where t.status = 'building'), 0),
             'inactive', coalesce(sum(t.project_count) filter (where t.status = 'inactive'), 0)),
           'capacity_by_type', jsonb_build_object(
             'mosque', coalesce(sum(t.capacity_sum) filter (where t.type = 'mosque'), 0),
             'school', coalesce(sum(t.capacity_sum) filter (where t.type = 'school'), 0),
             'combined', coalesce(sum(t.capacity_sum) filter (where t.type = 'combined'), 0)),
           'by_record_state', jsonb_build_object(
             'draft', coalesce(sum(t.draft_count), 0),
             'submitted', coalesce(sum(t.submitted_count), 0),
             'approved', coalesce(sum(t.approved_count), 0),
             'returned', coalesce(sum(t.returned_count), 0)))
    into v_totals
  from private.mv_project_totals t
  where (v_g or (v_c and t.country_id = p_scope_id) or (v_b and t.branch_id = p_scope_id))
    and (t.approved or not p_approved_only);

  select coalesce(jsonb_agg(jsonb_build_object(
             'type', x.type, 'status', x.status, 'projects', x.n, 'capacity', x.cap)
           order by x.type, x.status), '[]'::jsonb)
    into v_type_status
  from (
    select t.type, t.status, sum(t.project_count) as n, sum(t.capacity_sum) as cap
    from private.mv_project_totals t
    where (v_g or (v_c and t.country_id = p_scope_id) or (v_b and t.branch_id = p_scope_id))
    and (t.approved or not p_approved_only)
    group by t.type, t.status
  ) x;

  -- Distribution by level-1 area (v2 "distribution by region" table)
  select coalesce(jsonb_agg(jsonb_build_object(
             'area_id', nullif(x.area1_id, v_nil),
             'country_id', a.country_id,
             'code', a.code,
             'name_ar', a.name_ar, 'name_en', a.name_en, 'name_sw', a.name_sw,
             'projects', x.n, 'capacity', x.cap,
             'mosque', x.mosque, 'school', x.school, 'combined', x.combined,
             'maintenance', x.maintenance)
           order by x.n desc, a.name_en nulls last), '[]'::jsonb)
    into v_by_area
  from (
    select t.area1_id,
           sum(t.project_count) as n,
           sum(t.capacity_sum) as cap,
           coalesce(sum(t.project_count) filter (where t.type = 'mosque'), 0) as mosque,
           coalesce(sum(t.project_count) filter (where t.type = 'school'), 0) as school,
           coalesce(sum(t.project_count) filter (where t.type = 'combined'), 0) as combined,
           coalesce(sum(t.project_count) filter (where t.status = 'maintenance'), 0) as maintenance
    from private.mv_project_totals t
    where (v_g or (v_c and t.country_id = p_scope_id) or (v_b and t.branch_id = p_scope_id))
    and (t.approved or not p_approved_only)
    group by t.area1_id
  ) x
  left join public.admin_areas a on a.id = x.area1_id;

  -- Distribution by country (global scope only)
  if v_g then
    select coalesce(jsonb_agg(jsonb_build_object(
               'country_id', nullif(x.country_id, v_nil), 'iso2', c.iso2,
               'name_ar', c.name_ar, 'name_en', c.name_en, 'name_sw', c.name_sw,
               'projects', x.n, 'capacity', x.cap,
               'mosque', x.mosque, 'school', x.school, 'combined', x.combined,
               'maintenance', x.maintenance)
             order by x.n desc, c.name_en nulls last), '[]'::jsonb)
      into v_by_country
    from (
      select t.country_id,
             sum(t.project_count) as n,
             sum(t.capacity_sum) as cap,
             coalesce(sum(t.project_count) filter (where t.type = 'mosque'), 0) as mosque,
             coalesce(sum(t.project_count) filter (where t.type = 'school'), 0) as school,
             coalesce(sum(t.project_count) filter (where t.type = 'combined'), 0) as combined,
             coalesce(sum(t.project_count) filter (where t.status = 'maintenance'), 0) as maintenance
      from private.mv_project_totals t
      where t.approved or not p_approved_only
      group by t.country_id
    ) x
    left join public.countries c on c.id = x.country_id;
  end if;

  -- Distribution by branch (global and country scopes)
  if v_g or v_c then
    select coalesce(jsonb_agg(jsonb_build_object(
               'branch_id', nullif(x.branch_id, v_nil), 'code', b.code,
               'country_id', b.country_id,
               'name_ar', b.name_ar, 'name_en', b.name_en, 'name_sw', b.name_sw,
               'projects', x.n, 'capacity', x.cap,
               'mosque', x.mosque, 'school', x.school, 'combined', x.combined,
               'maintenance', x.maintenance)
             order by x.n desc, b.name_en nulls last), '[]'::jsonb)
      into v_by_branch
    from (
      select t.branch_id,
             sum(t.project_count) as n,
             sum(t.capacity_sum) as cap,
             coalesce(sum(t.project_count) filter (where t.type = 'mosque'), 0) as mosque,
             coalesce(sum(t.project_count) filter (where t.type = 'school'), 0) as school,
             coalesce(sum(t.project_count) filter (where t.type = 'combined'), 0) as combined,
             coalesce(sum(t.project_count) filter (where t.status = 'maintenance'), 0) as maintenance
      from private.mv_project_totals t
      where (v_g or (v_c and t.country_id = p_scope_id))
        and (t.approved or not p_approved_only)
      group by t.branch_id
    ) x
    left join public.branches b on b.id = x.branch_id;
  end if;

  -- Open maintenance ------------------------------------------------------------------------------
  select jsonb_build_object(
           'open_total', coalesce(sum(m.open_count), 0),
           'by_priority', jsonb_build_object(
             'urgent', coalesce(sum(m.open_count) filter (where m.priority = 'urgent'), 0),
             'high', coalesce(sum(m.open_count) filter (where m.priority = 'high'), 0),
             'medium', coalesce(sum(m.open_count) filter (where m.priority = 'medium'), 0),
             'low', coalesce(sum(m.open_count) filter (where m.priority = 'low'), 0)))
    into v_maint
  from private.mv_maintenance_open m
  where (v_g or (v_c and m.country_id = p_scope_id) or (v_b and m.branch_id = p_scope_id))
    and (m.approved or not p_approved_only);

  -- Estimated cost per currency (never added across currencies) + USD equivalent
  select coalesce(jsonb_agg(jsonb_build_object(
             'currency', x.currency, 'amount', x.amount,
             'amount_usd', round(x.amount * (case when x.currency = 'USD' then 1 else fx.usd_per_unit end), 2))
           order by x.currency), '[]'::jsonb)
    into v_maint_cost
  from (
    select m.currency, sum(m.cost_sum) as amount
    from private.mv_maintenance_open m
    where (v_g or (v_c and m.country_id = p_scope_id) or (v_b and m.branch_id = p_scope_id))
      and (m.approved or not p_approved_only)
      and m.currency <> ''
    group by m.currency
    having sum(m.cost_sum) <> 0
  ) x
  left join lateral (
    select f.usd_per_unit
    from public.fx_rates f
    where f.currency = x.currency and f.deleted_at is null
      and (f.effective_date is null or f.effective_date <= current_date)
    order by f.effective_date desc nulls last, f.created_at desc
    limit 1
  ) fx on true;

  -- Top 20 open entries, most urgent first (separate statements so each uses its own index)
  if v_g then
    select coalesce(jsonb_agg(to_jsonb(i) - 'priority_rank' - 'country_id' - 'branch_id' - 'approved'
             order by i.priority_rank, i.reported_on, i.id), '[]'::jsonb)
      into v_maint_items
    from (select * from private.mv_maintenance_items
          where approved or not p_approved_only
          order by priority_rank, reported_on, id limit 20) i;
  elsif v_c then
    select coalesce(jsonb_agg(to_jsonb(i) - 'priority_rank' - 'country_id' - 'branch_id' - 'approved'
             order by i.priority_rank, i.reported_on, i.id), '[]'::jsonb)
      into v_maint_items
    from (select * from private.mv_maintenance_items
          where country_id = p_scope_id and (approved or not p_approved_only)
          order by priority_rank, reported_on, id limit 20) i;
  else
    select coalesce(jsonb_agg(to_jsonb(i) - 'priority_rank' - 'country_id' - 'branch_id' - 'approved'
             order by i.priority_rank, i.reported_on, i.id), '[]'::jsonb)
      into v_maint_items
    from (select * from private.mv_maintenance_items
          where branch_id = p_scope_id and (approved or not p_approved_only)
          order by priority_rank, reported_on, id limit 20) i;
  end if;
  v_maint := v_maint || jsonb_build_object('estimated_cost', v_maint_cost, 'items', v_maint_items);

  -- Staff by role ---------------------------------------------------------------------------------
  select jsonb_build_object(
           'assignments', coalesce(sum(s.assignment_count), 0),
           'by_role', jsonb_build_object(
             'imam', coalesce(sum(s.assignment_count) filter (where s.role = 'imam'), 0),
             'teacher', coalesce(sum(s.assignment_count) filter (where s.role = 'teacher'), 0),
             'agent', coalesce(sum(s.assignment_count) filter (where s.role = 'agent'), 0),
             'administrator', coalesce(sum(s.assignment_count) filter (where s.role = 'administrator'), 0),
             'manager', coalesce(sum(s.assignment_count) filter (where s.role = 'manager'), 0),
             'other', coalesce(sum(s.assignment_count) filter (where s.role = 'other'), 0)))
    into v_staff
  from private.mv_staff_roles s
  where (v_g or (v_c and s.country_id = p_scope_id) or (v_b and s.branch_id = p_scope_id))
    and (s.approved or not p_approved_only);

  -- Payroll (restricted) --------------------------------------------------------------------------
  if p_with_payroll then
    select jsonb_build_object(
             'staff_paid', coalesce(sum(x.staff_paid), 0),
             'monthly_total_usd', coalesce(sum(x.monthly_total_usd), 0),
             'missing_rates', coalesce(jsonb_agg(x.currency order by x.currency)
                                         filter (where x.monthly_total_usd is null), '[]'::jsonb),
             'by_currency', coalesce(jsonb_agg(jsonb_build_object(
                 'currency', x.currency,
                 'staff_paid', x.staff_paid,
                 'monthly_total', x.monthly_total,
                 'usd_per_unit', x.usd_per_unit,
                 'rate_date', x.rate_date,
                 'monthly_total_usd', x.monthly_total_usd)
               order by x.currency), '[]'::jsonb))
      into v_payroll
    from (
      select p.currency,
             sum(p.staff_paid) as staff_paid,
             sum(p.monthly_total) as monthly_total,
             max(p.usd_per_unit) as usd_per_unit,
             max(p.rate_date) as rate_date,
             case when bool_or(p.monthly_total_usd is null) then null
                  else sum(p.monthly_total_usd) end as monthly_total_usd
      from private.mv_payroll p
      where v_g or (v_c and p.country_id = p_scope_id) or (v_b and p.branch_id = p_scope_id)
      group by p.currency
    ) x;
  end if;

  -- Needs -----------------------------------------------------------------------------------------
  select jsonb_build_object(
           'quran_need', coalesce(sum(n.quran_need), 0),
           'quran_count', coalesce(sum(n.quran_count), 0),
           'quran_need_projects', coalesce(sum(n.quran_need_projects), 0),
           'teacher_housing_gaps', coalesce(sum(n.teacher_housing_gaps), 0),
           'imam_housing_gaps', coalesce(sum(n.imam_housing_gaps), 0),
           'housing_gaps', coalesce(sum(n.teacher_housing_gaps + n.imam_housing_gaps), 0),
           'transport_needed', coalesce(sum(n.transport_needed), 0),
           'expandable_sites', coalesce(sum(n.expandable_sites), 0))
    into v_needs
  from private.mv_needs n
  where (v_g or (v_c and n.country_id = p_scope_id) or (v_b and n.branch_id = p_scope_id))
    and (n.approved or not p_approved_only);

  -- Data completeness -----------------------------------------------------------------------------
  select jsonb_build_object(
           'projects', coalesce(sum(c.project_count), 0),
           'average', case when coalesce(sum(c.project_count), 0) = 0 then null
                           else round(sum(c.completeness_sum)::numeric / sum(c.project_count), 1) end,
           'incomplete', coalesce(sum(c.incomplete_count), 0),
           'complete', coalesce(sum(c.project_count - c.incomplete_count), 0),
           'below_half', coalesce(sum(c.below_half_count), 0))
    into v_completeness
  from private.mv_completeness c
  where (v_g or (v_c and c.country_id = p_scope_id) or (v_b and c.branch_id = p_scope_id))
    and (c.approved or not p_approved_only);

  -- Weekly data-entry activity (last 12 ISO weeks, oldest first) ---------------------------------
  select jsonb_agg(to_char(w.week_start, 'YYYY-MM-DD') order by w.week_start),
         jsonb_agg(jsonb_build_object(
             'week_start', to_char(w.week_start, 'YYYY-MM-DD'),
             'created', coalesce(a.created, 0),
             'updated', coalesce(a.updated, 0))
           order by w.week_start)
    into v_weeks, v_week_totals
  from (select (v_first_week + (g * 7))::date as week_start from generate_series(0, 11) g) w
  left join (
    select e.week_start, sum(e.created_count) as created, sum(e.updated_count) as updated
    from private.mv_entry_activity e
    where (v_g or (v_c and e.country_id = p_scope_id) or (v_b and e.branch_id = p_scope_id))
      and (e.approved or not p_approved_only)
      and e.week_start >= v_first_week
    group by e.week_start
  ) a on a.week_start = w.week_start;

  select count(distinct e.user_id)
    into v_collector_count
  from private.mv_entry_activity e
  where (v_g or (v_c and e.country_id = p_scope_id) or (v_b and e.branch_id = p_scope_id))
      and (e.approved or not p_approved_only)
    and e.week_start >= v_first_week;

  if p_with_names then
    select coalesce(jsonb_agg(jsonb_build_object(
               'user_id', u.user_id,
               'full_name', pr.full_name,
               'created', u.created,
               'updated', u.updated,
               'weeks', u.weeks)
             order by (u.created + u.updated) desc, pr.full_name nulls last, u.user_id), '[]'::jsonb)
      into v_collectors
    from (
      select w.user_id,
             sum(w.created) as created,
             sum(w.updated) as updated,
             jsonb_agg(jsonb_build_object(
                 'week_start', to_char(w.week_start, 'YYYY-MM-DD'),
                 'created', w.created, 'updated', w.updated)
               order by w.week_start) as weeks
      from (
        select e.user_id, e.week_start,
               sum(e.created_count) as created, sum(e.updated_count) as updated
        from private.mv_entry_activity e
        where (v_g or (v_c and e.country_id = p_scope_id) or (v_b and e.branch_id = p_scope_id))
      and (e.approved or not p_approved_only)
          and e.week_start >= v_first_week
        group by e.user_id, e.week_start
      ) w
      group by w.user_id
      order by sum(w.created) + sum(w.updated) desc, w.user_id
      limit 50
    ) u
    left join public.profiles pr on pr.id = u.user_id;
  end if;

  select m.refreshed_at into v_refreshed from private.report_meta m where m.id;

  v_result := jsonb_build_object(
    'scope', v_scope,
    'last_refreshed_at', v_refreshed,
    'generated_at', now(),
    'totals', v_totals || jsonb_build_object('by_type_status', v_type_status, 'by_area', v_by_area),
    'maintenance', v_maint,
    'staff', v_staff,
    'needs', v_needs,
    'completeness', v_completeness,
    'entry_activity', jsonb_build_object(
      'weeks', coalesce(v_weeks, '[]'::jsonb),
      'totals', coalesce(v_week_totals, '[]'::jsonb),
      'collector_count', coalesce(v_collector_count, 0))
  );

  if v_by_country is not null then
    v_result := jsonb_set(v_result, '{totals,by_country}', v_by_country);
  end if;
  if v_by_branch is not null then
    v_result := jsonb_set(v_result, '{totals,by_branch}', v_by_branch);
  end if;
  if p_with_names then
    v_result := jsonb_set(v_result, '{entry_activity,collectors}', coalesce(v_collectors, '[]'::jsonb));
  end if;
  if p_with_payroll then
    v_result := v_result || jsonb_build_object('payroll', v_payroll);
  end if;

  return v_result;
end;
$$;

revoke execute on function private.dashboard_data(text, uuid, boolean, boolean, boolean)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- private.report_scope_check: shared authorisation for dashboard() and report_country().
-- Returns (allowed, with_payroll, with_names, country_id) for the CALLING user.
-- with_names = people scope on the requested scope; without it the caller reads the scope as a
-- viewer and gets approved projects only (dashboard_data p_approved_only = not with_names).
-- ---------------------------------------------------------------------------------------------

create or replace function private.report_scope_check(
  p_scope_type text,
  p_scope_id uuid,
  out allowed boolean,
  out with_payroll boolean,
  out with_names boolean,
  out country_id uuid
)
language plpgsql
stable
set search_path = public, extensions, private, pg_temp
as $$
begin
  allowed := false;
  with_payroll := false;
  with_names := false;
  country_id := null;

  if p_scope_type = 'global' then
    allowed := private.read_all();
    if allowed then
      with_payroll := private.restricted_all();
      with_names := private.people_all();
    end if;
  elsif p_scope_type = 'country' then
    if p_scope_id is null then
      return;
    end if;
    country_id := p_scope_id;
    allowed := private.can_read_project(p_scope_id, null::uuid);
    if allowed then
      with_payroll := private.can_see_restricted(p_scope_id);
      with_names := private.can_see_people(p_scope_id, null::uuid);
    end if;
  elsif p_scope_type = 'branch' then
    if p_scope_id is null then
      return;
    end if;
    select b.country_id into country_id from public.branches b where b.id = p_scope_id;
    if not found then
      return;
    end if;
    allowed := private.can_read_project(country_id, p_scope_id);
    if allowed then
      with_payroll := private.can_see_restricted(country_id);
      with_names := private.can_see_people(country_id, p_scope_id);
    end if;
  end if;
end;
$$;

revoke execute on function private.report_scope_check(text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- public.dashboard(p_scope_type, p_scope_id)
-- ---------------------------------------------------------------------------------------------

create or replace function public.dashboard(p_scope_type text, p_scope_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_chk record;
begin
  perform private.require_session();   -- PT401 no user, PT403 session_revoked
  if p_scope_type is null or p_scope_type not in ('global', 'country', 'branch') then
    raise exception 'invalid scope type: %', coalesce(p_scope_type, 'null') using errcode = 'PT422';
  end if;
  if p_scope_type = 'global' then
    p_scope_id := null;
  end if;

  perform private.rate_limit('dashboard:' || auth.uid()::text, 120, interval '1 minute');

  select * into v_chk from private.report_scope_check(p_scope_type, p_scope_id);
  if not v_chk.allowed then
    raise exception 'no read access to this scope' using errcode = 'PT403';
  end if;

  if v_chk.with_payroll then
    -- Aggregated payroll is still restricted data: log who read it and for which scope.
    -- (No individual rows are returned, so the id list is empty; the scope is in the context.)
    perform private.log_restricted(
      'staff_compensation',
      '{}'::uuid[],
      'dashboard.payroll:' || p_scope_type || coalesce(':' || p_scope_id::text, ''));
  end if;

  return private.dashboard_data(p_scope_type, p_scope_id, v_chk.with_payroll, v_chk.with_names,
                                not v_chk.with_names);
end;
$$;

revoke execute on function public.dashboard(text, uuid) from public, anon;
grant execute on function public.dashboard(text, uuid) to authenticated;

comment on function public.dashboard(text, uuid) is
  'Dashboard for a scope (global | country | branch) from the report materialized views. Payroll only for callers with restricted access (logged); collector names omitted and approved projects only for viewers.';

-- Reporting materialized views (brief §5 "reports are built on materialized views refreshed
-- every 15 minutes" and §9 dashboard sections).
--
-- All views live in schema `private` (never exposed through PostgREST) and are read only by
-- the SECURITY DEFINER report functions in the following migrations, which apply the caller's
-- scope. Every view has a UNIQUE index on plain columns so that it can be refreshed
-- CONCURRENTLY (readers are never blocked).
--
-- Grouping keys are never NULL: a missing country / branch / level-1 area is stored as the nil
-- UUID (00000000-0000-0000-0000-000000000000) so that the unique index covers every row.
-- The report functions translate the nil UUID back to JSON null.

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

create or replace function private.nil_uuid()
returns uuid
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$ select '00000000-0000-0000-0000-000000000000'::uuid $$;

-- Single-row bookkeeping table: when the report views were last refreshed.
create table if not exists private.report_meta (
  id boolean primary key default true check (id),
  refreshed_at timestamptz,
  duration_ms integer,
  clusters_refreshed boolean not null default false
);
alter table private.report_meta enable row level security;
revoke all on private.report_meta from public, anon, authenticated;
insert into private.report_meta (id, refreshed_at) values (true, now()) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------------------------
-- 1. Project totals by (country, branch, level-1 area, type, status)
-- ---------------------------------------------------------------------------------------------

create materialized view private.mv_project_totals as
select
  coalesce(p.country_id, private.nil_uuid()) as country_id,
  coalesce(p.branch_id, private.nil_uuid()) as branch_id,
  coalesce(
    case when a.level = 1 then a.id end,
    case when ap.level = 1 then ap.id end,
    case when ag.level = 1 then ag.id end,
    private.nil_uuid()
  ) as area1_id,
  coalesce(p.type, 'unspecified') as type,
  coalesce(p.status, 'unspecified') as status,
  count(*)::bigint as project_count,
  coalesce(sum(p.capacity), 0)::bigint as capacity_sum,
  (count(*) filter (where p.record_state = 'draft'))::bigint as draft_count,
  (count(*) filter (where p.record_state = 'submitted'))::bigint as submitted_count,
  (count(*) filter (where p.record_state = 'approved'))::bigint as approved_count,
  (count(*) filter (where p.record_state = 'returned'))::bigint as returned_count
from public.projects p
left join public.admin_areas a on a.id = p.admin_area_id
left join public.admin_areas ap on ap.id = a.parent_id
left join public.admin_areas ag on ag.id = ap.parent_id
where p.deleted_at is null
group by 1, 2, 3, 4, 5
with data;

create unique index mv_project_totals_key
  on private.mv_project_totals (country_id, branch_id, area1_id, type, status);
create index mv_project_totals_branch on private.mv_project_totals (branch_id);

-- ---------------------------------------------------------------------------------------------
-- 2. Open maintenance by priority (cost is kept per currency, never added across currencies)
-- ---------------------------------------------------------------------------------------------

create materialized view private.mv_maintenance_open as
select
  coalesce(p.country_id, private.nil_uuid()) as country_id,
  coalesce(p.branch_id, private.nil_uuid()) as branch_id,
  coalesce(m.priority, 'medium') as priority,
  coalesce(m.currency::text, '') as currency,
  count(*)::bigint as open_count,
  coalesce(sum(m.estimated_cost), 0)::numeric as cost_sum
from public.project_maintenance m
join public.projects p on p.id = m.project_id
where m.deleted_at is null
  and p.deleted_at is null
  and m.state in ('open', 'in_progress')
group by 1, 2, 3, 4
with data;

create unique index mv_maintenance_open_key
  on private.mv_maintenance_open (country_id, branch_id, priority, currency);
create index mv_maintenance_open_branch on private.mv_maintenance_open (branch_id);

-- Open maintenance entries themselves, pre-sorted for the "open maintenance by priority" list.
create materialized view private.mv_maintenance_items as
select
  m.id,
  m.project_id,
  coalesce(p.country_id, private.nil_uuid()) as country_id,
  coalesce(p.branch_id, private.nil_uuid()) as branch_id,
  p.code as project_code,
  p.name_ar as project_name_ar,
  p.name_latin as project_name_latin,
  coalesce(m.priority, 'medium') as priority,
  (case coalesce(m.priority, 'medium')
     when 'urgent' then 1 when 'high' then 2 when 'medium' then 3 else 4 end)::smallint as priority_rank,
  m.state,
  m.reported_on,
  m.description,
  m.estimated_cost,
  m.currency::text as currency
from public.project_maintenance m
join public.projects p on p.id = m.project_id
where m.deleted_at is null
  and p.deleted_at is null
  and m.state in ('open', 'in_progress')
with data;

create unique index mv_maintenance_items_key on private.mv_maintenance_items (id);
create index mv_maintenance_items_global
  on private.mv_maintenance_items (priority_rank, reported_on, id);
create index mv_maintenance_items_country
  on private.mv_maintenance_items (country_id, priority_rank, reported_on, id);
create index mv_maintenance_items_branch
  on private.mv_maintenance_items (branch_id, priority_rank, reported_on, id);

-- ---------------------------------------------------------------------------------------------
-- 3. Staff by role (current assignments only)
-- ---------------------------------------------------------------------------------------------

create materialized view private.mv_staff_roles as
select
  coalesce(p.country_id, private.nil_uuid()) as country_id,
  coalesce(p.branch_id, private.nil_uuid()) as branch_id,
  coalesce(s.role, 'other') as role,
  count(*)::bigint as assignment_count,
  count(distinct s.person_id)::bigint as person_count
from public.project_staff s
join public.projects p on p.id = s.project_id
join public.persons pe on pe.id = s.person_id
where s.deleted_at is null
  and p.deleted_at is null
  and pe.deleted_at is null
  and (s.end_date is null or s.end_date >= current_date)
group by 1, 2, 3
with data;

create unique index mv_staff_roles_key on private.mv_staff_roles (country_id, branch_id, role);
create index mv_staff_roles_branch on private.mv_staff_roles (branch_id);

-- ---------------------------------------------------------------------------------------------
-- 4. Payroll by (country, branch, currency): monthly total in the local currency AND in USD
--    through the latest fx_rates row. RESTRICTED: read only via private.can_see_restricted().
-- ---------------------------------------------------------------------------------------------

create materialized view private.mv_payroll as
with latest_comp as (
  select distinct on (c.project_staff_id)
    c.project_staff_id, c.monthly_amount, c.currency::text as currency
  from public.staff_compensation c
  where c.deleted_at is null
    and c.monthly_amount is not null
    and (c.effective_from is null or c.effective_from <= current_date)
  order by c.project_staff_id, c.effective_from desc nulls last, c.created_at desc, c.id desc
),
latest_fx as (
  select distinct on (f.currency)
    f.currency::text as currency, f.usd_per_unit, f.effective_date
  from public.fx_rates f
  where f.deleted_at is null
    and f.usd_per_unit is not null
    and (f.effective_date is null or f.effective_date <= current_date)
  order by f.currency, f.effective_date desc nulls last, f.created_at desc, f.id desc
)
select
  coalesce(p.country_id, private.nil_uuid()) as country_id,
  coalesce(p.branch_id, private.nil_uuid()) as branch_id,
  lc.currency,
  count(*)::bigint as staff_paid,
  sum(lc.monthly_amount)::numeric(18, 2) as monthly_total,
  max(case when lc.currency = 'USD' then 1::numeric else fx.usd_per_unit end) as usd_per_unit,
  max(case when lc.currency = 'USD' then null else fx.effective_date end) as rate_date,
  round(
    sum(lc.monthly_amount) * max(case when lc.currency = 'USD' then 1::numeric else fx.usd_per_unit end),
    2
  )::numeric(18, 2) as monthly_total_usd
from latest_comp lc
join public.project_staff s on s.id = lc.project_staff_id
join public.projects p on p.id = s.project_id
left join latest_fx fx on fx.currency = lc.currency
where s.deleted_at is null
  and p.deleted_at is null
  and (s.end_date is null or s.end_date >= current_date)
group by 1, 2, 3
with data;

create unique index mv_payroll_key on private.mv_payroll (country_id, branch_id, currency);
create index mv_payroll_branch on private.mv_payroll (branch_id);

-- ---------------------------------------------------------------------------------------------
-- 5. Needs: Qur'an copies, housing gaps, transport, expandable sites
-- ---------------------------------------------------------------------------------------------

create materialized view private.mv_needs as
select
  coalesce(p.country_id, private.nil_uuid()) as country_id,
  coalesce(p.branch_id, private.nil_uuid()) as branch_id,
  count(*)::bigint as project_count,
  coalesce(sum(f.quran_need), 0)::bigint as quran_need,
  coalesce(sum(f.quran_count), 0)::bigint as quran_count,
  (count(*) filter (where f.quran_need > 0))::bigint as quran_need_projects,
  (count(*) filter (where f.teacher_housing is false))::bigint as teacher_housing_gaps,
  (count(*) filter (where f.imam_housing is false))::bigint as imam_housing_gaps,
  (count(*) filter (where f.student_transport = 'needed'))::bigint as transport_needed,
  (count(*) filter (where l.expandable is true))::bigint as expandable_sites
from public.projects p
left join public.project_facilities f on f.project_id = p.id and f.deleted_at is null
left join public.project_land l on l.project_id = p.id and l.deleted_at is null
where p.deleted_at is null
group by 1, 2
with data;

create unique index mv_needs_key on private.mv_needs (country_id, branch_id);
create index mv_needs_branch on private.mv_needs (branch_id);

-- ---------------------------------------------------------------------------------------------
-- 6. Data completeness (sum + count so that averages combine correctly across groups)
-- ---------------------------------------------------------------------------------------------

create materialized view private.mv_completeness as
select
  coalesce(p.country_id, private.nil_uuid()) as country_id,
  coalesce(p.branch_id, private.nil_uuid()) as branch_id,
  count(*)::bigint as project_count,
  coalesce(sum(p.completeness), 0)::bigint as completeness_sum,
  (count(*) filter (where coalesce(p.completeness, 0) < 100))::bigint as incomplete_count,
  (count(*) filter (where coalesce(p.completeness, 0) < 50))::bigint as below_half_count
from public.projects p
where p.deleted_at is null
group by 1, 2
with data;

create unique index mv_completeness_key on private.mv_completeness (country_id, branch_id);
create index mv_completeness_branch on private.mv_completeness (branch_id);

-- ---------------------------------------------------------------------------------------------
-- 7. Weekly data-entry activity per collector, last 12 ISO weeks (UTC, weeks start on Monday)
--
--    created = projects the user created in that week
--    updated = projects whose latest change was made by the user in that week, excluding the
--              ones the same user created in the same week (those are counted once, as created)
-- ---------------------------------------------------------------------------------------------

create materialized view private.mv_entry_activity as
with bounds as (
  select (date_trunc('week', (now() at time zone 'utc'))::date - 77) as first_week
),
events as (
  select
    p.created_by as user_id,
    p.country_id,
    p.branch_id,
    date_trunc('week', (p.created_at at time zone 'utc'))::date as week_start,
    1 as created,
    0 as updated
  from public.projects p, bounds b
  where p.deleted_at is null
    and p.created_by is not null
    and p.created_at >= b.first_week
  union all
  select
    p.updated_by,
    p.country_id,
    p.branch_id,
    date_trunc('week', (p.updated_at at time zone 'utc'))::date,
    0,
    1
  from public.projects p, bounds b
  where p.deleted_at is null
    and p.updated_by is not null
    and p.version > 1
    and p.updated_at >= b.first_week
    and not (
      p.created_by is not distinct from p.updated_by
      and date_trunc('week', (p.created_at at time zone 'utc')) = date_trunc('week', (p.updated_at at time zone 'utc'))
    )
)
select
  e.week_start,
  e.user_id,
  coalesce(e.country_id, private.nil_uuid()) as country_id,
  coalesce(e.branch_id, private.nil_uuid()) as branch_id,
  sum(e.created)::bigint as created_count,
  sum(e.updated)::bigint as updated_count
from events e
group by 1, 2, 3, 4
with data;

create unique index mv_entry_activity_key
  on private.mv_entry_activity (week_start, user_id, country_id, branch_id);
create index mv_entry_activity_country on private.mv_entry_activity (country_id, week_start);
create index mv_entry_activity_branch on private.mv_entry_activity (branch_id, week_start);

-- Nobody but the owner (and therefore the SECURITY DEFINER report functions) reads the views.
revoke all on private.mv_project_totals from public, anon, authenticated;
revoke all on private.mv_maintenance_open from public, anon, authenticated;
revoke all on private.mv_maintenance_items from public, anon, authenticated;
revoke all on private.mv_staff_roles from public, anon, authenticated;
revoke all on private.mv_payroll from public, anon, authenticated;
revoke all on private.mv_needs from public, anon, authenticated;
revoke all on private.mv_completeness from public, anon, authenticated;
revoke all on private.mv_entry_activity from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- refresh_reports(): service role / cron only
-- ---------------------------------------------------------------------------------------------

create or replace function public.refresh_reports()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
set statement_timeout = '10min'
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_role text := auth.jwt() ->> 'role';
  v_view text;
  v_clusters boolean := false;
  v_ms integer;
begin
  -- API callers must present the service-role key; cron / direct superuser sessions carry no JWT.
  if v_role is not null and v_role <> 'service_role' then
    raise exception 'refresh_reports is restricted to the service role'
      using errcode = 'PT403';
  end if;

  -- Never run two refreshes at once (a slow run must not pile up behind the next cron tick).
  if not pg_try_advisory_xact_lock(hashtextextended('istiqama.refresh_reports', 0)) then
    return jsonb_build_object('skipped', true, 'reason', 'already_running');
  end if;

  foreach v_view in array array[
    'mv_project_totals', 'mv_maintenance_open', 'mv_maintenance_items', 'mv_staff_roles',
    'mv_payroll', 'mv_needs', 'mv_completeness', 'mv_entry_activity'
  ] loop
    execute format('refresh materialized view concurrently private.%I', v_view);
  end loop;

  -- The map cluster pyramid belongs to the tiles migration; refresh it when it exists.
  if to_regprocedure('private.refresh_clusters()') is not null then
    execute 'select private.refresh_clusters()';
    v_clusters := true;
  end if;

  v_ms := (extract(epoch from clock_timestamp() - v_started) * 1000)::integer;
  insert into private.report_meta as m (id, refreshed_at, duration_ms, clusters_refreshed)
  values (true, now(), v_ms, v_clusters)
  on conflict (id) do update
    set refreshed_at = excluded.refreshed_at,
        duration_ms = excluded.duration_ms,
        clusters_refreshed = excluded.clusters_refreshed;

  return jsonb_build_object(
    'skipped', false,
    'refreshed_at', now(),
    'duration_ms', v_ms,
    'clusters_refreshed', v_clusters
  );
end;
$$;

revoke execute on function public.refresh_reports() from public, anon, authenticated;
grant execute on function public.refresh_reports() to service_role;

comment on function public.refresh_reports() is
  'Refreshes all report materialized views concurrently (and the map cluster pyramid when present). Service role / cron only; scheduled every 15 minutes.';

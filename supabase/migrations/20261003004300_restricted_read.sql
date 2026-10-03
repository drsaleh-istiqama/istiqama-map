-- =============================================================================
-- 0043  restricted_read — the only interactive read path to the restricted
--       tables (brief §2.4, §2.5, §3, §11; ARCHITECTURE decision D3)
--
-- staff_compensation and community_sensitive carry no privilege and no RLS
-- policy for API roles. This SECURITY DEFINER function
--   * accepts only those two table names;
--   * returns rows only for projects in countries where the caller may see
--     restricted data (country_manager of that country, hq_admin) — other
--     project ids are dropped silently;
--   * writes exactly one restricted_access_log entry per call (who, when, which
--     records);
--   * never adds amounts of different currencies: salaries are returned in the
--     original currency together with a USD equivalent computed from the latest
--     fx_rates row on or before today, and totals are per currency plus USD.
--
-- JSON shapes: docs/contracts/people-admin.md
-- =============================================================================

create or replace function public.restricted_read(p_table text, p_project_ids uuid[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  c_max_projects constant integer := 200;
  v_all        boolean;
  v_countries  uuid[];
  v_requested  uuid[];
  v_projects   uuid[];
  v_today      date := current_date;
  v_rows       jsonb;
  v_ids        uuid[];
  v_totals     jsonb;
  v_result     jsonb;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = 'PT401';
  end if;
  if p_table is null or p_table not in ('staff_compensation', 'community_sensitive') then
    raise exception 'invalid_table' using errcode = 'PT422',
      detail = format('restricted_read accepts staff_compensation or community_sensitive, not "%s".',
                      coalesce(p_table, ''));
  end if;

  -- Callers without any restricted capability are refused outright.
  v_all       := coalesce(private.restricted_all(), false);
  v_countries := coalesce(private.restricted_countries(), '{}'::uuid[]);
  if not v_all and cardinality(v_countries) = 0 then
    raise exception 'forbidden' using errcode = 'PT403',
      detail = 'Restricted data is available to country managers and HQ administrators only.';
  end if;

  select coalesce(array_agg(distinct x), '{}'::uuid[])
  into v_requested
  from unnest(coalesce(p_project_ids, '{}'::uuid[])) x
  where x is not null;

  if cardinality(v_requested) > c_max_projects then
    raise exception 'too_many_projects' using errcode = 'PT422',
      detail = format('restricted_read accepts at most %s projects per call.', c_max_projects);
  end if;

  perform private.rate_limit('restricted_read', 60, interval '1 minute');

  -- Projects the caller may see restricted data for; everything else is dropped.
  select coalesce(array_agg(p.id), '{}'::uuid[])
  into v_projects
  from public.projects p
  where p.id = any (v_requested)
    and p.deleted_at is null
    and (v_all or p.country_id = any (v_countries));

  if p_table = 'staff_compensation' then
    with rates as (
      -- latest rate per currency on or before today
      select distinct on (f.currency)
             f.currency, f.usd_per_unit, f.effective_date
      from public.fx_rates f
      where f.deleted_at is null
        and f.effective_date <= v_today
      order by f.currency, f.effective_date desc, f.updated_at desc
    ),
    comp as (
      select
        c.id,
        s.project_id,
        c.project_staff_id,
        s.person_id,
        pe.name_ar as person_name_ar,
        pe.name_latin as person_name_latin,
        s.role,
        c.monthly_amount,
        c.currency::text as currency,
        c.effective_from,
        c.version,
        c.updated_at,
        case when c.currency = 'USD' then 1::numeric else r.usd_per_unit end as usd_per_unit,
        case when c.currency = 'USD' then null else r.effective_date end as fx_date,
        (s.end_date is null or s.end_date >= v_today) as staff_active,
        row_number() over (
          partition by c.project_staff_id, (c.effective_from <= v_today)
          order by c.effective_from desc, c.updated_at desc, c.id desc) as rn
      from public.staff_compensation c
      join public.project_staff s on s.id = c.project_staff_id
      left join public.persons pe on pe.id = s.person_id
      left join rates r on r.currency = c.currency
      where s.project_id = any (v_projects)
        and c.deleted_at is null
        and s.deleted_at is null
    ),
    priced as (
      select comp.*,
             -- the salary in force today for an assignment that has not ended
             (comp.staff_active and comp.effective_from <= v_today and comp.rn = 1) as is_current,
             round(comp.monthly_amount * comp.usd_per_unit, 2) as usd_amount
      from comp
    ),
    by_currency as (
      -- per-currency totals of current salaries; currencies are never mixed
      select p.currency,
             count(*) as staff_count,
             sum(p.monthly_amount) as monthly_amount,
             sum(p.usd_amount) as usd_amount,
             bool_or(p.usd_amount is null) as missing_rate
      from priced p
      where p.is_current
      group by p.currency
    )
    select
      coalesce((
        select jsonb_agg(
                 jsonb_build_object(
                   'id', p.id,
                   'project_id', p.project_id,
                   'project_staff_id', p.project_staff_id,
                   'person_id', p.person_id,
                   'person_name_ar', p.person_name_ar,
                   'person_name_latin', p.person_name_latin,
                   'role', p.role,
                   'monthly_amount', p.monthly_amount,
                   'currency', p.currency,
                   'effective_from', p.effective_from,
                   'is_current', p.is_current,
                   'usd_per_unit', p.usd_per_unit,
                   'fx_date', p.fx_date,
                   'usd_amount', p.usd_amount,
                   'version', p.version,
                   'updated_at', p.updated_at)
                 order by p.project_id, p.project_staff_id, p.effective_from desc, p.id)
        from priced p), '[]'::jsonb),
      coalesce((select array_agg(p.id) from priced p), '{}'::uuid[]),
      jsonb_build_object(
        'by_currency', coalesce((
          select jsonb_agg(
                   jsonb_build_object(
                     'currency', b.currency,
                     'staff_count', b.staff_count,
                     'monthly_amount', b.monthly_amount,
                     'usd_amount', case when b.missing_rate then null else b.usd_amount end)
                   order by b.currency)
          from by_currency b), '[]'::jsonb),
        -- USD total only over currencies that have a rate; "usd_complete" says
        -- whether that covers everything.
        'usd_total', coalesce((select sum(b.usd_amount) from by_currency b where not b.missing_rate), 0),
        'usd_complete', not exists (select 1 from by_currency b where b.missing_rate),
        'missing_rates', coalesce((
          select jsonb_agg(b.currency order by b.currency) from by_currency b where b.missing_rate),
          '[]'::jsonb))
    into v_rows, v_ids, v_totals;

    v_result := jsonb_build_object(
      'table', p_table,
      'as_of', v_today,
      'project_ids', to_jsonb(v_projects),
      'rows', v_rows,
      'totals', v_totals);

  else  -- community_sensitive
    select
      coalesce(jsonb_agg(
        jsonb_build_object(
          'id', cs.id,
          'project_id', cs.project_id,
          'ibadi_families', cs.ibadi_families,
          'omani_families', cs.omani_families,
          'omani_student_pct', cs.omani_student_pct,
          'ibadi_student_pct', cs.ibadi_student_pct,
          'omani_teacher_pct', cs.omani_teacher_pct,
          'ibadi_teacher_pct', cs.ibadi_teacher_pct,
          'guest_financial_capacity', cs.guest_financial_capacity,
          'version', cs.version,
          'updated_at', cs.updated_at)
        order by cs.project_id, cs.id), '[]'::jsonb),
      coalesce(array_agg(cs.id), '{}'::uuid[])
    into v_rows, v_ids
    from public.community_sensitive cs
    where cs.project_id = any (v_projects)
      and cs.deleted_at is null;

    v_result := jsonb_build_object(
      'table', p_table,
      'as_of', v_today,
      'project_ids', to_jsonb(v_projects),
      'rows', v_rows);
  end if;

  -- One access-log entry per call, also when nothing was returned.
  perform private.log_restricted(
    p_table,
    v_ids,
    format('restricted_read requested=%s allowed=%s', cardinality(v_requested), cardinality(v_projects)));

  return v_result;
end;
$$;

comment on function public.restricted_read(text, uuid[]) is
  'Logged read of staff_compensation or community_sensitive for up to 200 projects; only countries where the caller is country_manager (or hq_admin). Salaries include a USD equivalent; totals are per currency.';

revoke execute on function public.restricted_read(text, uuid[]) from public, anon;
grant  execute on function public.restricted_read(text, uuid[]) to authenticated, service_role;

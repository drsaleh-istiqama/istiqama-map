-- =============================================================================
-- 0075  Restricted-data leak fixes (brief §3, §11; acceptance criterion 5)
--       (contracts: authz.md §1, people-admin.md §merge undo, sync.md §4.4)
--
-- An adversarial review of every path by which a caller without restricted
-- access (collector, supervisor, viewer, aal1 manager, manager of another
-- country) could learn a stored salary / sensitive community value or its
-- existence, and of every path that reads restricted data without a
-- restricted_access_log row. Four defects, each proven by an executed repro
-- (regression assertions: supabase/tests/55_restricted_leaks.test.sql):
--
--   1. sync_status() counted open conflicts on the restricted tables for every
--      listed user. Blind writes (sync.md §4.4) store a conflict exactly when the
--      written value differs from the stored one, so the count was an equality
--      oracle on salaries: a country manager of KE who also collects in a TZ
--      branch pushed a TZ salary blind and read his own open_conflicts (0 =
--      "the stored salary is this value", 1 = "it is not"). Conflicts on
--      restricted tables are now counted only when the caller may see the
--      restricted data of the conflict's country (hq_admin, or country manager
--      of that country at aal2).
--
--   2. audit_log rows of public.sync_conflicts carry the full conflict image,
--      including server_value / client_value of conflicts on restricted tables
--      (the stored and the proposed salary). The policy audit_log_select_hq
--      hid the audit rows of the restricted tables themselves but not these, so
--      hq_admin could read restricted values with direct SQL and no
--      restricted_access_log row (log evasion). They are now hidden like the
--      restricted tables' own audit rows.
--
--   3. merge_persons() wrote the ids of the salary rows it moved into
--      person_merge_requests.undo (collapsed_staff[].moved_compensation). That
--      column is readable (RLS + sync_pull) by every reviewer of the persons,
--      i.e. by branch supervisors without restricted access: the list told
--      whether the duplicate assignment had a salary, whether the kept
--      assignment had none, and the restricted row ids. The ids now live in
--      private.person_merge_comp_moves (no API access); a BEFORE trigger strips
--      them from undo whatever writes it, and an AFTER trigger moves the salary
--      rows back when the merge is reverted (revert_person_merge is unchanged).
--      Existing undo rows are scrubbed by this migration.
--
--   4. The managed-currency trigger of staff_compensation (0072) skipped
--      soft-deleted rows, hence the soft-deleted probe row of a blind write
--      (private.sync_probe_insert): currency 'XXX' was refused when no salary
--      row existed for the natural key and answered "applied" when one existed
--      — an existence oracle for collectors. Inserts are now always checked.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 2. audit_log: conflict images about restricted tables are restricted data
-- -----------------------------------------------------------------------------
drop policy if exists audit_log_select_hq on public.audit_log;
create policy audit_log_select_hq on public.audit_log
  for select to authenticated
  using (
    (select private.is_hq())
    and table_name not in ('staff_compensation', 'community_sensitive')
    -- the audit image of a sync_conflicts row about a restricted table holds the
    -- stored and the proposed restricted value (server_value / client_value)
    and not (
      table_name = 'sync_conflicts'
      and coalesce(new_data ->> 'table_name', old_data ->> 'table_name')
          in ('staff_compensation', 'community_sensitive')
    )
  );

-- -----------------------------------------------------------------------------
-- 1. sync_status: restricted conflicts only for callers who may see them
--    (unchanged from migration 0045 except the conf CTE and its two variables)
-- -----------------------------------------------------------------------------
create or replace function public.sync_status()
returns jsonb
language plpgsql
volatile            -- because of private.rate_limit(); the function itself only reads
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  c_stale constant interval := interval '7 days';
  v_scope  record;
  v_now    timestamptz := now();
  v_since  timestamptz := now() - interval '7 days';
  v_r_all  boolean;
  v_r_c    uuid[];
  v_result jsonb;
begin
  v_scope := private.admin_scope(true);
  perform private.rate_limit('admin_read', 120, interval '1 minute');

  -- A conflict on a restricted table exists exactly when a blind write differed
  -- from the stored value (sync.md §4.4): counting it is restricted data.
  v_r_all := coalesce(private.restricted_all(), false);
  v_r_c   := coalesce(private.restricted_countries(), '{}'::uuid[]);

  with u as materialized (
    select p.id, p.full_name, p.active
    from public.profiles p
    where p.deleted_at is null
      and (v_scope.is_hq or private.admin_user_in_countries(p.id, v_scope.countries))
  ),
  conf as materialized (
    select sc.client_user_id as user_id, coalesce(sc.client_device_id, '') as device_id, count(*) as n
    from public.sync_conflicts sc
    where sc.state = 'open'
      and sc.deleted_at is null
      and sc.client_user_id is not null
      and (sc.table_name not in ('staff_compensation', 'community_sensitive')
           or v_r_all
           or exists (select 1 from public.projects rp
                      where rp.id = sc.project_id and rp.country_id = any (v_r_c)))
    group by 1, 2
  ),
  rej as materialized (
    select o.user_id, coalesce(o.device_id, '') as device_id, count(*) as n
    from private.sync_rejections o
    where o.rejected_at >= v_since
    group by 1, 2
  ),
  dev as materialized (
    select
      d.user_id, d.id, d.device_id, d.label, d.user_agent, d.app_version,
      d.last_seen_at, d.last_push_at, d.last_pull_at, d.pending_ops, d.pending_photos, d.revoked_at,
      coalesce(c.n, 0) as open_conflicts,
      coalesce(r.n, 0) as rejected_7d,
      (d.revoked_at is null and (d.last_seen_at is null or d.last_seen_at < v_now - c_stale)) as stale
    from public.devices d
    join u on u.id = d.user_id
    left join conf c on c.user_id = d.user_id and c.device_id = d.device_id
    left join rej r on r.user_id = d.user_id and r.device_id = d.device_id
    where d.deleted_at is null
  ),
  per_user as (
    select
      u.id,
      u.full_name,
      u.active,
      private.norm(coalesce(u.full_name, '')) as sort_name,
      coalesce((select sum(c.n) from conf c where c.user_id = u.id), 0) as open_conflicts,
      coalesce((select sum(r.n) from rej r where r.user_id = u.id), 0) as rejected_7d,
      coalesce(dv.device_count, 0) as device_count,
      coalesce(dv.pending_ops, 0) as pending_ops,
      coalesce(dv.pending_photos, 0) as pending_photos,
      coalesce(dv.stale_devices, 0) as stale_devices,
      dv.last_seen_at,
      dv.last_push_at,
      dv.last_pull_at,
      coalesce(dv.devices, '[]'::jsonb) as devices,
      coalesce(ro.roles, '[]'::jsonb) as roles
    from u
    left join lateral (
      select
        count(*) as device_count,
        sum(d.pending_ops) filter (where d.revoked_at is null) as pending_ops,
        sum(d.pending_photos) filter (where d.revoked_at is null) as pending_photos,
        count(*) filter (where d.stale) as stale_devices,
        max(d.last_seen_at) as last_seen_at,
        max(d.last_push_at) as last_push_at,
        max(d.last_pull_at) as last_pull_at,
        jsonb_agg(
          jsonb_build_object(
            'id', d.id,
            'device_id', d.device_id,
            'label', d.label,
            'user_agent', d.user_agent,
            'app_version', d.app_version,
            'last_seen_at', d.last_seen_at,
            'last_push_at', d.last_push_at,
            'last_pull_at', d.last_pull_at,
            'pending_ops', d.pending_ops,
            'pending_photos', d.pending_photos,
            'open_conflicts', d.open_conflicts,
            'rejected_7d', d.rejected_7d,
            'stale', d.stale,
            'revoked_at', d.revoked_at)
          order by d.last_seen_at desc nulls last, d.device_id) as devices
      from dev d
      where d.user_id = u.id
    ) dv on true
    left join lateral (
      select jsonb_agg(
               jsonb_build_object('role', ur.role, 'scope_type', ur.scope_type, 'scope_id', ur.scope_id)
               order by ur.role, ur.scope_type, ur.scope_id) as roles
      from public.user_roles ur
      where ur.user_id = u.id
        and ur.deleted_at is null
    ) ro on true
  )
  select jsonb_build_object(
    'generated_at', clock_timestamp(),
    'scope', case when v_scope.is_hq then 'all' else 'country' end,
    'country_ids', case when v_scope.is_hq then null else to_jsonb(v_scope.countries) end,
    'window_days', 7,
    'summary', jsonb_build_object(
      'users', count(*),
      'users_without_device', count(*) filter (where pu.device_count = 0),
      'devices', coalesce(sum(pu.device_count), 0),
      'stale_devices', coalesce(sum(pu.stale_devices), 0),
      'pending_ops', coalesce(sum(pu.pending_ops), 0),
      'pending_photos', coalesce(sum(pu.pending_photos), 0),
      'open_conflicts', coalesce(sum(pu.open_conflicts), 0),
      'rejected_7d', coalesce(sum(pu.rejected_7d), 0)),
    'users', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'user_id', pu.id,
          'full_name', pu.full_name,
          'active', pu.active,
          'roles', pu.roles,
          'device_count', pu.device_count,
          'pending_ops', pu.pending_ops,
          'pending_photos', pu.pending_photos,
          'open_conflicts', pu.open_conflicts,
          'rejected_7d', pu.rejected_7d,
          'last_seen_at', pu.last_seen_at,
          'last_push_at', pu.last_push_at,
          'last_pull_at', pu.last_pull_at,
          'devices', pu.devices)
        -- users that need attention first, then by name
        order by (pu.open_conflicts + pu.rejected_7d) desc, pu.pending_ops desc, pu.sort_name, pu.id),
      '[]'::jsonb))
  into v_result
  from per_user pu;

  return v_result;
end;
$$;

comment on function public.sync_status() is
  'Sync status board: per user and device last seen/push/pull, pending operations and photos, app version, open conflicts and operations rejected in the last 7 days. hq_admin: all users; country_manager: users of the own country. Conflicts on restricted tables count only where the caller has restricted access (migration 0075).';

revoke execute on function public.sync_status() from public, anon;
grant execute on function public.sync_status() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Person merge: salary row ids out of the readable undo trail
-- -----------------------------------------------------------------------------
create table if not exists private.person_merge_comp_moves (
  request_id  uuid        not null,
  staff_id    uuid        not null,     -- the collapsed (soft-deleted) source assignment
  kept_id     uuid        not null,     -- the target's assignment that received the salary rows
  comp_ids    uuid[]      not null,
  created_at  timestamptz not null default now(),
  reverted_at timestamptz,
  primary key (request_id, staff_id)
);

comment on table private.person_merge_comp_moves is
  'Salary rows (staff_compensation ids) that merge_persons() moved from a collapsed assignment to the kept one. Restricted data: kept out of person_merge_requests.undo, which every reviewer can read (migration 0075).';

-- BEFORE INSERT/UPDATE OF undo: move collapsed_staff[].moved_compensation into the
-- private table and strip the key. Only merge_persons_apply / revert_person_merge
-- write undo (no API privilege, not a sync-writable column).
create or replace function private.tg_person_merge_comp_strip()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  e         jsonb;
  v_list    jsonb := '[]'::jsonb;
  v_changed boolean := false;
begin
  if new.undo is null or jsonb_typeof(new.undo -> 'collapsed_staff') is distinct from 'array' then
    return new;
  end if;

  for e in select x from jsonb_array_elements(new.undo -> 'collapsed_staff') x loop
    if jsonb_typeof(e) = 'object' and e ? 'moved_compensation' then
      v_changed := true;
      if jsonb_typeof(e -> 'moved_compensation') = 'array'
         and jsonb_array_length(e -> 'moved_compensation') > 0
         and (e ->> 'id') is not null and (e ->> 'kept_id') is not null then
        insert into private.person_merge_comp_moves (request_id, staff_id, kept_id, comp_ids)
        values (new.id, (e ->> 'id')::uuid, (e ->> 'kept_id')::uuid,
                array(select x::uuid from jsonb_array_elements_text(e -> 'moved_compensation') x))
        on conflict (request_id, staff_id) do update
          set kept_id = excluded.kept_id, comp_ids = excluded.comp_ids, reverted_at = null;
      end if;
      e := e - 'moved_compensation';
    end if;
    v_list := v_list || jsonb_build_array(e);
  end loop;

  if v_changed then
    new.undo := jsonb_set(new.undo, '{collapsed_staff}', v_list);
  end if;
  return new;
end;
$$;

-- AFTER UPDATE merged -> reverted: the salary rows go back to the restored
-- assignment (what revert_person_merge did itself with the old undo shape).
-- Rows that were moved elsewhere since the merge are left alone.
create or replace function private.tg_person_merge_comp_revert()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
as $$
begin
  update public.staff_compensation c
  set project_staff_id = m.staff_id
  from private.person_merge_comp_moves m
  where m.request_id = new.id
    and m.reverted_at is null
    and c.id = any (m.comp_ids)
    and c.project_staff_id = m.kept_id;

  update private.person_merge_comp_moves m
  set reverted_at = now()
  where m.request_id = new.id and m.reverted_at is null;
  return null;
end;
$$;

drop trigger if exists t20_merge_comp_strip on public.person_merge_requests;
create trigger t20_merge_comp_strip
  before insert or update of undo on public.person_merge_requests
  for each row execute function private.tg_person_merge_comp_strip();

drop trigger if exists t80_merge_comp_revert on public.person_merge_requests;
create trigger t80_merge_comp_revert
  after update of state on public.person_merge_requests
  for each row
  when (old.state = 'merged' and new.state = 'reverted')
  execute function private.tg_person_merge_comp_revert();

revoke execute on function private.tg_person_merge_comp_strip() from public, anon, authenticated;
revoke execute on function private.tg_person_merge_comp_revert() from public, anon, authenticated;

-- Scrub the undo trails written before this migration (the trigger does the work).
update public.person_merge_requests q
set undo = q.undo
where jsonb_typeof(q.undo -> 'collapsed_staff') = 'array'
  and exists (select 1 from jsonb_array_elements(q.undo -> 'collapsed_staff') e
              where jsonb_typeof(e) = 'object' and e ? 'moved_compensation');

-- -----------------------------------------------------------------------------
-- 4. The managed-currency guard checks every INSERT, live or soft-deleted
-- -----------------------------------------------------------------------------
-- A blind write that lands on an existing row is validated by
-- private.sync_probe_insert, which inserts a SOFT-DELETED probe row (the
-- natural-key unique index covers live rows only). The trigger of migration
-- 0072 ran only "when (new.deleted_at is null)", so the probe skipped it: a
-- collector pushing currency 'XXX' got check_violation when no salary row
-- existed for the key, and the constant "applied" when one existed (the value
-- then waited as a conflict) — an existence oracle. Inserts are now always
-- checked; updates keep the 0072 rule (a soft-deleted row is not re-checked).
drop trigger if exists staff_compensation_currency_tg on public.staff_compensation;
create trigger staff_compensation_currency_tg
  before update of currency on public.staff_compensation
  for each row
  when (new.deleted_at is null)
  execute function private.staff_compensation_currency_guard();

drop trigger if exists staff_compensation_currency_ins_tg on public.staff_compensation;
create trigger staff_compensation_currency_ins_tg
  before insert on public.staff_compensation
  for each row
  execute function private.staff_compensation_currency_guard();

-- -----------------------------------------------------------------------------
select private.harden_private_schema();

create or replace function private.schema_version()
returns text
language sql
immutable
parallel safe
set search_path = public, extensions, private, pg_temp
as $$
  select '20261003007500'::text;
$$;

revoke execute on function private.schema_version() from public, anon, authenticated;

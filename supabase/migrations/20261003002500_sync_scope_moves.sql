-- =============================================================================
-- 0025  Scope moves and sync housekeeping
--       (docs/ARCHITECTURE.md §3.2; contract: docs/contracts/sync.md)
--
-- A partial (scoped) sync has two blind spots when the scope columns of a row
-- change (a project is reassigned to another branch, its point is corrected
-- across a border, a person is moved to another branch):
--
--   1. Users of the NEW scope receive the row itself (it changed), but not its
--      children: their sync_xid is old, so no pull round would return them.
--      -> the children of a re-scoped project are re-stamped (sync_xid only,
--         no data change), so they travel with the project.
--
--   2. Users of the OLD scope never hear about the row again and would keep a
--      stale copy for ever.
--      -> the move is recorded in private.sync_scope_moves and sync_pull adds
--         "gone": [ids] to the table's entry for callers who could see the row
--         before the move and cannot see it now.
--
-- Also here: private.sync_prune() (ledger and move-log retention).
-- =============================================================================

create table private.sync_scope_moves (
  id             bigint generated always as identity primary key,
  table_name     text        not null,
  row_id         uuid        not null,
  old_country_id uuid,
  old_branch_id  uuid,
  sync_xid       bigint      not null,
  moved_at       timestamptz not null default now()
);

create index sync_scope_moves_sync_idx on private.sync_scope_moves (table_name, sync_xid);

comment on table private.sync_scope_moves is
  'One row per change of country_id/branch_id of a row-scoped syncable row; feeds the "gone" lists of sync_pull.';

alter table private.sync_scope_moves enable row level security;
revoke all on table private.sync_scope_moves from public, anon, authenticated;

create or replace function private.tg_sync_scope_move()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  r     record;
  v_xid bigint := private.current_xid();
begin
  insert into private.sync_scope_moves (table_name, row_id, old_country_id, old_branch_id, sync_xid)
  values (tg_table_name, old.id, old.country_id, old.branch_id, v_xid);

  if tg_table_name = 'projects' then
    -- Re-stamp the children so that they reach the users of the new scope.
    -- Only sync_xid (and the bookkeeping columns of the std trigger) change;
    -- the audit trigger does not log such an update.
    for r in
      select s.table_name, s.scope_kind, s.scope_col
      from private.sync_tables s
      where s.scope_kind in ('project', 'staff')
      order by s.pull_order
    loop
      if r.scope_kind = 'project' then
        execute format('update public.%I t set sync_xid = $2 where t.%I = $1', r.table_name, r.scope_col)
          using new.id, v_xid;
      else
        execute format(
          'update public.%I t set sync_xid = $2 where t.%I in (select s.id from public.project_staff s where s.project_id = $1)',
          r.table_name, r.scope_col)
          using new.id, v_xid;
      end if;
    end loop;
  end if;

  return null;
end;
$$;

comment on function private.tg_sync_scope_move() is
  'AFTER UPDATE trigger on row-scoped syncable tables: logs a change of country_id/branch_id and re-stamps the children of a re-scoped project.';

create trigger t85_sync_scope_move after update on public.projects
  for each row
  when (old.country_id is distinct from new.country_id or old.branch_id is distinct from new.branch_id)
  execute function private.tg_sync_scope_move();

create trigger t85_sync_scope_move after update on public.persons
  for each row
  when (old.country_id is distinct from new.country_id or old.branch_id is distinct from new.branch_id)
  execute function private.tg_sync_scope_move();

-- -----------------------------------------------------------------------------
-- Ids of rows of p_table that left the caller's scope inside the round window.
-- Called by sync_pull once per round and row-scoped table, with the caller's
-- scope arrays and the scope predicate (alias t) it already built.
-- -----------------------------------------------------------------------------
create or replace function private.sync_gone(
  p_table text, p_lo bigint, p_hi bigint, p_countries uuid[], p_branches uuid[], p_pred text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v jsonb;
begin
  execute format(
    'select jsonb_agg(distinct m.row_id)'
    || ' from private.sync_scope_moves m'
    || ' where m.table_name = $1 and m.sync_xid >= $2 and m.sync_xid < $3'
    || '   and (m.old_country_id = any ($4) or m.old_branch_id = any ($5))'
    || '   and not exists (select 1 from public.%I t where t.id = m.row_id and %s)',
    p_table,
    -- the predicate was built for the EXECUTE of sync_pull ($6 = countries, $7 = branches)
    replace(replace(p_pred, '$6', '$4'), '$7', '$5'))
    into v
    using p_table, p_lo, p_hi, coalesce(p_countries, '{}'::uuid[]), coalesce(p_branches, '{}'::uuid[]);
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- Housekeeping (schedule daily; see docs/contracts/sync.md):
--   * sync_applied_ops older than p_ledger_keep — must stay longer than a device
--     may sit on an unacknowledged batch (default 180 days)
--   * sync_scope_moves older than p_moves_keep — a device that was offline for
--     longer keeps stale copies of re-scoped rows until its next full resync
-- Run it without an end-user JWT (cron / service role): the hard-delete guard
-- of the ledger refuses deletes on behalf of end users.
-- -----------------------------------------------------------------------------
create or replace function private.sync_prune(
  p_ledger_keep interval default interval '180 days',
  p_moves_keep  interval default interval '180 days')
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, private, pg_temp
as $$
declare
  v_ops   bigint;
  v_moves bigint;
begin
  delete from public.sync_applied_ops o
  where o.applied_at < now() - greatest(p_ledger_keep, interval '30 days');
  get diagnostics v_ops = row_count;

  delete from private.sync_scope_moves m
  where m.moved_at < now() - greatest(p_moves_keep, interval '30 days');
  get diagnostics v_moves = row_count;

  return jsonb_build_object('applied_ops', v_ops, 'scope_moves', v_moves);
end;
$$;

comment on function private.sync_prune(interval, interval) is
  'Retention for the sync ledger (sync_applied_ops) and the scope-move log. Minimum 30 days each.';

revoke execute on function
  private.tg_sync_scope_move(),
  private.sync_gone(text, bigint, bigint, uuid[], uuid[], text),
  private.sync_prune(interval, interval)
from public, anon, authenticated;

grant execute on function private.sync_prune(interval, interval) to service_role;
